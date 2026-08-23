import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Candidate worktree lifecycle for verified fan-out.
 *
 * Every candidate runs in a real git worktree created as a sibling of the
 * source repo (`<repo>-vf-<runid>-w<i>`), branched from the recorded clean
 * base commit. A dirty or non-Git source fails closed before any candidate
 * launches. Each candidate's tracked + untracked (but NOT gitignored) changes
 * are snapshotted into an internal commit on a dedicated branch; worktree
 * directories are removed after successful selection while the internal
 * branches/commits are retained for audit and runner-up recovery.
 */

export class WorktreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeError";
	}
}

/** Clean-source gate result: the repo root and the recorded base commit. */
export interface WorktreePreflight {
	repoRoot: string;
	baseCommit: string;
}

export interface CandidateWorktree {
	runId: string;
	/** 1-based candidate index. */
	index: number;
	/** Absolute path of the source repo root (not the candidate worktree). */
	repoRoot: string;
	/** Absolute path of the candidate worktree directory. */
	path: string;
	/** Internal audit branch checked out in the worktree. */
	branch: string;
	baseCommit: string;
}

export interface CandidateSnapshot {
	worktree: CandidateWorktree;
	/** Internal snapshot commit (on the worktree's audit branch). */
	commit: string;
	/** Tree hash of the snapshot commit — the candidate's content identity. */
	treeHash: string;
	/** Tree hash of the recorded base commit. */
	baseTreeHash: string;
	/** False when the candidate produced a tree identical to the base. */
	changed: boolean;
}

const SNAPSHOT_IDENTITY = [
	["user.name", "pi-subagents"],
	["user.email", "pi-subagents@localhost"],
] as const;

function gitRaw(
	args: string[],
	cwd: string,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error ?? undefined,
	};
}

function gitOk(args: string[], cwd: string): boolean {
	const r = gitRaw(args, cwd);
	return r.status === 0;
}

function gitText(args: string[], cwd: string): string {
	const r = gitRaw(args, cwd);
	if (r.error) {
		const code = (r.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new WorktreeError(
				"git executable not found on PATH — verified fan-out requires git (Linux/macOS only).",
			);
		}
		throw new WorktreeError(`git ${args[0]} could not start: ${r.error.message}`);
	}
	if (r.status !== 0) {
		const detail = `${r.stderr.trim() || r.stdout.trim()}`;
		throw new WorktreeError(`git ${args.join(" ")} failed (exit ${r.status}) in ${cwd}${detail ? `: ${detail}` : ""}`);
	}
	return r.stdout;
}

/**
 * Fail-closed source gate: the source worktree must sit inside a Git repo
 * with at least one commit and a clean state (tracked, staged, and
 * untracked-but-not-ignored files all count as dirty; gitignored files do
 * not, because they are never captured by candidate snapshots).
 */
export function preflightWorktreeSource(cwd: string): WorktreePreflight {
	const inside = gitRaw(["rev-parse", "--is-inside-work-tree"], cwd);
	if (inside.error) {
		const code = (inside.error as NodeJS.ErrnoException).code;
		throw new WorktreeError(
			code === "ENOENT"
				? "git executable not found on PATH — verified fan-out requires git (Linux/macOS only)."
				: `git could not start: ${inside.error.message}`,
		);
	}
	if (inside.status !== 0) {
		throw new WorktreeError(
			`verified fan-out requires a Git repository, but ${cwd} is not inside one; ` +
				"dirty or non-Git sources fail closed before any candidate spend",
		);
	}
	const repoRoot = gitText(["rev-parse", "--show-toplevel"], cwd).trim();
	if (!gitOk(["rev-parse", "--verify", "HEAD"], repoRoot)) {
		throw new WorktreeError(
			`verified fan-out requires a repository with at least one commit; ${repoRoot} has an unborn HEAD`,
		);
	}
	const baseCommit = gitText(["rev-parse", "HEAD"], repoRoot).trim();
	const status = gitText(["status", "--porcelain"], repoRoot).trim();
	if (status) {
		const lines = status.split("\n");
		const shown = lines.slice(0, 5).map((line) => `  ${line}`);
		const more = lines.length > 5 ? `\n  (and ${lines.length - 5} more)` : "";
		throw new WorktreeError(
			`verified fan-out requires a clean source tree, but ${repoRoot} is dirty:\n${shown.join("\n")}${more}\n` +
				"Commit or stash the changes first; dirty sources fail closed before any candidate spend.",
		);
	}
	return { repoRoot, baseCommit };
}

/**
 * Ref-safe run id: strips the leading `vf-` added by newRunId() so the
 * rendered name matches `<repo>-vf-<runid>-w<i>` with exactly one `vf-`,
 * then replaces characters that are invalid in ref names.
 */
function refSafeRunId(runId: string): string {
	const id = runId.replace(/^vf-/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
	const safe = id.replace(/^[.-]+/, "").replace(/\.lock$/, "");
	return safe || "run";
}

export function candidateWorktreeDirName(repoRoot: string, runId: string, index: number): string {
	return `${basename(repoRoot)}-vf-${refSafeRunId(runId)}-w${index}`;
}

export function candidateWorktreeBranchName(runId: string, index: number): string {
	return `vf/${refSafeRunId(runId)}/w${index}`;
}

/**
 * Create one worktree per candidate as siblings of the source repo, each on
 * its own internal branch at the recorded base commit. Creation is
 * all-or-nothing: if any worktree fails, every worktree created for this run
 * is rolled back before the error propagates.
 */
export function createCandidateWorktrees(options: {
	cwd: string;
	runId: string;
	count: number;
	preflight?: WorktreePreflight;
}): CandidateWorktree[] {
	if (!Number.isInteger(options.count) || options.count < 1) {
		throw new WorktreeError(`candidate count must be an integer >= 1, got ${options.count}`);
	}
	const preflight = options.preflight ?? preflightWorktreeSource(options.cwd);
	const parent = dirname(preflight.repoRoot);
	const created: CandidateWorktree[] = [];
	for (let index = 1; index <= options.count; index++) {
		const worktree: CandidateWorktree = {
			runId: options.runId,
			index,
			repoRoot: preflight.repoRoot,
			path: join(parent, candidateWorktreeDirName(preflight.repoRoot, options.runId, index)),
			branch: candidateWorktreeBranchName(options.runId, index),
			baseCommit: preflight.baseCommit,
		};
		try {
			gitText(["worktree", "add", "-b", worktree.branch, worktree.path, preflight.baseCommit], preflight.repoRoot);
		} catch (error) {
			rollbackWorktrees(created, options.runId, options.count);
			throw new WorktreeError(
				`failed to create candidate worktree ${index} for run ${options.runId} (${error instanceof Error ? error.message : String(error)}); ` +
					`rolled back ${created.length} worktree${created.length === 1 ? "" : "s"} created for this run`,
			);
		}
		created.push(worktree);
	}
	return created;
}

/**
 * All-or-nothing rollback: remove every worktree directory created for this
 * run and delete the run's branch refs. `git worktree add -b` creates the
 * branch ref before it copies files, so a failed add can leave a stray branch
 * even for the index that never materialized; deleting by run-scoped names
 * (fresh run ids are unique) cleans both cases.
 */
function rollbackWorktrees(created: CandidateWorktree[], runId: string, count: number): void {
	for (const worktree of created) {
		if (existsSync(worktree.path)) rmSync(worktree.path, { recursive: true, force: true });
	}
	if (created.length > 0) {
		const repoRoot = created[0].repoRoot;
		gitOk(["worktree", "prune"], repoRoot);
		for (let index = 1; index <= count; index++) {
			gitOk(["branch", "-D", candidateWorktreeBranchName(runId, index)], repoRoot);
		}
	}
}

/**
 * Snapshot a settled candidate's tracked + untracked changes (gitignored
 * files excluded) into an internal commit on its audit branch. The commit is
 * bookkeeping: user hooks are not run and signing is disabled so a repo's
 * local configuration cannot alter or block the snapshot. An untouched
 * worktree reuses HEAD as its snapshot — the tree hash then equals the base
 * tree, which later lets identical candidates collapse cleanly and keeps the
 * snapshot idempotent across verification retries (an empty-diff commit would
 * cherry-pick nothing and fail the apply gate's tree-equality check).
 */
export function snapshotCandidateWorktree(worktree: CandidateWorktree, message?: string): CandidateSnapshot {
	const baseTreeHash = gitText(["rev-parse", `${worktree.baseCommit}^{tree}`], worktree.path).trim();
	gitText(["add", "-A"], worktree.path);
	// Idempotent: if HEAD already carries exactly this tree (an untouched
	// candidate, or a re-settle after a halted selection retried its
	// verification), reuse it instead of stacking an empty-diff commit — the
	// apply gate cherry-picks this commit, and an empty-diff commit would
	// cherry-pick nothing onto the base and fail the tree-equality check.
	const stagedTree = gitText(["write-tree"], worktree.path).trim();
	const headTree = gitText(["rev-parse", "HEAD^{tree}"], worktree.path).trim();
	if (stagedTree === headTree) {
		const commit = gitText(["rev-parse", "HEAD"], worktree.path).trim();
		return { worktree, commit, treeHash: stagedTree, baseTreeHash, changed: stagedTree !== baseTreeHash };
	}
	const configArgs = [
		...SNAPSHOT_IDENTITY.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"commit.gpgsign=false",
	];
	gitText(
		[
			...configArgs,
			"commit",
			"-m",
			message ?? `vf(${worktree.runId}) candidate w${worktree.index} snapshot`,
		],
		worktree.path,
	);
	const commit = gitText(["rev-parse", "HEAD"], worktree.path).trim();
	const treeHash = gitText(["rev-parse", "HEAD^{tree}"], worktree.path).trim();
	return { worktree, commit, treeHash, baseTreeHash, changed: treeHash !== baseTreeHash };
}

/**
 * Remove one candidate worktree directory while keeping its internal branch
 * and snapshot commit. `--force` is correct here: by this point the snapshot
 * already captured everything retained (ignored files such as node_modules
 * are deliberately not kept).
 */
export function removeCandidateWorktree(worktree: CandidateWorktree): void {
	if (existsSync(worktree.path)) {
		const removed = gitOk(["worktree", "remove", "--force", worktree.path], worktree.repoRoot);
		if (!removed && existsSync(worktree.path)) {
			rmSync(worktree.path, { recursive: true, force: true });
		}
	}
	gitOk(["worktree", "prune"], worktree.repoRoot);
	if (existsSync(worktree.path)) {
		throw new WorktreeError(`failed to remove candidate worktree ${worktree.path}`);
	}
}

export function cleanupCandidateWorktrees(worktrees: CandidateWorktree[]): void {
	for (const worktree of worktrees) removeCandidateWorktree(worktree);
}
