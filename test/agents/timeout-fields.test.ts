import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	loadAgentDefaults,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function loadDefinition(frontmatter: string) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	writeFileSync(join(configDir, "agents", "tester.md"), `---\nname: tester\n${frontmatter}\n---\n\nTester body.`);
	process.env.PI_CODING_AGENT_DIR = configDir;
	return loadAgentDefaults("tester");
}

describe("timeout agent fields", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("leaves both budgets unset when the agent configures neither", () => {
		const defs = loadDefinition("model: provider/model");
		assert.equal(defs?.timeout, undefined);
		assert.equal(defs?.idleTimeout, undefined);
	});

	it("reads each budget independently, in whole seconds", () => {
		assert.equal(loadDefinition("timeout: 900")?.timeout, 900);
		assert.equal(loadDefinition("timeout: 900")?.idleTimeout, undefined);
		assert.equal(loadDefinition("idle-timeout: 180")?.idleTimeout, 180);
		assert.equal(loadDefinition("idle-timeout: 180")?.timeout, undefined);
		const both = loadDefinition("timeout: 900\nidle-timeout: 180");
		assert.equal(both?.timeout, 900);
		assert.equal(both?.idleTimeout, 180);
	});

	it("rejects a malformed budget instead of silently running unbounded", () => {
		for (const bad of ["0", "-30", "30s", "5m", "1.5", "", "none"]) {
			assert.throws(() => loadDefinition(`timeout: ${bad}`), /timeout must be a positive safe integer/);
			assert.throws(() => loadDefinition(`idle-timeout: ${bad}`), /idle-timeout must be a positive safe integer/);
		}
	});

	it("keeps the warn threshold raw for the child to resolve", () => {
		assert.equal(loadDefinition("timeout-warn-threshold: 80%")?.timeoutWarnThreshold, "80%");
		assert.equal(loadDefinition("timeout-warn-threshold: true")?.timeoutWarnThreshold, "true");
		assert.equal(loadDefinition("model: provider/model")?.timeoutWarnThreshold, undefined);
	});

	it("reads on-timeout only for the two policies it defines", () => {
		assert.equal(loadDefinition("on-timeout: block-resume")?.onTimeout, "block-resume");
		assert.equal(loadDefinition("on-timeout: report")?.onTimeout, "report");
		assert.equal(loadDefinition("model: provider/model")?.onTimeout, undefined);
	});

	it("rejects an unrecognised on-timeout instead of taking the permissive default", () => {
		// Failing open here would re-enable resume for exactly the agent that
		// asked to be protected from a second partial run.
		for (const bad of ["kill-parent", "block", "true", ""]) {
			assert.throws(
				() => loadDefinition(`on-timeout: ${bad}`),
				/on-timeout must be "report" or "block-resume"/,
			);
		}
	});
});
