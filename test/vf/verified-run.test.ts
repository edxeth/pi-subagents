import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadAgentDefaults } from "../../src/agents/definitions.ts";
import { getPackagedCriteriaDir } from "../../src/vf/criteria.ts";
import { newRunId } from "../../src/vf/supervisor/run-client.ts";
import { candidateWorktreeBranchName, candidateWorktreeDirName, preflightWorktreeSource } from "../../src/vf/worktrees.ts";
import {
	adoptVerifiedRuns,
} from "../../src/vf/run/adopt.ts";
import {
	cancelVerifiedRun,
	listVerifiedRuns,
	respawnVerifiedSupervisor,
	startVerifiedRun,
	waitForVerifiedRunResult,
} from "../../src/vf/run/client.ts";
import { launchVerifiedFanOut, VerifiedLaunchError, verifiedRunsBaseDir } from "../../src/vf/run/launch.ts";
import { resolveSubagentCwd } from "../../src/launch/runtime-paths.ts";
import { isTerminalRunState, readVerifiedRunManifest, verifiedRunFilePaths } from "../../src/vf/run/types.ts";
import { getLiveSlotCount, initializeSpawnWidthForSession, resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
import { resetSubagentStateForTest, runningSubagents } from "../../src/runtime/wiring.ts";
import { assert, createTestDir, sleep, writeExecutable } from "../support/index.ts";

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

const FAKE_PI = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const session = process.env.PI_SUBAGENT_SESSION ?? "";
const captureDir = process.env.TEST_CAPTURE_DIR ?? "";
const markerMap = process.env.TEST_MARKER_MAP ? JSON.parse(process.env.TEST_MARKER_MAP) : {};
const slot = /-w(\\d+)$/.exec(process.env.COMPOSE_PROJECT_NAME ?? "");
const marker = process.env.TEST_MARKER ?? (slot ? markerMap[slot[1]] ?? "" : "");
const before = Number(process.env.TEST_DELAY_BEFORE_MS ?? "0");
const after = Number(process.env.TEST_DELAY_AFTER_MS ?? "0");

if (captureDir) {
	writeFileSync(
		join(captureDir, \`argv-\${process.pid}.json\`),
		JSON.stringify(
			{
				argv: process.argv,
				marker,
				compose: process.env.COMPOSE_PROJECT_NAME ?? "",
				portOffset: process.env.PORT_OFFSET ?? "",
				session,
				denyTools: process.env.PI_DENY_TOOLS ?? "",
				spawnBudget: process.env.PI_SUBAGENT_SPAWN_BUDGET ?? "",
			},
			null,
			2,
		),
	);
}
if (before > 0) await new Promise((resolve) => setTimeout(resolve, before));
if (session) {
	mkdirSync(dirname(session), { recursive: true });
	const e = (id, parentId, message) =>
		JSON.stringify({ type: "message", id, parentId, timestamp: "2026-08-22T00:00:00Z", message });
	appendFileSync(
		session,
		[
			e("m1", null, { role: "user", content: [{ type: "text", text: "candidate task prompt" }] }),
			e("m2", "m1", { role: "assistant", content: [{ type: "text", text: \`working; marker \${marker}\` }] }),
			e("m3", "m2", {
				role: "assistant",
				content: [{ type: "text", text: \`Final report for \${marker || "none"}: completed the task with tests passing.\` }],
			}),
		]
			.map((line) => line + "\\n")
			.join(""),
	);
}
if (process.env.TEST_CHANGE) writeFileSync("change.txt", process.env.TEST_CHANGE + "\\n");
if (after > 0) await new Promise((resolve) => setTimeout(resolve, after));
process.exit(Number(process.env.TEST_EXIT_CODE ?? "0"));
`;

let fixtureRoot = "";

function setupFixture(): { repo: string; parent: string; fakePi: string; captureDir: string } {
	const parent = createTestDir();
	const repo = join(parent, "repo");
	mkdirSync(repo, { recursive: true });
	run(repo, "init", "-q");
	run(repo, "config", "user.email", "test@localhost");
	run(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "# test repo\n", "utf8");
	run(repo, "add", "-A");
	run(repo, "commit", "-q", "-m", "base");
	const captureDir = join(parent, "captures");
	mkdirSync(captureDir, { recursive: true });
	const fakePi = writeExecutable(parent, "fake-pi.mjs", `#!/usr/bin/env node\n${FAKE_PI}`);
	chmodSync(fakePi, 0o755);
	return { repo, parent, fakePi, captureDir };
}

function loadVfAgent(repo: string) {
	return loadAgentDefaults("vf-worker", undefined, repo, resolveSubagentCwd);
}

function run(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

afterEach(() => {
	resetSubagentStateForTest();
	resetSpawnWidthForTest();
	if (fixtureRoot) {
		rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = "";
	}
});

interface CandidateFixture {
	marker: string;
	exitCode?: number;
	beforeMs?: number;
	change?: string;
}

function buildSupervisedRun(
	repo: string,
	fakePi: string,
	captureDir: string,
	candidates: CandidateFixture[],
	options: { baseCommit?: string; baseDir?: string } = {},
): { runDir: string; runId: string } {
	const baseDir = options.baseDir ?? createTestDir();
	const runId = newRunId();
	const sessionDir = join(baseDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const baseCommit = options.baseCommit ?? preflightWorktreeSource(repo).baseCommit;
	const request = {
		kind: "verified-fanout" as const,
		name: "vf-test",
		title: "VF test run",
		piCommand: process.execPath,
		taskArtifact: join(baseDir, "task.md"),
		taskPrompt: "candidate task prompt",
		sourceRepo: repo,
		baseCommit,
		agent: "tester",
		candidateCount: candidates.length,
		candidates: candidates.map((candidate, i) => ({
			index: i + 1,
			sessionFile: join(sessionDir, `w${i + 1}.jsonl`),
			worktree: join(dirname(repo), candidateWorktreeDirName(repo, runId, i + 1)),
			internalBranch: candidateWorktreeBranchName(runId, i + 1),
			args: [fakePi],
			env: {
				PI_SUBAGENT_SESSION: join(sessionDir, `w${i + 1}.jsonl`),
				TEST_CAPTURE_DIR: captureDir,
				TEST_MARKER: candidate.marker,
				TEST_EXIT_CODE: String(candidate.exitCode ?? 0),
				TEST_DELAY_BEFORE_MS: String(candidate.beforeMs ?? 0),
				...(candidate.change ? { TEST_CHANGE: candidate.change } : {}),
			},
			launchEntryCount: 0,
		})),
		verifier: {
			model: "deepseek-v4-flash",
			thinking: null,
			env: {},
			criteriaPath: join(getPackagedCriteriaDir(), "generic.md"),
			mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID" },
		},
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
		},
		parentSessionId: null,
		createdAt: new Date().toISOString(),
	};
	const started = startVerifiedRun({ baseDir, runId, request });
	return { runDir: started.runDir, runId };
}

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
		// Traces and ranking artifacts exist; worktrees retained for the apply gate.
		const paths = verifiedRunFilePaths(runDir);
		assert.equal(existsSync(paths.ranking), true);
		assert.equal(manifest.result?.artifacts.traces.length, 3);
		assert.equal(existsSync(manifest.request.candidates[0].worktree), true);
		assert.equal(
			run(repo, "show-ref", "--verify", `refs/heads/${candidateWorktreeBranchName(runId, 1)}`).length > 0,
			true,
			"winner snapshot branch retained",
		);
		// The source repo itself is untouched.
		assert.equal(run(repo, "status", "--porcelain"), "");
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
	function setupProject(agentFrontmatter: string): { repo: string; parent: string; ctx: unknown } {
		const { repo, parent, fakePi, captureDir } = setupFixture();
		fixtureRoot = parent;
		mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
		writeFileSync(join(repo, ".pi", "agents", "vf-worker.md"), `---\n${agentFrontmatter}---\nAgent body.\n`);
		// The agent definition must be part of the clean base: an untracked
		// .pi/ would (correctly) fail the dirty-tree gate.
		run(repo, "add", "-A");
		run(repo, "commit", "-q", "-m", "agent definition");
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
		process.env.DEEPSEEK_API_KEY = "test-only-key";
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
		return { repo, parent, ctx };
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
			assert.match(candidate.env.COMPOSE_PROJECT_NAME ?? "", new RegExp(`-w${candidate.index}$`));
		}
		assert.equal(getLiveSlotCount(), 3, "N candidates hold N spawn slots");
		const result = await running.completionPromise!;
		assert.equal(result.exitCode, 0);
		assert.match(result.summary, /Final report for VF-GOOD/);
		assert.match(result.summary, new RegExp(runId));
		assert.equal(getLiveSlotCount(), 0, "all N slots released at completion");
		const finalManifest = readVerifiedRunManifest(runDir);
		assert.equal(finalManifest.state, "completed");
		assert.equal(existsSync(verifiedRunFilePaths(runDir).deliveryClaim), true, "delivery claimed exactly once");
		// Winner worktree retained + branch retained; source untouched.
		assert.equal(existsSync(finalManifest.result?.selection?.winnerWorktree ?? ""), true);
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
});

describe("verified fan-out reattach", () => {
	function captureSink() {
		const messages: Array<{ content: string; details: Record<string, unknown> }> = [];
		return {
			messages,
			sink: {
				sendMessage: (message: { content: string; details?: Record<string, unknown> }) => {
					messages.push({ content: message.content, details: message.details ?? {} });
				},
			},
		};
	}

	it("delivers a finished run exactly once to a reattaching parent", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo) });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { messages, sink } = captureSink();
		const first = adoptVerifiedRuns(sink as never, repo);
		assert.equal(first.find((entry) => entry.runDir === runDir)?.action, "delivered");
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /Final report for VF-GOOD/);
		const second = adoptVerifiedRuns(sink as never, repo);
		assert.equal(second.find((entry) => entry.runDir === runDir)?.action, "already-delivered");
		assert.equal(messages.length, 1, "exactly-once delivery via the claim file");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("watches a still-running run and steers the late result in (continued child)", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 3_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 3_000, change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo) });
		await waitForState(runDir, "running");
		const { messages, sink } = captureSink();
		const adopted = adoptVerifiedRuns(sink as never, repo);
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		assert.equal(messages.length, 0, "nothing delivered while candidates still run");
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		await sleep(1_000); // let the adopt watcher poll the terminal state
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /Final report for VF-GOOD/);
		assert.equal(getLiveSlotCount(), 0, "adopted watcher released its slots");
		rmSync(artifactRoot, { recursive: true, force: true });
	});
});

async function waitForState(runDir: string, state: string) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const manifest = readVerifiedRunManifest(runDir);
		if (manifest.state === state) return manifest;
		if (isTerminalRunState(manifest.state)) {
			throw new Error(`run reached ${manifest.state} while waiting for ${state}: ${manifest.result?.failure?.message}`);
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for state ${state}`);
		await sleep(100);
	}
}
