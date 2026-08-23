import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assert, createTestDir, join } from "../support/index.ts";
import {
	candidateWorktreeBranchName,
	candidateWorktreeDirName,
	cleanupCandidateWorktrees,
	createCandidateWorktrees,
	preflightWorktreeSource,
	snapshotCandidateWorktree,
	WorktreeError,
} from "../../src/vf/worktrees.ts";

function gitOut(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
	}
	return result.stdout;
}

const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@localhost"];

/** Repo at <outer>/repo so candidate worktrees land as siblings inside <outer>. */
function makeRepo(outer: string): { repoRoot: string; baseCommit: string } {
	const repoRoot = join(outer, "repo");
	mkdirSync(repoRoot, { recursive: true });
	gitOut(["init", "--initial-branch=main"], repoRoot);
	writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n*.env\n");
	writeFileSync(join(repoRoot, "a.txt"), "alpha\n");
	gitOut([...IDENTITY, "add", "-A"], repoRoot);
	gitOut([...IDENTITY, "commit", "-m", "base"], repoRoot);
	return { repoRoot, baseCommit: gitOut(["rev-parse", "HEAD"], repoRoot).trim() };
}

describe("worktree preflight gate", () => {
	it("names the real cause when git is not on PATH", () => {
		const plainDir = createTestDir();
		const savedPath = process.env.PATH;
		process.env.PATH = join(plainDir, "no-git-here");
		try {
			assert.throws(
				() => preflightWorktreeSource(plainDir),
				(error: unknown) => {
					assert.ok(error instanceof WorktreeError);
					// A missing executable must not masquerade as "not a repo".
					assert.match(error.message, /git executable not found on PATH/);
					assert.doesNotMatch(error.message, /not inside one/);
					return true;
				},
			);
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("fails closed outside a git repository", () => {
		const plainDir = createTestDir();
		assert.throws(
			() => preflightWorktreeSource(plainDir),
			(error: unknown) => {
				assert.ok(error instanceof WorktreeError);
				assert.match(error.message, /not inside one/);
				return true;
			},
		);
		assert.throws(
			() => createCandidateWorktrees({ cwd: plainDir, runId: "vf-t1-aaaa1111", count: 2 }),
			WorktreeError,
		);
	});

	it("fails closed on a dirty tracked file, before any worktree exists", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		writeFileSync(join(repoRoot, "a.txt"), "modified\n");
		assert.throws(
			() => preflightWorktreeSource(repoRoot),
			(error: unknown) => {
				assert.ok(error instanceof WorktreeError);
				assert.match(error.message, /dirty/);
				assert.match(error.message, /a\.txt/);
				return true;
			},
		);
		assert.throws(
			() => createCandidateWorktrees({ cwd: repoRoot, runId: "vf-t1-bbbb2222", count: 2 }),
			WorktreeError,
		);
		assert.equal(gitOut(["worktree", "list"], repoRoot).trim().split("\n").length, 1);
		assert.equal(existsSync(join(outer, "repo-vf-t1-bbbb2222-w1")), false);
	});

	it("treats untracked non-ignored files as dirty, but not gitignored ones", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		mkdirSync(join(repoRoot, "node_modules"));
		writeFileSync(join(repoRoot, "node_modules", "pkg.json"), "{}\n");
		writeFileSync(join(repoRoot, "secret.env"), "KEY=1\n");
		assert.equal(preflightWorktreeSource(repoRoot).baseCommit.length, 40);

		writeFileSync(join(repoRoot, "untracked.txt"), "u\n");
		assert.throws(() => preflightWorktreeSource(repoRoot), WorktreeError);
	});

	it("fails closed on an unborn HEAD", () => {
		const outer = createTestDir();
		const repoRoot = join(outer, "empty");
		mkdirSync(repoRoot, { recursive: true });
		gitOut(["init"], repoRoot);
		assert.throws(
			() => preflightWorktreeSource(repoRoot),
			(error: unknown) => {
				assert.ok(error instanceof WorktreeError);
				assert.match(error.message, /unborn HEAD/);
				return true;
			},
		);
	});
});

describe("candidate worktree creation", () => {
	it("names worktrees <repo>-vf-<runid>-w<i> as siblings of the repo, at the base commit", () => {
		const outer = createTestDir();
		const { repoRoot, baseCommit } = makeRepo(outer);
		const runId = "vf-20260822-101530-ab12cd34";
		const worktrees = createCandidateWorktrees({ cwd: repoRoot, runId, count: 3 });

		assert.equal(candidateWorktreeDirName(repoRoot, runId, 1), "repo-vf-20260822-101530-ab12cd34-w1");
		assert.deepEqual(
			worktrees.map((w) => w.path),
			[1, 2, 3].map((i) => join(outer, candidateWorktreeDirName(repoRoot, runId, i))),
		);
		for (const [i, worktree] of worktrees.entries()) {
			assert.ok(existsSync(join(worktree.path, ".git")), `w${i + 1} is a linked worktree`);
			assert.equal(gitOut(["rev-parse", "HEAD"], worktree.path).trim(), baseCommit);
			assert.equal(worktree.branch, candidateWorktreeBranchName(runId, i + 1));
			assert.ok(
				gitOut(["branch", "--list", worktree.branch], repoRoot).includes(worktree.branch),
				`branch ${worktree.branch} exists`,
			);
		}
		assert.equal(gitOut(["worktree", "list"], repoRoot).trim().split("\n").length, 4);
		cleanupCandidateWorktrees(worktrees);
	});

	it("rolls back created worktrees when one fails", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		const runId = "vf-t-rollback-11112222";
		// A non-empty path where w2 would go makes `git worktree add` refuse.
		writeFileSync(join(outer, candidateWorktreeDirName(repoRoot, runId, 2)), "occupied");

		assert.throws(
			() => createCandidateWorktrees({ cwd: repoRoot, runId, count: 3 }),
			(error: unknown) => {
				assert.ok(error instanceof WorktreeError);
				assert.match(error.message, /rolled back 1 worktree/);
				return true;
			},
		);
		assert.equal(existsSync(join(outer, candidateWorktreeDirName(repoRoot, runId, 1))), false);
		assert.equal(gitOut(["worktree", "list"], repoRoot).trim().split("\n").length, 1);
		assert.equal(gitOut(["branch", "--list", "vf/t-rollback-11112222/*"], repoRoot).trim(), "");
	});
});

describe("candidate snapshots", () => {
	it("captures tracked + untracked changes but excludes gitignored files", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		const worktree = createCandidateWorktrees({ cwd: repoRoot, runId: "vf-t-snap-aaaabbbb", count: 1 })[0];

		writeFileSync(join(worktree.path, "a.txt"), "alpha-modified\n");
		writeFileSync(join(worktree.path, "new.txt"), "fresh\n");
		mkdirSync(join(worktree.path, "node_modules"));
		writeFileSync(join(worktree.path, "node_modules", "pkg.json"), "{}\n");
		writeFileSync(join(worktree.path, "secret.env"), "KEY=2\n");

		const snapshot = snapshotCandidateWorktree(worktree);
		assert.equal(snapshot.changed, true);
		assert.notEqual(snapshot.treeHash, snapshot.baseTreeHash);
		assert.equal(readFileSync(join(worktree.path, "a.txt"), "utf8"), "alpha-modified\n");

		const files = gitOut(["ls-tree", "-r", "--name-only", "HEAD"], worktree.path).trim().split("\n");
		assert.ok(files.includes("a.txt"));
		assert.ok(files.includes("new.txt"));
		assert.equal(files.some((f) => f.startsWith("node_modules/")), false);
		assert.equal(files.includes("secret.env"), false);
		// The snapshot commit leaves the worktree clean for removal.
		assert.equal(gitOut(["status", "--porcelain"], worktree.path).trim(), "");
		cleanupCandidateWorktrees([worktree]);
	});

	it("snapshots an untouched worktree as unchanged with the base tree hash", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		const worktree = createCandidateWorktrees({ cwd: repoRoot, runId: "vf-t-same-ccccdddd", count: 1 })[0];
		const snapshot = snapshotCandidateWorktree(worktree);
		assert.equal(snapshot.changed, false);
		assert.equal(snapshot.treeHash, snapshot.baseTreeHash);
		assert.equal(snapshot.commit.length, 40);
		cleanupCandidateWorktrees([worktree]);
	});

	it("does not run user hooks on the internal commit", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		const hook = join(repoRoot, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o755);
		const worktree = createCandidateWorktrees({ cwd: repoRoot, runId: "vf-t-hook-eeeeffff", count: 1 })[0];
		writeFileSync(join(worktree.path, "new.txt"), "x\n");
		const snapshot = snapshotCandidateWorktree(worktree);
		assert.equal(snapshot.changed, true);
		cleanupCandidateWorktrees([worktree]);
	});
});

describe("worktree cleanup", () => {
	it("removes worktree directories but retains internal branches and commits", () => {
		const outer = createTestDir();
		const { repoRoot } = makeRepo(outer);
		const runId = "vf-t-clean-12345678";
		const worktrees = createCandidateWorktrees({ cwd: repoRoot, runId, count: 2 });
		writeFileSync(join(worktrees[0].path, "winner.txt"), "kept\n");
		const snapshot = snapshotCandidateWorktree(worktrees[0]);
		snapshotCandidateWorktree(worktrees[1]);

		cleanupCandidateWorktrees(worktrees);
		cleanupCandidateWorktrees(worktrees); // idempotent

		for (const worktree of worktrees) assert.equal(existsSync(worktree.path), false);
		assert.equal(gitOut(["worktree", "list"], repoRoot).trim().split("\n").length, 1);
		// Internal branches are retained with their snapshot commits.
		assert.equal(gitOut(["rev-parse", worktrees[0].branch], repoRoot).trim(), snapshot.commit);
		assert.match(gitOut(["rev-parse", worktrees[1].branch], repoRoot).trim(), /^[0-9a-f]{40}$/);
		assert.equal(gitOut(["show", `${worktrees[0].branch}:winner.txt`], repoRoot).trim(), "kept");
	});
});
