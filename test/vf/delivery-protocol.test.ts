import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { adoptVerifiedRuns } from "../../src/vf/run/adopt.ts";
import { cancelVerifiedRun, respawnVerifiedSupervisor, waitForVerifiedRunResult } from "../../src/vf/run/client.ts";
import { verifiedRunsBaseDir, resolveAuthorizedRecipients } from "../../src/vf/run/launch.ts";
import {
	acquireVerifiedRunDeliveryLease,
	readVerifiedRunManifest,
	verifiedRunResultGeneration,
	writeVerifiedRunDeliveryReceipt,
	writeVerifiedRunManifest,
} from "../../src/vf/run/types.ts";
import { getLiveSlotCount, resetSpawnWidthForTest } from "../../src/runtime/spawn-width.ts";
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
 * Delivery protocol for verified fan-outs: origin-gated recipients, the
 * lease/receipt handshake, provenance notices, observer rights, and lineage
 * freezing. Live-process tests like verified-run.test.ts (real detached
 * supervisor, real worktrees, mock verifier backend).
 */

const RUN_TIMEOUT = 120_000;

let fixtureRoot = "";

afterEach(() => {
	resetSubagentStateForTest();
	resetSpawnWidthForTest();
	if (fixtureRoot) {
		rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = "";
	}
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
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { messages, sink } = captureSink();
		const first = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-origin" });
		assert.equal(first.find((entry) => entry.runDir === runDir)?.action, "delivered");
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /Final report for VF-GOOD/);
		const second = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-origin" });
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
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		const { messages, sink } = captureSink();
		const adopted = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-origin" });
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		assert.equal(getLiveSlotCount(), 2, "the origin's watcher holds the fan-out slots");
		assert.equal(messages.length, 0, "nothing delivered while candidates still run");
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		await sleep(1_000); // let the adopt watcher poll the terminal state
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /Final report for VF-GOOD/);
		assert.equal(getLiveSlotCount(), 0, "adopted watcher released its slots");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("observes without reserving spawn width for a run it may not deliver", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 10_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 10_000, change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		const { sink } = captureSink();
		const adopted = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		assert.equal(getLiveSlotCount(), 0, "an observer reserves nothing");
		await cancelVerifiedRun(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(getLiveSlotCount(), 0);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("delivers a finished run only to its authorized recipient session", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], {
			baseDir: verifiedRunsBaseDir(repo),
			parentSessionId: "session-origin",
			authorizedRecipients: ["session-origin", "session-ancestor"],
		});
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { messages, sink } = captureSink();

		// An unrelated session in the same project receives nothing.
		const stranger = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(stranger.find((entry) => entry.runDir === runDir)?.action, "awaiting-origin");
		assert.equal(messages.length, 1, "an unrelated session gets the provenance notice only");
		assert.match(messages[0].content, /git diff --staged/);
		assert.doesNotMatch(messages[0].content, /Final report/, "an unrelated session must not receive another session's report");

		// The authorized origin receives it, exactly once.
		const origin = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-origin" });
		assert.equal(origin.find((entry) => entry.runDir === runDir)?.action, "delivered");
		assert.equal(messages.length, 2, "notice for the stranger, report for the origin");
		assert.match(messages[1].content, /Final report for VF-GOOD/);

		// A second authorized session (the ancestor) finds it already delivered.
		const ancestor = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-ancestor" });
		assert.equal(ancestor.find((entry) => entry.runDir === runDir)?.action, "already-delivered");
		assert.equal(messages.length, 2);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("ignores runs from a different repo that merely shares the project basename", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		// A second, unrelated repo with the SAME basename: its artifact bucket
		// collides with the first repo's.
		const otherParent = join(createTestDir(), "other");
		mkdirSync(otherParent, { recursive: true });
		const otherRepo = join(otherParent, "repo");
		mkdirSync(otherRepo, { recursive: true });
		run(otherRepo, "init", "-q");
		run(otherRepo, "config", "user.email", "test@localhost");
		run(otherRepo, "config", "user.name", "Test");
		writeFileSync(join(otherRepo, "README.md"), "# other repo\n");
		run(otherRepo, "add", "-A");
		run(otherRepo, "commit", "-q", "-m", "base");
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], {
			baseDir: verifiedRunsBaseDir(repo),
			parentSessionId: "session-origin",
		});
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { messages, sink } = captureSink();

		const foreign = await adoptVerifiedRuns(sink as never, otherRepo, { sessionId: "session-origin" });
		assert.equal(foreign.find((entry) => entry.runDir === runDir)?.action, "foreign");
		assert.equal(messages.length, 0, "a same-named repo is not this run's project");

		const home = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-origin" });
		assert.equal(home.find((entry) => entry.runDir === runDir)?.action, "delivered");
		assert.equal(messages.length, 1);
		rmSync(artifactRoot, { recursive: true, force: true });
		rmSync(otherParent, { recursive: true, force: true });
	});

	it("refuses a non-recipient session's kill on an adopted verified run", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 10_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 10_000, change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		const { sink } = captureSink();
		const adopted = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		const running = runningSubagents.get(runDir.slice(-8))!;
		assert.ok(running, "observer watcher registered");

		await assert.rejects(() => stopRunningSubagent(running), /not an authorized recipient/);
		assert.equal(existsSync(join(runDir, "cancel")), false, "no cancel sentinel written");
		// The operator surface (the /subagents overlay) may still cancel.
		await stopRunningSubagent(running, { operator: true });
		assert.equal(existsSync(join(runDir, "cancel")), true, "operator cancel writes the sentinel");
		await cancelVerifiedRun(runDir, { timeoutMs: RUN_TIMEOUT });
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("lets the origin session cancel its own adopted run", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 10_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 10_000, change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		const { sink } = captureSink();
		const adopted = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-origin" });
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		const running = runningSubagents.get(runDir.slice(-8))!;
		await stopRunningSubagent(running);
		const final = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		assert.equal(final.state, "cancelled");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("serializes supervisor respawn behind a care lease", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 10_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 10_000, change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		// Kill the supervisor: the run is orphaned.
		const supervisorPid = readVerifiedRunManifest(runDir).lease!.pid;
		process.kill(supervisorPid, "SIGKILL");
		await sleep(300);

		// A live care-lease holder blocks the respawn.
		writeFileSync(join(runDir, "care.lease"), `${JSON.stringify({ pid: process.pid, takenAt: new Date().toISOString() })}\n`);
		assert.throws(() => respawnVerifiedSupervisor(runDir), /care lease/);

		// A dead holder's lease is stale: the takeover proceeds.
		const deadHolder = spawnSync("true", { encoding: "utf8" });
		writeFileSync(join(runDir, "care.lease"), `${JSON.stringify({ pid: deadHolder.pid, takenAt: new Date().toISOString() })}\n`);
		respawnVerifiedSupervisor(runDir);
		await waitForState(runDir, "running");
		// The replacement supervisor clears the care lease once it owns the run.
		for (let i = 0; i < 50 && existsSync(join(runDir, "care.lease")); i += 1) await sleep(100);
		assert.equal(existsSync(join(runDir, "care.lease")), false, "care lease released by the new supervisor");
		await cancelVerifiedRun(runDir, { timeoutMs: RUN_TIMEOUT });
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("reclaims a delivery lease whose holder died and proves delivery with a receipt", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir, runId } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], {
			baseDir: verifiedRunsBaseDir(repo),
			parentSessionId: "session-origin",
			authorizedRecipients: ["session-origin", "session-ancestor"],
		});
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		// The origin claimed delivery, then crashed before sending anything.
		const deadHolder = spawnSync("true", { encoding: "utf8" });
		writeFileSync(join(runDir, "delivery.lease"), `${JSON.stringify({
			sessionId: "session-origin",
			pid: deadHolder.pid,
			generation: 1,
			deliveryId: `${runId}-g1`,
			acquiredAt: new Date().toISOString(),
		}, null, "\t")}\n`);

		const { messages, sink } = captureSink();
		const reclaimed = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-ancestor",
			confirmPersisted: async () => true,
		});
		assert.equal(reclaimed.find((entry) => entry.runDir === runDir)?.action, "delivered");
		assert.equal(messages.length, 1, "the ancestor receives the report the dead origin never sent");
		const receipt = JSON.parse(readFileSync(join(runDir, "delivery.receipt"), "utf8"));
		assert.equal(receipt.sessionId, "session-ancestor");
		assert.equal(receipt.deliveryId, `${runId}-g1`);

		const again = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-ancestor",
			confirmPersisted: async () => true,
		});
		assert.equal(again.find((entry) => entry.runDir === runDir)?.action, "already-delivered");
		assert.equal(messages.length, 1, "the receipt is the exactly-once proof");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("refuses to steal a delivery lease held by a live process", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir, runId } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], {
			baseDir: verifiedRunsBaseDir(repo),
			parentSessionId: "session-origin",
			authorizedRecipients: ["session-origin", "session-ancestor"],
		});
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		writeFileSync(join(runDir, "delivery.lease"), `${JSON.stringify({
			sessionId: "session-origin",
			pid: process.pid,
			generation: 1,
			deliveryId: `${runId}-g1`,
			acquiredAt: new Date().toISOString(),
		}, null, "\t")}\n`);

		const { messages, sink } = captureSink();
		const refused = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-ancestor",
			confirmPersisted: async () => true,
		});
		assert.equal(refused.find((entry) => entry.runDir === runDir)?.action, "lease-held");
		assert.equal(messages.length, 0, "a live holder's delivery must not be stolen");
		assert.equal(existsSync(join(runDir, "delivery.receipt")), false);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("treats a legacy delivery claim without a receipt as undelivered", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		// An older build (or a crashed live watcher) wrote only a claim; the
		// holder died before any report was sent. The claim alone is not proof
		// of delivery — the authorized recipient must still get the report.
		writeFileSync(join(runDir, "delivery.claim"), `${JSON.stringify({ claimedAt: "2026-08-22T00:00:00Z", pid: -1 })}\n`);
		const { messages, sink } = captureSink();
		const outcome = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			confirmPersisted: async () => true,
		});
		assert.equal(outcome.find((entry) => entry.runDir === runDir)?.action, "delivered");
		assert.equal(messages.length, 1, "the report is not stranded by a bare legacy claim");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("sends the provenance notice once per session process", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { messages, sink } = captureSink();
		const noticeCount = () => messages.filter((m) => /detached supervisor staged/.test(m.content)).length;
		const first = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(first.find((entry) => entry.runDir === runDir)?.action, "awaiting-origin");
		assert.equal(noticeCount(), 1);
		// A repeated session_start in the same process (reload/replacement)
		// must not repeat the notice.
		const second = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(second.find((entry) => entry.runDir === runDir)?.action, "awaiting-origin");
		assert.equal(noticeCount(), 1, "no duplicate notice within one process");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("delivers without triggering a turn when asked (print-mode adoption)", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const sends: Array<{ message: { content: string; details?: Record<string, unknown> }; options: Record<string, unknown> }> = [];
		const sink = {
			sendMessage: (message: { content: string; details?: Record<string, unknown> }, options: Record<string, unknown>) => {
				sends.push({ message, options });
			},
		};
		const outcome = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			triggerTurn: false,
			confirmPersisted: async () => true,
		});
		assert.equal(outcome.find((entry) => entry.runDir === runDir)?.action, "delivered");
		const report = sends.find((s) => s.message.details?.deliveryId);
		assert.ok(report, "report sent");
		assert.equal(report.options.triggerTurn, false, "print-mode adoption must not trigger a turn");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("resolves, never rejects, an adopted watcher at session shutdown", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", beforeMs: 10_000, change: "good change" },
			{ marker: "VF-MID", beforeMs: 10_000, change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		const { sink } = captureSink();
		const adopted = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		const running = runningSubagents.get(runDir.slice(-8))!;
		// Shutdown aborts module watchers; an unhandled rejection here killed
		// live `-p` sessions at exit (rc=1). The watch must resolve quietly.
		moduleAbortController.abort();
		const result = await running.completionPromise!;
		assert.match(result.summary, /stopped watching/);
		assert.equal(existsSync(join(runDir, "cancel")), false, "aborting the watch must not cancel the run");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("blocks a same-session live lease holder instead of overwriting it", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir, runId } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		writeFileSync(join(runDir, "delivery.lease"), `${JSON.stringify({
			sessionId: "session-origin",
			pid: process.pid,
			generation: 1,
			deliveryId: `${runId}-g1`,
			acquiredAt: new Date().toISOString(),
		})}\n`);
		const lease = acquireVerifiedRunDeliveryLease(runDir, { sessionId: "session-origin" });
		assert.equal(lease.acquired, false, "a live holder blocks even its own session id in another process");
		assert.equal(lease.acquired ? "" : lease.reason, "live-lease");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("refuses lease and receipt when the result rotated after the caller's snapshot", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir, runId } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		const terminal = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		// A retry rotates the generation between the adopter's snapshot and
		// its lease attempt.
		const rotated = readVerifiedRunManifest(runDir);
		rotated.resultGeneration = 2;
		writeVerifiedRunManifest(runDir, rotated);
		const lease = acquireVerifiedRunDeliveryLease(runDir, {
			sessionId: "session-origin",
			expectedGeneration: verifiedRunResultGeneration(terminal),
		});
		assert.equal(lease.acquired, false, "stale-generation acquisition must be refused");
		assert.equal(lease.acquired ? "" : lease.reason, "rotated");
		assert.throws(
			() => writeVerifiedRunDeliveryReceipt(runDir, { sessionId: "session-origin", deliveryId: `${runId}-g1` }),
			/Refusing delivery receipt/,
			"a late generation-1 receipt must not block the retry result",
		);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("releases its lease and reports unconfirmed when persistence fails", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], {
			baseDir: verifiedRunsBaseDir(repo),
			parentSessionId: "session-origin",
			authorizedRecipients: ["session-origin", "session-ancestor"],
		});
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { messages, sink } = captureSink();
		const unconfirmed = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			confirmPersisted: async () => false,
		});
		assert.equal(unconfirmed.find((entry) => entry.runDir === runDir)?.action, "unconfirmed");
		assert.equal(existsSync(join(runDir, "delivery.receipt")), false, "no receipt without persistence");
		assert.equal(existsSync(join(runDir, "delivery.lease")), false, "failed confirmation releases the lease");
		// Another authorized session can now take over cleanly.
		const takeover = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-ancestor",
			confirmPersisted: async () => true,
		});
		assert.equal(takeover.find((entry) => entry.runDir === runDir)?.action, "delivered");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("delivers a retried generation to a process that already tracked the previous one", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const { sink } = captureSink();
		const first = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			confirmPersisted: async () => true,
		});
		assert.equal(first.find((entry) => entry.runDir === runDir)?.action, "delivered");
		// A retry rotates the deliverable result and purges the receipt.
		const rotated = readVerifiedRunManifest(runDir);
		rotated.resultGeneration = 2;
		writeVerifiedRunManifest(runDir, rotated);
		rmSync(join(runDir, "delivery.receipt"), { force: true });
		const second = await adoptVerifiedRuns(sink as never, repo, {
			sessionId: "session-origin",
			confirmPersisted: async () => true,
		});
		assert.equal(second.find((entry) => entry.runDir === runDir)?.action, "delivered", "generation 2 is a new deliverable");
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("writes manifest version 3 and still reads legacy version 2", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: null });
		const manifest = readVerifiedRunManifest(runDir);
		assert.equal(manifest.version >= 3, true, "new runs fence old readers out");
		// A legacy v2 manifest (pre-upgrade run) must remain readable.
		const legacy = JSON.parse(JSON.stringify(manifest));
		legacy.version = 2;
		writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(legacy, null, "\t")}\n`);
		const reread = readVerifiedRunManifest(runDir);
		assert.equal(reread.version, 2);
		assert.deepEqual(
			[...(await import("../../src/vf/run/types.ts")).authorizedRecipientIds(reread)],
			[],
			"no recorded origin means manual-only",
		);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("notifies an observer when its watched run applies a winner", async () => {
		const { repo, fakePi, captureDir, parent } = setupFixture();
		fixtureRoot = parent;
		const artifactRoot = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = artifactRoot;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "good change" },
			{ marker: "VF-MID", change: "mid change" },
		], { baseDir: verifiedRunsBaseDir(repo), parentSessionId: "session-origin" });
		await waitForState(runDir, "running");
		const { messages, sink } = captureSink();
		const adopted = await adoptVerifiedRuns(sink as never, repo, { sessionId: "session-stranger" });
		assert.equal(adopted.find((entry) => entry.runDir === runDir)?.action, "watching");
		await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const deadline = Date.now() + 10_000;
		while (!messages.some((m) => /detached supervisor staged/.test(m.content)) && Date.now() < deadline) {
			await sleep(200);
		}
		assert.equal(
			messages.some((m) => /detached supervisor staged/.test(m.content)),
			true,
			"the observer learns its watched run staged a winner",
		);
		rmSync(artifactRoot, { recursive: true, force: true });
	});

	it("freezes recipients fail-closed on unreadable or mismatched lineage", () => {
		const dir = createTestDir();
		const header = (id: string, extra: Record<string, unknown> = {}) =>
			`${JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-08-25T00:00:00Z", cwd: dir, ...extra })}\n`;
		// Origin file whose header id disagrees with the claimed origin id.
		const mismatched = join(dir, "mismatched.jsonl");
		writeFileSync(mismatched, header("session-someone-else"));
		assert.deepEqual(resolveAuthorizedRecipients(mismatched, "session-origin"), ["session-origin"],
			"a mismatched origin file must not extend recipients");
		// The same mismatch WITH a parent link must still not extend: a file
		// that is not the origin's own session file is untrusted lineage.
		const ancestorFile = join(dir, "lineage-ancestor.jsonl");
		writeFileSync(ancestorFile, header("session-ancestor"));
		const mismatchedWithParent = join(dir, "mismatched-parent.jsonl");
		writeFileSync(mismatchedWithParent, header("session-someone-else", { parentSession: ancestorFile }));
		assert.deepEqual(resolveAuthorizedRecipients(mismatchedWithParent, "session-origin"), ["session-origin"],
			"an origin file whose header id disagrees is not followed, even with a parent link");
		// Two-file cycle stops at the revisit.
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, header("session-a", { parentSession: b }));
		writeFileSync(b, header("session-b", { parentSession: a }));
		const cycled = resolveAuthorizedRecipients(a, "session-a");
		assert.deepEqual(cycled, ["session-a", "session-b"], "the cycle terminates without duplicates");
		// A non-session first line is not a session header.
		const junk = join(dir, "junk.jsonl");
		writeFileSync(junk, `{"type":"message"}\n`);
		assert.deepEqual(resolveAuthorizedRecipients(junk, "session-junk"), ["session-junk"]);
	});
});
