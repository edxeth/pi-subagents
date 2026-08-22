import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getPackagedCriteriaDir } from "../../src/vf/criteria.ts";
import { candidateWorktreeBranchName } from "../../src/vf/worktrees.ts";
import { retryVerifiedRunVerification, waitForVerifiedRunResult } from "../../src/vf/run/client.ts";
import { verifiedRunFilePaths } from "../../src/vf/run/types.ts";
import {
	defaultVerifierCachePath,
	runVerifierProbe,
	runVerifierSelect,
	VerifierBridgeError,
} from "../../src/vf/verifier/bridge.ts";
import { assert, createTestDir } from "../support/index.ts";
import {
	buildSupervisedRun,
	gitRun as run,
	setupVerifiedRunFixture as setupFixture,
} from "../support/verified-runs.ts";

/**
 * Ticket 06 — capability gate, degenerate-score halt, equivalence, retry.
 *
 * Bridge-level tests drive the REAL runner.py inside the managed venv with
 * the mock backend (no live API key). Supervisor-level tests run the REAL
 * detached supervisor over REAL git worktrees. The real-DeepSeek canary runs
 * only when DEEPSEEK_API_KEY is present.
 */

const RUN_TIMEOUT = 120_000;

let fixtureRoot = "";

afterEach(() => {
	if (fixtureRoot) {
		rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = "";
	}
});

describe("verifier capability probe (bridge)", () => {
	const criteriaPath = join(getPackagedCriteriaDir(), "generic.md");

	it("passes a discriminating logprob-capable backend and reports coverage + canary", async () => {
		const probe = await runVerifierProbe({
			model: "deepseek-v4-flash",
			thinking: null,
			criteriaPath,
			mockVerifier: { goodMarker: "CANARY-GOOD" },
		});
		assert.equal(probe.kind, "probe");
		assert.equal(probe.model, "deepseek-v4-flash", "model echo");
		assert.ok(probe.coverage.scoreA.length >= 3, `score_A covers ${probe.coverage.scoreA.length} A-T letters`);
		assert.ok(probe.coverage.scoreB.length >= 3, `score_B covers ${probe.coverage.scoreB.length} A-T letters`);
		assert.ok(probe.canary.goodScore > probe.canary.badScore, "good trace outranks bad trace");
		assert.ok(probe.canary.margin > 0.5);
		assert.equal(probe.usage.calls, 1, "exactly one backend call");
	});

	it("fails a logprob-less backend before any candidate launches", async () => {
		await assert.rejects(
			runVerifierProbe({
				model: "deepseek-v4-flash",
				criteriaPath,
				mockVerifier: { goodMarker: "CANARY-GOOD", stripLogprobs: true },
			}),
			(error: VerifierBridgeError) => {
				assert.equal(error.kind, "capability");
				assert.match(error.message, /no A-T score-token logprobs/);
				assert.equal(error.exitCode, 6);
				return true;
			},
		);
	});

	it("fails a flat backend: the canary cannot rank good over bad", async () => {
		await assert.rejects(
			runVerifierProbe({ model: "deepseek-v4-flash", criteriaPath, mockVerifier: { flatScores: true } }),
			(error: VerifierBridgeError) => {
				assert.equal(error.kind, "capability");
				assert.match(error.message, /canary failed/);
				return true;
			},
		);
	});

	it("halts selection on a flat score distribution without a winner", async () => {
		const dir = createTestDir();
		await assert.rejects(
			runVerifierSelect({
				problem: "probe problem",
				candidates: ["[Command] echo VF-GOOD\n[Output] VF-GOOD", "[Command] echo mid\n[Output] mid"],
				criteriaPath,
				model: "deepseek-v4-flash",
				cachePath: join(dir, "cache.json"),
				mockVerifier: { goodMarker: "VF-GOOD", flatScores: true },
			}),
			(error: VerifierBridgeError) => {
				assert.equal(error.kind, "degenerate-scores");
				assert.match(error.message, /flat score distribution/);
				return true;
			},
		);
	});

	const maybeLiveIt = process.env.DEEPSEEK_API_KEY ? it : it.skip;
	maybeLiveIt("probes the real DeepSeek backend: A-T coverage + canary pass (live)", async () => {
		const probe = await runVerifierProbe({ model: "deepseek-v4-flash", criteriaPath, env: {} });
		assert.ok(probe.coverage.scoreA.length >= 3, `score_A covers ${probe.coverage.scoreA.length} A-T letters`);
		assert.ok(probe.coverage.scoreB.length >= 3);
		assert.ok(probe.canary.goodScore > probe.canary.badScore, "obviously-good outranks obviously-bad");
		assert.equal(probe.usage.calls, 1);
	});
});

describe("capability gate + degenerate halt (live supervisor)", () => {
	it("fails the run before any candidate launches when the backend is logprob-less", async () => {
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
			{ verifier: { mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID", stripLogprobs: true } } },
		);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.failure?.code, "capability");
		assert.match(manifest.result?.failure?.message ?? "", /no A-T score-token logprobs/);
		assert.equal(manifest.candidates.length, 0, "no candidate ever spawned");
		assert.deepEqual(readdirSync(captureDir), [], "no candidate process ran");
		assert.deepEqual(
			readdirSync(parent).filter((name) => name.includes("-vf-")),
			[],
			"no worktrees created",
		);
		assert.equal(run(repo, "status", "--porcelain"), "");
		// A pre-candidate failure cannot be retried as a verification retry.
		assert.throws(() => retryVerifiedRunVerification(runDir), /not a selection-phase failure/);
	});

	it("halts a runtime flat-score distribution without a winner and preserves artifacts", async () => {
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
			// The backend discriminates for the probe and goes flat for the
			// tournament: a proxy that degraded after preflight.
			{ verifier: { mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID", degradeForSelect: true } } },
		);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.ok, false);
		assert.equal(manifest.result?.selection, null, "no winner on a flat distribution");
		assert.equal(manifest.result?.failure?.code, "degenerate-scores");
		assert.match(manifest.result?.failure?.message ?? "", /retryVerifiedRunVerification/);
		// Traces and candidate copies are preserved for the retry.
		assert.equal(manifest.result?.artifacts.traces.length, 3);
		for (const trace of manifest.result?.artifacts.traces ?? []) {
			assert.equal(existsSync(trace), true, `trace preserved: ${trace}`);
		}
		for (const spec of manifest.request.candidates) {
			assert.equal(existsSync(spec.worktree), true, `worktree retained: ${spec.worktree}`);
		}
		assert.ok(
			run(repo, "show-ref", "--verify", `refs/heads/${candidateWorktreeBranchName(runId, 1)}`).length > 0,
			"snapshot branch retained",
		);
		assert.equal(existsSync(defaultVerifierCachePath(runDir)), true, "halted attempt wrote its cache");
		assert.equal(run(repo, "status", "--porcelain"), "");
	});

	it("retries verification over preserved traces, purges the poisoned cache, and selects a winner", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(
			repo,
			fakePi,
			captureDir,
			[
				{ marker: "VF-GOOD", change: "good change" },
				{ marker: "VF-MID", change: "mid change" },
				{ marker: "", change: "plain change" },
			],
			{ verifier: { mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID", degradeForSelect: true } } },
		);
		const halted = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(halted.result?.failure?.code, "degenerate-scores");
		// A prior delivery claim must not swallow the retry outcome.
		const paths = verifiedRunFilePaths(runDir);
		writeFileSync(paths.deliveryClaim, `${JSON.stringify({ pid: -1, claimedAt: "2026-08-22T00:00:00Z" })}\n`);
		retryVerifiedRunVerification(runDir, {
			verifier: { mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID" } },
		});
		assert.equal(existsSync(paths.deliveryClaim), false, "delivery re-armed for the retry outcome");
		const retried = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(retried.state, "completed", retried.result?.failure?.message);
		assert.equal(retried.result?.ok, true);
		assert.equal(retried.result?.selection?.winnerIndex, 1, "VF-GOOD candidate wins after the retry");
		// The retry re-ranked frozen traces: exactly N candidate spawns ever.
		assert.equal(readdirSync(captureDir).length, 3);
		assert.equal(run(repo, "status", "--porcelain"), "");
		// A completed run has nothing left to retry.
		assert.throws(() => retryVerifiedRunVerification(runDir), /already completed/);
	});

	it("reports identical candidates as equivalent, not as a backend failure", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "identical" },
			{ marker: "VF-GOOD", change: "identical" },
			{ marker: "VF-MID", change: "different" },
		]);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "completed", manifest.result?.failure?.message);
		const selection = manifest.result?.selection;
		assert.equal(selection?.distinctCandidates, 2);
		assert.deepEqual(selection?.collapsed, [2], "w2 collapsed onto w1");
		assert.deepEqual(selection?.equivalences, [{ candidate: 2, equivalentTo: 1 }]);
		assert.equal(selection?.ranking.length, 2, "only distinct candidates are ranked");
	});

	it("names equivalence when every candidate collapsed into one distinct outcome", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "identical" },
			{ marker: "VF-GOOD", change: "identical" },
		]);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.failure?.code, "insufficient-distinct-candidates");
		assert.match(manifest.result?.failure?.message ?? "", /equivalent candidates, not as a backend failure/);
	});
});
