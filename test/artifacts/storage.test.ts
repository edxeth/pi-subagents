import {
	after,
	assert,
	before,
	beforeEach,
	buildChildContextBoundaryForTest,
	buildChildContextBoundarySystemPromptForTest,
	createTestDir,
	describe,
	existsSync,
	getArtifactProjectName,
	getArtifactStorageRoot,
	getProjectArtifactsDir,
	getSessionArtifactDir,
	homedir,
	it,
	join,
	mkdirSync,
	mkdtempSync,
	resolveArtifactProjectRoot,
	resolveSessionArtifactPath,
	rmSync,
	writeFileSync,
} from "../support/index.ts";

describe("artifact storage", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	beforeEach(() => {
		delete process.env.PI_ARTIFACT_PROJECT_ROOT;
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("uses PI_ARTIFACT_PROJECT_ROOT as the artifact storage root when set", () => {
		const explicitRoot = join(dir, "explicit-root");
		mkdirSync(explicitRoot, { recursive: true });
		process.env.PI_ARTIFACT_PROJECT_ROOT = explicitRoot;

		assert.equal(getArtifactStorageRoot(), explicitRoot);
	});

	it("finds the nearest package root when no git root exists", () => {
		const pkgRoot = join(dir, "pkg-root");
		const nested = join(pkgRoot, "src", "feature");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(pkgRoot, "package.json"), "{}");

		assert.equal(resolveArtifactProjectRoot(nested), pkgRoot);
	});

	it("prefers a git root over package.json roots", () => {
		const gitRoot = join(dir, "git-root");
		const pkgRoot = join(gitRoot, "packages", "feature");
		const nested = join(pkgRoot, "src");
		mkdirSync(join(gitRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(pkgRoot, "package.json"), "{}");

		assert.equal(resolveArtifactProjectRoot(nested), gitRoot);
	});

	it("falls back to the cwd when no markers exist", () => {
		const base = existsSync("/dev/shm") ? mkdtempSync(join("/dev/shm", "subagents-test-")) : join(dir, "plain-root");
		const plain = join(base, "plain", "folder");
		try {
			mkdirSync(plain, { recursive: true });

			assert.equal(resolveArtifactProjectRoot(plain), plain);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("builds project and session artifact paths from the storage root and repo root", () => {
		const projectRoot = join(dir, "artifact-project");
		const nested = join(projectRoot, "src");
		mkdirSync(join(projectRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		assert.equal(getArtifactProjectName(nested), "artifact-project");
		assert.equal(getArtifactStorageRoot(), join(homedir(), ".pi", "history"));
		assert.equal(getProjectArtifactsDir(nested), join(homedir(), ".pi", "history", "artifact-project", "artifacts"));
		assert.equal(
			getSessionArtifactDir(nested, "session-123"),
			join(homedir(), ".pi", "history", "artifact-project", "artifacts", "session-123"),
		);
		assert.equal(
			resolveSessionArtifactPath(nested, "session-123", "context/notes.md"),
			join(homedir(), ".pi", "history", "artifact-project", "artifacts", "session-123", "context/notes.md"),
		);
	});

	it("keeps the repo-derived project name when PI_ARTIFACT_PROJECT_ROOT is set", () => {
		const projectRoot = join(dir, "real-project");
		const nested = join(projectRoot, "src");
		const explicitRoot = join(dir, "custom-history-root");
		mkdirSync(join(projectRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		mkdirSync(explicitRoot, { recursive: true });
		process.env.PI_ARTIFACT_PROJECT_ROOT = explicitRoot;

		assert.equal(getArtifactProjectName(nested), "real-project");
		assert.equal(getProjectArtifactsDir(nested), join(explicitRoot, "real-project", "artifacts"));
	});
});

describe("child context boundary", () => {
	it("describes fork handoff placement and non-spawning behavior", () => {
		const boundary = buildChildContextBoundaryForTest({
			name: "greeter",
			spawningAllowed: false,
		});
		assert.match(boundary, /<subagent-boundary>/);
		assert.match(
			boundary,
			/Everything before this message was inherited from the parent Pi session as background context\./,
		);
		assert.match(
			boundary,
			/Do not treat messages before this boundary as your current role, task, or available tool set\./,
		);
		assert.match(boundary, /child subagent named "greeter"/);
		assert.match(boundary, /Subagent-spawning tools are not available in this child session\./);
		assert.match(boundary, /Your active assignment is the next user message from the parent\./);
	});

	it("describes spawning-enabled behavior without claiming tools always exist", () => {
		const boundary = buildChildContextBoundaryForTest({
			name: "coordinator",
			spawningAllowed: true,
			spawnableAgents: ["scout", "reviewer"],
			spawnBudget: 2,
			spawnWidth: 3,
		});
		assert.match(boundary, /Subagent-spawning tools may be available in this child session\./);
		assert.match(
			boundary,
			/Use them only if they are actually available to you and your active assignment requires delegation\./,
		);
		assert.match(
			boundary,
			/You may spawn only these agents: scout, reviewer\. Remaining nested spawn budget: 2\. Max concurrent children: 3\./,
		);
		const unrestricted = buildChildContextBoundaryForTest({
			name: "root-coordinator",
			spawningAllowed: true,
			spawnableAgents: true,
			spawnBudget: 1,
			spawnWidth: 4,
		});
		assert.match(unrestricted, /You may spawn any agent\./);
		const denied = buildChildContextBoundaryForTest({
			name: "worker",
			spawningAllowed: false,
			spawnableAgents: [],
			spawnBudget: null,
			spawnWidth: null,
		});
		assert.doesNotMatch(denied, /You may spawn/);
	});

	it("uses a small system prompt pointer to the boundary tag", () => {
		assert.equal(
			buildChildContextBoundarySystemPromptForTest(),
			"If this session contains a <subagent-boundary> message, treat it as the handoff point from inherited parent context to your active child-subagent task. Follow that boundary message when interpreting prior context and the next user task.",
		);
	});
});
