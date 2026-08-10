import {
	afterEach,
	assert,
	createTestDir,
	describe,
	join,
	loadAgentDefaults,
	mkdirSync,
	resetSubagentStateForTest,
	resolveDenyToolsForTest,
	it,
	writeFileSync,
} from "../support/index.ts";

function loadDefinition(frontmatter: string) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	writeFileSync(
		join(configDir, "agents", "tester.md"),
		`---\nname: tester\n${frontmatter}\n---\n\nTester body.`,
	);
	process.env.PI_CODING_AGENT_DIR = configDir;
	return loadAgentDefaults("tester");
}

describe("spawn-related agent fields", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("parses spawning lists and the true sentinel", () => {
		assert.deepEqual(loadDefinition("spawning: agent-b, , agent-d")?.spawning, ["agent-b", "agent-d"]);
		assert.equal(loadDefinition("spawning: true")?.spawning, true);
		assert.equal(loadDefinition("spawning: false")?.spawning, false);
	});

	it("rejects reserved names in spawning lists", () => {
		for (const reserved of ["root", "all", "true", "false"]) {
			assert.throws(() => loadDefinition(`spawning: agent-a, ${reserved}`), /reserved agent name/);
		}
	});

	it("requires positive integer spawn depth and width", () => {
		assert.throws(() => loadDefinition("spawn-depth: 0"), /spawn-depth.*positive safe integer/);
		assert.throws(() => loadDefinition("spawn-depth: -1"), /spawn-depth.*positive safe integer/);
		assert.throws(() => loadDefinition("spawn-depth: 100000000000000000000"), /spawn-depth.*positive safe integer/);
		assert.throws(() => loadDefinition("spawn-width: 0"), /spawn-width.*positive safe integer/);
		assert.throws(() => loadDefinition("spawn-width: nope"), /spawn-width.*positive safe integer/);
		assert.equal(loadDefinition("spawn-depth: 2\nspawn-width: 3")?.spawnDepth, 2);
		assert.equal(loadDefinition("spawn-depth: 2\nspawn-width: 3")?.spawnWidth, 3);
	});

	it("defaults visible-to to all and does not capture the next line for an empty value", () => {
		const defs = loadDefinition("visible-to:\nmode: background");
		assert.deepEqual(defs?.visibleTo, ["all"]);
		assert.equal(defs?.mode, "background");

		const blockDefs = loadDefinition("visible-to: |\n  root\nmode: background");
		assert.deepEqual(blockDefs?.visibleTo, ["|"]);
		assert.equal(blockDefs?.mode, "background");
	});

	it("rejects mixed visible-to all values and keeps literal suffixes", () => {
		assert.throws(() => loadDefinition("visible-to: all, agent-b"), /visible-to.*all/);
		assert.deepEqual(loadDefinition("visible-to: root, , agent-b")?.visibleTo, ["root", "agent-b"]);
		assert.deepEqual(loadDefinition("spawning: agent-b # comment")?.spawning, ["agent-b # comment"]);
		assert.deepEqual(loadDefinition('spawning: "true"')?.spawning, ['"true"']);
		assert.deepEqual(loadDefinition('visible-to: "all"')?.visibleTo, ['"all"']);
	});

	it("uses the parsed spawning shape for tool denial", () => {
		assert.deepEqual(loadDefinition("spawning: agent-b")?.spawning, ["agent-b"]);
		assert.deepEqual([...resolveDenyToolsForTest({ spawning: ["agent-b"] })], []);
		assert.deepEqual([...resolveDenyToolsForTest({ spawning: false })].sort(), [
			"subagent",
			"subagent_kill",
			"subagent_resume",
		]);
	});
});
