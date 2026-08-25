import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadAgentDefaults } from "../../src/agents/definitions.ts";
import { candidateWorktreeBranchName } from "../../src/vf/worktrees.ts";
import { adoptVerifiedRuns } from "../../src/vf/run/adopt.ts";
import {
	cancelVerifiedRun,
	listVerifiedRuns,
	respawnVerifiedSupervisor,
	waitForVerifiedRunResult,
} from "../../src/vf/run/client.ts";
import { launchVerifiedFanOut, VerifiedLaunchError, verifiedRunsBaseDir } from "../../src/vf/run/launch.ts";
import { resolveSubagentCwd } from "../../src/launch/runtime-paths.ts";
import { getPackagedCriteriaDir } from "../../src/vf/criteria.ts";
import {
	acquireVerifiedRunDeliveryLease,
	readVerifiedRunManifest,
	verifiedRunFilePaths,
	verifiedRunResultGeneration,
	writeVerifiedRunDeliveryReceipt,
	writeVerifiedRunManifest,
} from "../../src/vf/run/types.ts";
import { resolveAuthorizedRecipients } from "../../src/vf/run/launch.ts";
import { getLiveSlotCount, initializeSpawnWidthForSession, resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import { resetSubagentStateForTest, runningSubagents, stopRunningSubagent } from "../../src/runtime/wiring.ts";
import { moduleAbortController } from "../../src/runtime/state.ts";
import { assert, createTestDir, sleep } from "../support/index.ts";
import {
	buildSupervisedRun,
	gitRun as run,
	setupVerifiedRunFixture as setupFixture,
	waitForVerifiedRunState as waitForState,
} from "../support/verified-runs.ts";

/**
 * Ticket 07 — VerifiedRun orchestration as one logical child.
 *
 * These are live-process tests: every run spawns a REAL detached supervisor
 * (verified-main.ts) which creates REAL git worktrees and spawns REAL
 * candidate processes (a fake pi that writes real session JSONL). Selection
 * runs the REAL ticket-05 bridge tournament against the in-process mock
 * backend, so no live verifier API key is needed.
 */

const RUN_TIMEOUT = 120_000;

let fixtureRoot = "";

function loadVfAgent(repo: string) {
	return loadAgentDefaults("vf-worker", undefined, repo, resolveSubagentCwd);
}

afterEach(() => {
	resetSubagentStateForTest();
	resetSpawnWidthForTest();
	if (fixtureRoot) {
		rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = "";
	}
});

describe("verified fan-out supervisor (live processes)", () => {
	it("spawns N candidates, ranks traces, and records the winner", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir, runId } = buildSupervisedRun(
			repo,
			fakePi,
			captureDir,
			[
				{ marker: "VF-GOOD", change: "good change" },
				{ marker: "VF-MID", change: "mid change" },
				{ marker: "", change: "plain change" },
			],
		);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "completed", manifest.result?.failure?.message);
		assert.equal(manifest.result?.ok, true);
		assert.equal(manifest.result?.selection?.winnerIndex, 1);
		assert.equal(manifest.result?.selection?.ranking[0], 1);
		assert.equal(manifest.result?.selection?.distinctCandidates, 3);
		assert.match(manifest.result?.selection?.winnerReport ?? "", /Final report for VF-GOOD/);
		assert.match(manifest.result?.selection?.winnerTrace ?? "", /Final report for VF-GOOD/);
		// One spawn per candidate, no respawns.
		assert.equal(readdirSync(captureDir).length, 3);
		// Traces and ranking artifacts exist; ticket 08 applies the winner and
		// removes the worktree directories while the branches stay for audit.
		const paths = verifiedRunFilePaths(runDir);
		assert.equal(existsSync(paths.ranking), true);
		assert.equal(manifest.result?.artifacts.traces.length, 3);
		assert.equal(manifest.result?.apply?.applied, true, "winner applied by the live supervisor");
		assert.equal(existsSync(manifest.request.candidates[0].worktree), false, "worktree removed after apply");
		assert.equal(
			run(repo, "show-ref", "--verify", `refs/heads/${candidateWorktreeBranchName(runId, 1)}`).length > 0,
			true,
			"winner snapshot branch retained",
		);
		// The winner's change is staged in the source repo (cherry-pick --no-commit).
		assert.equal(run(repo, "status", "--porcelain"), "A  change.txt");
	});

	it("fails the whole run when fewer than two distinct candidates completed", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", exitCode: 1, change: "mid change" },
		]);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.ok, false);
		assert.equal(manifest.result?.selection, null);
		assert.equal(manifest.result?.failure?.code, "insufficient-distinct-candidates");
		// Nothing applied: the source tree stays at base.
		assert.equal(run(repo, "status", "--porcelain"), "");
	});

	it("collapses identical candidates (tree + report) and fails on a single distinct outcome", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "identical" },
			{ marker: "VF-GOOD", change: "identical" },
		]);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.failure?.code, "insufficient-distinct-candidates");
	});

	it("fails closed before spend when the source base drifted", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(
			repo,
			fakePi,
			captureDir,
			[
				{ marker: "VF-GOOD", change: "a" },
				{ marker: "VF-MID", change: "b" },
			],
			{ baseCommit: "0123456789012345678901234567890123456789" },
		);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.failure?.code, "base-drift");
		// No worktrees were created and no candidate ever spawned.
		const siblings = readdirSync(parent).filter((name) => name.includes("-vf-"));
		assert.deepEqual(siblings, []);
		assert.deepEqual(readdirSync(captureDir), []);
	});

	it("cancels a live run: candidates killed, state cancelled, nothing applied", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 30_000, change: "a" },
			{ marker: "VF-MID", beforeMs: 30_000, change: "b" },
		]);
		await waitForState(runDir, "running");
		const outcome = await cancelVerifiedRun(runDir, { timeoutMs: 20_000 });
		assert.equal(outcome.outcome, "cancelled");
		assert.equal(outcome.manifest.state, "cancelled");
		for (const candidate of outcome.manifest.candidates) {
			assert.equal(candidate.settled, true);
		}
		assert.equal(run(repo, "status", "--porcelain"), "");
	});

	it("adopts still-running candidates after a supervisor crash (no respawn, no double spend)", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 4_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 4_000, change: "mid change" },
		]);
		const running = await waitForState(runDir, "running");
		const supervisorPid = running.lease?.pid;
		assert.ok(supervisorPid, "supervisor lease recorded");
		process.kill(supervisorPid, "SIGKILL");
		await sleep(400);
		respawnVerifiedSupervisor(runDir);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "completed", manifest.result?.failure?.message);
		assert.equal(manifest.result?.selection?.winnerIndex, 1);
		// The replacement adopted the ORIGINAL candidates: exactly one spawn
		// each, never a re-spawn.
		assert.equal(readdirSync(captureDir).length, 2);
	});
});

describe("verified fan-out orchestrator (one logical child)", () => {
	function setupProject(agentFrontmatter: string): { repo: string; parent: string; fakePi: string; captureDir: string; ctx: unknown } {
		const { repo, parent, fakePi, captureDir } = setupFixture();
		fixtureRoot = parent;
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		writeFileSync(join(repo, ".pi", "agents", "vf-worker.md"), `---\n${agentFrontmatter}---\nAgent body.\n`);
		// The verifier model is an explicit pre-runtime choice: a default
		// profile with its own single door family, deterministic in tests.
		mkdirSync(join(repo, ".pi", "agents", "verifiers"), { recursive: true });
		writeFileSync(
			join(repo, ".pi", "agents", "verifiers", "default.md"),
			"---\nmodel: deepseek/deepseek-v4-flash\nenv: |\n  DEEPSEEK_API_KEY=test-verifier-key\n---\n",
		);
		// The agent definition must be part of the clean base: an untracked
		// .pi/ would (correctly) fail the dirty-tree gate.
		run(repo, "add", "-A");
		run(repo, "commit", "-q", "-m", "agent definition");
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
		process.env.PI_SUBAGENT_VF_MOCK_VERIFIER = JSON.stringify({ goodMarker: "VF-GOOD", midMarker: "VF-MID" });
		process.env.TEST_CAPTURE_DIR = captureDir;
		process.env.TEST_MARKER_MAP = JSON.stringify({ "1": "VF-GOOD", "2": "VF-MID", "3": "" });
		const ctx = {
			cwd: repo,
			sessionManager: {
				getSessionFile: () => join(parent, "parent-session.jsonl"),
				getSessionId: () => "parent-session",
				getLeafId: () => null,
			},
		};
		return { repo, parent, fakePi, captureDir, ctx };
	}

	it("returns one logical child with byte-identical candidate prompts and a single outcome", async () => {
		// task-expansion: shell must expand ONCE in the source tree and freeze;
		// a per-candidate re-expansion would produce a different prompt each
		// time and trip the prompt-drift guard.
		const { repo, parent, ctx } = setupProject(
			"description: vf test agent\nllm-as-a-verifier: true\ntask-expansion: shell\n",
		);
		const agentDefs = loadVfAgent(repo);
		assert.equal(agentDefs?.llmAsVerifier, true);
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { running, runDir, runId } = await launchVerifiedFanOut(
			{ name: "vf-run", title: "VF run", task: "do the thing now !`date +%s%N`", agent: "vf-worker" },
			agentDefs!,
			ctx as never,
		);
		assert.equal(runningSubagents.size, 1, "exactly one logical child registered");
		assert.equal(running.verifiedRunDir, runDir);
		const manifest = readVerifiedRunManifest(runDir);
		assert.equal(manifest.request.candidates.length, 3);
		const taskArgs = manifest.request.candidates.map((candidate) =>
			candidate.args.find((arg) => arg.startsWith("@")),
		);
		assert.deepEqual(taskArgs, [taskArgs[0], taskArgs[0], taskArgs[0]], "byte-identical task artifact arg");
		assert.equal(existsSync(taskArgs[0]!.slice(1)), true, "frozen task artifact exists once");
		const sessionArgs = manifest.request.candidates.map(
			(candidate) => candidate.args[candidate.args.indexOf("--session") + 1],
		);
		assert.equal(new Set(sessionArgs).size, 3, "per-candidate durable sessions");
		// Candidate env is spawn-denied (normalization) and per-candidate isolated.
		for (const candidate of manifest.request.candidates) {
			assert.equal(candidate.env.PI_SUBAGENT_SPAWN_BUDGET, "0");
			assert.match(candidate.env.PI_DENY_TOOLS ?? "", /subagent/);
		}
		assert.equal(getLiveSlotCount(), 3, "N candidates hold N spawn slots");
		const result = await running.completionPromise!;
		assert.equal(result.exitCode, 0);
		assert.match(result.summary, /Final report for VF-GOOD/);
		assert.match(result.summary, new RegExp(runId));
		assert.equal(getLiveSlotCount(), 0, "all N slots released at completion");
		const finalManifest = readVerifiedRunManifest(runDir);
		assert.equal(finalManifest.state, "completed");
		assert.ok(result.deliveryId, "origin delivery carries a lease deliveryId");
		assert.equal(result.deliveryId, `${runId}-g1`);
		// Simulate Pi persisting the steer into the origin session file; the
		// live watcher then converts the lease into a durable receipt.
		writeFileSync(join(parent, "parent-session.jsonl"), `{"deliveryId":"${result.deliveryId}"}\n`);
		let receiptSeen = false;
		for (let i = 0; i < 60 && !receiptSeen; i += 1) {
			await sleep(150);
			receiptSeen = existsSync(verifiedRunFilePaths(runDir).deliveryReceipt);
		}
		assert.equal(receiptSeen, true, "receipt written after the deliveryId persisted in the origin session");
		assert.equal(existsSync(verifiedRunFilePaths(runDir).deliveryClaim), false, "the live path no longer writes bare claims");
		// Apply gate: worktrees removed, branch retained; the winner tree here
		// equals the base (candidates wrote no change), so nothing is staged.
		assert.equal(existsSync(finalManifest.result?.selection?.winnerWorktree ?? ""), false);
		assert.equal(
			run(repo, "show-ref", "--verify", `refs/heads/${candidateWorktreeBranchName(runId, 1)}`).length > 0,
			true,
			"winner snapshot branch retained",
		);
		assert.equal(run(repo, "status", "--porcelain"), "");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("reserves all N slots atomically and fails closed before worktrees when width is short", async () => {
		const { parent, ctx } = setupProject(
			"description: vf test agent\nllm-as-a-verifier: true\nllm-as-a-verifier-candidates: 3\n",
		);
		const agentDefs = loadVfAgent((ctx as { cwd: string }).cwd);
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		initializeSpawnWidthForSession({ PI_SUBAGENT_SPAWN_WIDTH: "2" });
		await assert.rejects(
			launchVerifiedFanOut(
				{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
				agentDefs!,
				ctx as never,
			),
			(error: VerifiedLaunchError) => {
				assert.equal(error.code, "spawn_width");
				return true;
			},
		);
		assert.deepEqual(listVerifiedRuns(artifactRoot), [], "no run was started");
		const siblings = readdirSync(parent).filter((name) => name.includes("-vf-"));
		assert.deepEqual(siblings, [], "no worktrees created");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("freezes authorized recipients (origin plus ancestors) into the launch request", async () => {
		const { repo, parent, ctx } = setupProject(
			"description: vf test agent\nllm-as-a-verifier: true\n",
		);
		// Lineage on disk: a top-level ancestor, and the launching session as
		// its child (header parentSession points at the ancestor's file).
		const ancestorFile = join(parent, "ancestor-session.jsonl");
		const childFile = join(parent, "parent-session.jsonl"); // ctx points here
		const header = (id: string, extra: Record<string, string> = {}) =>
			`${JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-08-25T00:00:00Z", cwd: repo, ...extra })}\n`;
		writeFileSync(ancestorFile, header("session-ancestor"));
		writeFileSync(childFile, header("session-child", { parentSession: ancestorFile }));
		// The launching session's id must match its own header.
		((ctx as { sessionManager: Record<string, unknown> }).sessionManager).getSessionId = () => "session-child";

		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = await launchVerifiedFanOut(
			{ name: "vf-run", title: "VF run", task: "freeze recipients", agent: "vf-worker" },
			loadVfAgent(repo)!,
			ctx as never,
		);
		const manifest = readVerifiedRunManifest(runDir);
		assert.deepEqual(manifest.request.authorizedRecipients, ["session-child", "session-ancestor"]);
		await cancelVerifiedRun(runDir, { timeoutMs: RUN_TIMEOUT });
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("threads the frontmatter criteria into the frozen verifier request (precedence over the packaged generic fallback)", async () => {
		const artifactRoot = createTestDir();
		const parents: string[] = [];
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		try {
			// A repo-relative criteria file: the frontmatter path value wins over
			// every fallback and resolves against the launch cwd.
			const custom = setupProject(
				"description: vf test agent\nllm-as-a-verifier: true\nllm-as-a-verifier-criteria: rubrics/custom.md\n",
			);
			parents.push(custom.parent);
			mkdirSync(join(custom.repo, "rubrics"), { recursive: true });
			writeFileSync(
				join(custom.repo, "rubrics", "custom.md"),
				"# Rubric\n\n## Criteria\n\n### Fit {#fit}\n\nJudge the fit only.\n",
			);
			run(custom.repo, "add", "-A");
			run(custom.repo, "commit", "-q", "-m", "custom rubric");
			const customLaunch = await launchVerifiedFanOut(
				{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
				loadVfAgent(custom.repo)!,
				custom.ctx as never,
			);
			const customManifest = readVerifiedRunManifest(customLaunch.runDir);
			assert.equal(
				customManifest.request.verifier.criteriaPath,
				join(custom.repo, "rubrics", "custom.md"),
				"frontmatter path value resolves against the launch cwd",
			);

			// A built-in name selects that packaged rubric, not the generic default.
			const builtin = setupProject(
				"description: vf test agent\nllm-as-a-verifier: true\nllm-as-a-verifier-criteria: code-change\n",
			);
			parents.push(builtin.parent);
			const builtinLaunch = await launchVerifiedFanOut(
				{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
				loadVfAgent(builtin.repo)!,
				builtin.ctx as never,
			);
			assert.equal(
				readVerifiedRunManifest(builtinLaunch.runDir).request.verifier.criteriaPath,
				join(getPackagedCriteriaDir(), "code-change.md"),
				"built-in name selects the packaged rubric",
			);

			// No value at all falls back to the packaged generic rubric.
			const fallback = setupProject("description: vf test agent\nllm-as-a-verifier: true\n");
			parents.push(fallback.parent);
			const fallbackLaunch = await launchVerifiedFanOut(
				{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
				loadVfAgent(fallback.repo)!,
				fallback.ctx as never,
			);
			assert.equal(
				readVerifiedRunManifest(fallbackLaunch.runDir).request.verifier.criteriaPath,
				join(getPackagedCriteriaDir(), "generic.md"),
				"absent value falls back to the packaged generic rubric",
			);

			// Let every run settle so no supervisor outlives the test.
			for (const launch of [customLaunch, builtinLaunch, fallbackLaunch]) {
				const result = await launch.running.completionPromise!;
				assert.equal(result.exitCode, 0);
			}
		} finally {
			for (const parent of parents) rmSync(parent, { recursive: true, force: true });
			rmSync(artifactRoot, { recursive: true, force: true });
		}
	});

	it("fails closed on a dirty source tree before any spend", async () => {
		const { repo, ctx } = setupProject("description: vf test agent\nllm-as-a-verifier: true\n");
		const agentDefs = loadVfAgent(repo);
		writeFileSync(join(repo, "dirty.txt"), "dirty\n");
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		await assert.rejects(
			launchVerifiedFanOut(
				{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
				agentDefs!,
				ctx as never,
			),
			/dirty/,
		);
		assert.deepEqual(listVerifiedRuns(artifactRoot), []);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("carries a multi-word PI_SUBAGENT_PI_COMMAND prefix into every candidate argv", async () => {
		// A wrapper command like `node /path/router.mjs` must reach candidates
		// as the executable plus its prefix words; dropping the prefix would
		// spawn the runtime with only pi flags (the live e2e hit exactly that).
		const { repo, fakePi, captureDir, ctx } = setupProject("description: vf test agent\nllm-as-a-verifier: true\n");
		fixtureRoot = join(captureDir, "..");
		process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${fakePi}`;
		const agentDefs = loadVfAgent(repo);
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { running, runDir } = await launchVerifiedFanOut(
			{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
			agentDefs!,
			ctx as never,
		);
		const manifest = readVerifiedRunManifest(runDir);
		assert.equal(manifest.request.piCommand, process.execPath);
		assert.deepEqual(manifest.request.piCommandArgs, [fakePi]);
		const result = await running.completionPromise!;
		assert.equal(result.exitCode, 0);
		const captures = readdirSync(captureDir)
			.filter((name) => name.startsWith("argv-"))
			.map((name) => JSON.parse(readFileSync(join(captureDir, name), "utf8")));
		assert.equal(captures.length, 3, "all three candidates actually spawned through the wrapper");
		for (const capture of captures) {
			assert.equal(capture.argv[1], fakePi, `wrapper script must be argv[1]: ${JSON.stringify(capture.argv.slice(0, 3))}`);
			assert.equal(capture.argv[2], "-p", "candidate pi args follow the wrapper prefix");
		}
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("seeds each candidate session header with the candidate's worktree cwd", async () => {
		// Real pi adopts a continued session's recorded cwd as its project
		// root. If the header carries the source cwd, a real candidate escapes
		// its worktree and edits the source tree (found by the ticket-09 live
		// e2e); the fake-pi tests never read the header, so assert it here.
		const { repo, ctx } = setupProject("description: vf test agent\nllm-as-a-verifier: true\n");
		const agentDefs = loadVfAgent(repo);
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { running } = await launchVerifiedFanOut(
			{ name: "vf-run", title: "VF run", task: "do the thing", agent: "vf-worker" },
			agentDefs!,
			ctx as never,
		);
		const registry = runningSubagents.get(running.id)!;
		const manifest = readVerifiedRunManifest(registry.verifiedRunDir!);
		for (const candidate of manifest.request.candidates) {
			const header = JSON.parse(readFileSync(candidate.sessionFile, "utf8").split("\n", 1)[0]);
			assert.equal(header.type, "session");
			assert.equal(
				header.cwd,
				candidate.worktree,
				`candidate w${candidate.index} session header must record the worktree cwd, not the source cwd`,
			);
		}
		const result = await running.completionPromise!;
		assert.equal(result.exitCode, 0);
		rmSync(artifactRoot, { recursive: true, force: true });
	});
});
