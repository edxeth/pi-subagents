import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyWinnerToSource, ApplyError } from "../../src/vf/apply.ts";
import {
	createCandidateWorktrees,
	preflightWorktreeSource,
	snapshotCandidateWorktree,
	type CandidateSnapshot,
} from "../../src/vf/worktrees.ts";
import { waitForVerifiedRunResult } from "../../src/vf/run/client.ts";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { readVerifiedRunManifest, type VerifiedRunManifest } from "../../src/vf/run/types.ts";
import { verifiedRunToSubagentResult } from "../../src/vf/run/launch.ts";
import { assert, createTestDir } from "../support/index.ts";
import { buildSupervisedRun, gitRun as run, setupVerifiedRunFixture } from "../support/verified-runs.ts";

/**
 * Ticket 08 — guarded winner application and single-result routing.
 *
 * Live-process tests drive the REAL detached supervisor end-to-end (real
 * worktrees, real candidate processes, real bridge tournament against the
 * mock backend) and then assert the apply transaction on the real source
 * repo: immediate clean-base CAS while the supervisor is alive, fail-closed
 * resets, worktree cleanup with retained branches, the compact verification
 * footer, and the non-resumable candidate-session error.
 */

const RUN_TIMEOUT = 120_000;
const DRIFT_POLL_MS = 20;

let fixtureRoot = "";

afterEach(() => {
	if (fixtureRoot) {
		// Best-effort: repos are temp dirs; leftover worktree metadata dies with them.
		try {
			run(fixtureRoot, "worktree", "prune");
		} catch {
			// ignore
		}
	}
	fixtureRoot = "";
});

function waitForState(runDir: string, state: string): Promise<VerifiedRunManifest> {
	const deadline = Date.now() + RUN_TIMEOUT;
	return new Promise((resolve, reject) => {
		const poll = () => {
			let manifest: VerifiedRunManifest;
			try {
				manifest = readVerifiedRunManifest(runDir);
			} catch (error) {
				reject(error);
				return;
			}
			if (manifest.state === state) {
				resolve(manifest);
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error(`timed out waiting for state ${state} (at ${manifest.state})`));
				return;
			}
			setTimeout(poll, DRIFT_POLL_MS);
		};
		poll();
	});
}

describe("verified fan-out apply gate (live processes)", () => {
	it("applies the winner onto the unchanged base immediately and returns one footer'd result", async () => {
		const { repo, fakePi, captureDir, parent } = setupVerifiedRunFixture();
		fixtureRoot = parent;
		const { runDir, runId } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "winner change" },
			{ marker: "VF-MID", change: "mid change" },
			{ marker: "", change: "plain change" },
		]);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const selection = manifest.result?.selection;
		assert.ok(selection, manifest.result?.failure?.message);
		assert.equal(manifest.state, "completed");
		// The apply ran inside the live supervisor, right after selection.
		assert.equal(manifest.result?.apply?.applied, true);
		assert.equal(manifest.result?.apply?.code, "applied");
		assert.equal(manifest.result?.apply?.treeHash, selection.winnerTreeHash);
		// Winner changes are staged in the source repo, exactly as the footer says.
		assert.equal(run(repo, "status", "--porcelain"), "A  change.txt");
		assert.equal(run(repo, "diff", "--staged", "--name-only"), "change.txt");
		assert.equal(
			run(repo, "show", ":change.txt").trim(),
			"winner change",
			"staged content is the winner's change",
		);
		// Worktree directories removed; internal branches retained for audit.
		for (const spec of manifest.request.candidates) {
			assert.equal(existsSync(spec.worktree), false, `worktree removed: ${spec.worktree}`);
		}
		for (let index = 1; index <= 3; index++) {
			assert.equal(
				run(repo, "show-ref", "--verify", `refs/heads/vf/${runId.replace(/^vf-/, "")}/w${index}`).length > 0,
				true,
				`internal branch retained: w${index}`,
			);
		}
		// ONE logical result: the winner's report plus the compact footer.
		const result = verifiedRunToSubagentResult(manifest, runDir, { name: "vf-run", task: "do the thing" }, Date.now());
		assert.equal(result.exitCode, 0);
		assert.ok(result.summary.startsWith(selection.winnerReport), "summary leads with the winner report");
		assert.equal(result.summary.match(/\[verified fan-out /g)?.length, 1, "exactly one footer block");
		assert.match(result.summary, /winner w1 of 3 candidates \(3 distinct\)/);
		assert.match(result.summary, /score 0\.\d+/);
		assert.match(result.summary, /criteria alignment, evidence, completeness/);
		assert.match(result.summary, /verifier deepseek-v4-flash \(\d+ calls, \d+ in \/ \d+ out tokens\)/);
		assert.match(result.summary, /artifacts .*vf-runs/);
		assert.match(result.summary, /git diff --staged/);
		assert.match(result.summary, new RegExp(`git reset --hard ${manifest.request.baseCommit}`));
	});

	it("skips the apply on source drift during selection, keeps worktrees, and points at the branch", async () => {
		const { repo, fakePi, captureDir, parent } = setupVerifiedRunFixture();
		fixtureRoot = parent;
		// A slow backend call widens the selection window so the drift lands
		// deterministically after preflight but before the apply runs.
		const { runDir, runId } = buildSupervisedRun(
			repo,
			fakePi,
			captureDir,
			[
				{ marker: "VF-GOOD", change: "winner change" },
				{ marker: "VF-MID", change: "mid change" },
			],
			{ verifier: { mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID", sleepSeconds: 2 } } },
		);
		await waitForState(runDir, "verifying");
		writeFileSync(join(repo, "user-edit.txt"), "concurrent user edit\n");
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const selection = manifest.result?.selection;
		assert.ok(selection, manifest.result?.failure?.message);
		assert.equal(manifest.state, "completed", "selection succeeded; only the apply was skipped");
		assert.equal(manifest.result?.apply?.applied, false);
		assert.equal(manifest.result?.apply?.code, "source-drift");
		// The user's concurrent edit is untouched and NOTHING was applied.
		assert.equal(run(repo, "status", "--porcelain"), "?? user-edit.txt");
		assert.equal(existsSync(join(repo, "change.txt")), false, "no winner change applied");
		// Worktrees retained (audit/runner-up recovery) alongside the branches.
		for (const spec of manifest.request.candidates) {
			assert.equal(existsSync(spec.worktree), true, `worktree retained: ${spec.worktree}`);
		}
		assert.equal(
			run(repo, "show-ref", "--verify", `refs/heads/vf/${runId.replace(/^vf-/, "")}/w1`).length > 0,
			true,
			"winner branch retained",
		);
		const result = verifiedRunToSubagentResult(manifest, runDir, { name: "vf-run", task: "t" }, Date.now());
		assert.match(result.summary, /winner NOT applied \(source-drift\)/);
		assert.match(result.summary, new RegExp(`winner retained on branch .?vf/${runId.replace(/^vf-/, "")}/w1`));
	});

	it("refuses to resume a finalized run's candidate session with the precise error", async () => {
		const { repo, fakePi, captureDir, parent } = setupVerifiedRunFixture();
		fixtureRoot = parent;
		const { runDir } = buildSupervisedRun(repo, fakePi, captureDir, [
			{ marker: "VF-GOOD", change: "winner change" },
			{ marker: "VF-MID", change: "mid change" },
		]);
		const manifest = await waitForVerifiedRunResult(runDir, { timeoutMs: RUN_TIMEOUT });
		const sessionFile = manifest.request.candidates[0].sessionFile;
		assert.equal(existsSync(sessionFile), true);
		// The production launch stamps every candidate env with the run dir;
		// a resumed candidate would come back to life in a deleted worktree.
		process.env.PI_SUBAGENT_VF_RUN_DIR = runDir;
		try {
			await assert.rejects(
				resumeSubagentSession({ sessionFile, task: "continue" }, {} as never),
				(error: Error) => {
					assert.match(error.message, /verified fan-out run that is finalized/);
					assert.match(error.message, /cannot be resumed/);
					assert.match(error.message, new RegExp(runDir.replaceAll("/", "\\/")));
					return true;
				},
			);
		} finally {
			delete process.env.PI_SUBAGENT_VF_RUN_DIR;
		}
	});
});

describe("applyWinnerToSource transaction (real git)", () => {
	function scenario(): { repo: string; base: string; snapshot: CandidateSnapshot } {
		const parent = createTestDir();
		const repo = join(parent, "repo");
		mkdirSync(repo, { recursive: true });
		run(repo, "init", "-q");
		run(repo, "config", "user.email", "test@localhost");
		run(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "README.md"), "# base\n");
		run(repo, "add", "-A");
		run(repo, "commit", "-q", "-m", "base");
		const preflight = preflightWorktreeSource(repo);
		const worktrees = createCandidateWorktrees({ cwd: repo, runId: "vf-apptest", count: 1, preflight });
		writeFileSync(join(worktrees[0].path, "change.txt"), "winner change\n");
		const snapshot = snapshotCandidateWorktree(worktrees[0]);
		return { repo, base: preflight.baseCommit, snapshot };
	}

	it("applies a real snapshot commit and stages exactly the winner tree", () => {
		const { repo, base, snapshot } = scenario();
		const applied = applyWinnerToSource({
			sourceRepo: repo,
			baseCommit: base,
			winnerCommit: snapshot.commit,
			winnerTreeHash: snapshot.treeHash,
		});
		assert.equal(applied.applied, true);
		assert.equal(applied.treeHash, snapshot.treeHash);
		assert.equal(run(repo, "write-tree"), snapshot.treeHash);
		assert.equal(applied.revertCommand, `git reset --hard ${base}`);
		assert.equal(run(repo, "rev-parse", "HEAD"), base, "HEAD stays at the base (--no-commit)");
	});

	it("fails closed on a tree mismatch and resets the source to the base", () => {
		const { repo, base, snapshot } = scenario();
		assert.throws(
			() =>
				applyWinnerToSource({
					sourceRepo: repo,
					baseCommit: base,
					winnerCommit: snapshot.commit,
					winnerTreeHash: "0".repeat(40),
				}),
			(error: ApplyError) => {
				assert.equal(error.code, "tree-mismatch");
				assert.match(error.message, /nothing was applied/);
				return true;
			},
		);
		assert.equal(run(repo, "status", "--porcelain"), "", "transaction reset");
		assert.equal(run(repo, "rev-parse", "HEAD"), base);
	});

	it("fails closed when the cherry-pick itself fails and resets the source", () => {
		const { repo, base } = scenario();
		assert.throws(
			() =>
				applyWinnerToSource({
					sourceRepo: repo,
					baseCommit: base,
					winnerCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
					winnerTreeHash: "0".repeat(40),
				}),
			(error: ApplyError) => {
				assert.equal(error.code, "apply-conflict");
				return true;
			},
		);
		assert.equal(run(repo, "status", "--porcelain"), "", "transaction reset");
		assert.equal(run(repo, "rev-parse", "HEAD"), base);
	});

	it("fails closed on a dirty source and never touches the user's files", () => {
		const { repo, base, snapshot } = scenario();
		writeFileSync(join(repo, "user-edit.txt"), "keep me\n");
		assert.throws(
			() =>
				applyWinnerToSource({
					sourceRepo: repo,
					baseCommit: base,
					winnerCommit: snapshot.commit,
					winnerTreeHash: snapshot.treeHash,
				}),
			(error: ApplyError) => {
				assert.equal(error.code, "source-drift");
				return true;
			},
		);
		assert.equal(run(repo, "status", "--porcelain"), "?? user-edit.txt");
		assert.equal(existsSync(join(repo, "change.txt")), false);
	});

	it("fails closed when the source HEAD moved off the base", () => {
		const { repo, base, snapshot } = scenario();
		writeFileSync(join(repo, "README.md"), "# moved on\n");
		run(repo, "add", "-A");
		run(repo, "commit", "-q", "-m", "user commit");
		const moved = run(repo, "rev-parse", "HEAD");
		assert.throws(
			() =>
				applyWinnerToSource({
					sourceRepo: repo,
					baseCommit: base,
					winnerCommit: snapshot.commit,
					winnerTreeHash: snapshot.treeHash,
				}),
			(error: ApplyError) => {
				assert.equal(error.code, "source-drift");
				assert.match(error.message, /HEAD moved/);
				return true;
			},
		);
		assert.equal(run(repo, "rev-parse", "HEAD"), moved, "user's newer commit untouched");
		assert.equal(run(repo, "status", "--porcelain"), "");
	});
});
