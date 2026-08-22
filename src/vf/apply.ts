import { spawnSync } from "node:child_process";
import { candidateWorktreeBranchName, cleanupCandidateWorktrees, type CandidateWorktree } from "./worktrees.ts";

/**
 * Guarded winner application (ticket 08).
 *
 * The winner's snapshot commit is applied to the user's source worktree ONLY
 * as an explicit, immediate, atomic clean-base compare-and-swap run while the
 * supervisor is alive — never at an arbitrary later time. The transaction:
 * re-verify the source is exactly the recorded clean base, cherry-pick the
 * winner commit with --no-commit, then require `git diff --check` and exact
 * tree equality against the winner's snapshot tree. Any drift, conflict, or
 * mismatch resets the transaction and applies NOTHING; the winner branch is
 * retained either way, so a skipped apply is always recoverable by hand.
 */

export class ApplyError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ApplyError";
		this.code = code;
	}
}

export interface AppliedWinner {
	applied: boolean;
	/** Staged tree hash after a successful apply (equals the winner tree). */
	treeHash: string;
	/** Revert command restoring the pre-apply base exactly. */
	revertCommand: string;
}

function git(
	args: string[],
	cwd: string,
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
	return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/**
 * Apply the winner's snapshot commit onto the source worktree as an
 * immediate clean-base compare-and-swap. Throws ApplyError (with the source
 * reset to the base) on any failure; the caller records the failure and keeps
 * the winner branch + worktrees for manual recovery.
 */
export function applyWinnerToSource(options: {
	sourceRepo: string;
	baseCommit: string;
	winnerCommit: string;
	winnerTreeHash: string;
}): AppliedWinner {
	const { sourceRepo, baseCommit, winnerCommit, winnerTreeHash } = options;
	const baseTree = git(["rev-parse", `${baseCommit}^{tree}`], sourceRepo);
	if (baseTree.status !== 0) {
		throw new ApplyError("base-missing", `base commit ${baseCommit} is gone from ${sourceRepo}: ${baseTree.stderr}`);
	}
	// Compare-and-swap precondition: the source must still sit exactly at the
	// recorded base commit with a clean tree (tracked, staged, and untracked
	// non-ignored files all count as drift — they would be overwritten or
	// tangled with the winner's changes).
	const head = git(["rev-parse", "HEAD"], sourceRepo);
	if (head.status !== 0 || head.stdout !== baseCommit) {
		throw new ApplyError(
			"source-drift",
			`source HEAD moved to ${head.stdout || "(unknown)"} (recorded base ${baseCommit}); the winner was not applied`,
		);
	}
	const status = git(["status", "--porcelain"], sourceRepo);
	if (status.status !== 0 || status.stdout.length > 0) {
		const lines = status.stdout.split("\n").filter(Boolean);
		const shown = lines.slice(0, 5).map((line) => `  ${line}`);
		const more = lines.length > 5 ? `\n  (and ${lines.length - 5} more)` : "";
		throw new ApplyError(
			"source-drift",
			`source tree is no longer clean at the recorded base:\n${shown.join("\n")}${more}\nthe winner was not applied`,
		);
	}

	const picked = git(["cherry-pick", "--no-commit", winnerCommit], sourceRepo);
	if (picked.status !== 0) {
		resetToBase(sourceRepo, baseCommit);
		throw new ApplyError(
			"apply-conflict",
			`git cherry-pick --no-commit ${winnerCommit} failed:\n${picked.stderr || picked.stdout}\nThe source was reset to ${baseCommit}; nothing was applied`,
		);
	}

	const check = git(["diff", "--check", "--cached"], sourceRepo);
	if (check.status !== 0 || check.stdout.length > 0) {
		const detail = check.stdout || check.stderr;
		resetToBase(sourceRepo, baseCommit);
		throw new ApplyError(
			"diff-check",
			`git diff --check rejected the applied changes${detail ? `:\n${detail}` : ""}\nThe source was reset to ${baseCommit}; nothing was applied`,
		);
	}

	const staged = git(["write-tree"], sourceRepo);
	if (staged.status !== 0 || staged.stdout !== winnerTreeHash) {
		const actual = staged.stdout || "(unknown)";
		resetToBase(sourceRepo, baseCommit);
		throw new ApplyError(
			"tree-mismatch",
			`applied tree ${actual} does not match the winner snapshot tree ${winnerTreeHash}\nThe source was reset to ${baseCommit}; nothing was applied`,
		);
	}

	return { applied: true, treeHash: staged.stdout, revertCommand: `git reset --hard ${baseCommit}` };
}

/** Roll the source index and worktree back to the recorded base (transaction reset). */
function resetToBase(sourceRepo: string, baseCommit: string): void {
	git(["cherry-pick", "--abort"], sourceRepo); // clear a half-open sequencer state, if any
	git(["reset", "--hard", baseCommit], sourceRepo);
	git(["clean", "-ffd"], sourceRepo);
}

/** Remove the run's candidate worktree directories; internal branches/commits are retained. */
export function cleanupRunWorktrees(runId: string, sourceRepo: string, worktreePaths: string[]): void {
	const worktrees: CandidateWorktree[] = worktreePaths.map((path, i) => ({
		runId,
		index: i + 1,
		repoRoot: sourceRepo,
		path,
		branch: candidateWorktreeBranchName(runId, i + 1),
		baseCommit: "",
	}));
	// `baseCommit` is snapshot-only metadata; removal needs just the path.
	cleanupCandidateWorktrees(worktrees);
}
