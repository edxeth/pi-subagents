import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	getBaseSubagentEnvVarsForTest,
	loadAgentDefaults,
	parseEnvStringForTest,
	readSubagentLaunchMetadataForTest,
	resetSubagentStateForTest,
	resolveSubagentRuntimePathsForTest,
	writeSubagentLaunchMetadataEntryForTest,
	createTestDir,
} from "../support/index.ts";

describe("env frontmatter field", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("parses block KEY=VALUE pairs without splitting commas or equals in values", () => {
		assert.deepEqual(parseEnvStringForTest("FOO=bar\nBAZ=qux"), { FOO: "bar", BAZ: "qux" });
		assert.deepEqual(parseEnvStringForTest("FOO=value,with,commas\nTOKEN=a=b=c"), {
			FOO: "value,with,commas",
			TOKEN: "a=b=c",
		});
		assert.deepEqual(parseEnvStringForTest(undefined), {});
		assert.deepEqual(parseEnvStringForTest(""), {});
		assert.deepEqual(parseEnvStringForTest("  "), {});
	});

	it("rejects malformed env key=value pairs", () => {
		assert.throws(() => parseEnvStringForTest("=bar"), /Empty env key/);
		assert.throws(() => parseEnvStringForTest("FOO"), /Missing '='/);
	});

	it("parses block env from agent frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "config");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "explorer.md"),
			`---\nname: explorer\nenv: |\n  FOO=bar\n  BAZ=value,with,commas\n---\n\nExplorer body.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("explorer");
		assert.equal(defs?.env, "FOO=bar\nBAZ=value,with,commas");

		process.env.PI_CODING_AGENT_DIR = "/tmp";
	});

	it("merges env vars into base subagent env vars", () => {
		const env = getBaseSubagentEnvVarsForTest({
			env: "FOO=bar\nBAZ=value,with,commas",
		});
		assert.equal(env["FOO"], "bar");
		assert.equal(env["BAZ"], "value,with,commas");
		assert.equal(typeof env.PI_SUBAGENT_NAME, "string");
		assert.equal(env.PI_PACKAGE_DIR, "");
	});

	it("uses env PI_CODING_AGENT_DIR as the child config and session root", () => {
		const dir = createTestDir();
		const parentSessionDir = join(dir, "parent-sessions");
		const childConfigDir = join(dir, "child-agent");
		mkdirSync(childConfigDir, { recursive: true });

		const paths = resolveSubagentRuntimePathsForTest(
			{},
			{ env: `PI_CODING_AGENT_DIR=${childConfigDir}` },
			dir,
			parentSessionDir,
		);

		assert.equal(paths.localAgentConfigDir, childConfigDir);
		assert.equal(paths.effectiveAgentConfigDir, childConfigDir);
		assert.equal(paths.sessionDir, join(childConfigDir, "sessions", `--${dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`));
	});

	it("returns empty env record when no env field is set", () => {
		const env = getBaseSubagentEnvVarsForTest(null);
		assert.equal(env["FOO"], undefined);
	});

	it("persists env in launch metadata", async () => {
		const dir = createTestDir();
		const child = join(dir, "child.jsonl");
		await writeSubagentLaunchMetadataEntryForTest(child, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "env-child",
			mode: "background",
			sessionMode: "lineage-only",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: true,
			env: "FOO=bar,BAZ=qux",
		});
		const metadata = readSubagentLaunchMetadataForTest(child);
		assert.equal(metadata?.env, "FOO=bar,BAZ=qux");
	});

	it("does not let user env override internal PI_SUBAGENT_NAME", () => {
		const env = getBaseSubagentEnvVarsForTest({
			env: "PI_SUBAGENT_NAME=evil",
		});
		assert.notEqual(env.PI_SUBAGENT_NAME, "evil");
		assert.equal(typeof env.PI_SUBAGENT_NAME, "string");
	});
});
