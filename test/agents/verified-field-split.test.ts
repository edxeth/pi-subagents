import { afterEach } from "node:test";
import {
	assert,
	createTestDir,
	describe,
	getAgentListEntriesForTest,
	it,
	join,
	loadAgentDefaults,
	mkdirSync,
	renderAgentListReminderForTest,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";
import { VERIFIER_CANDIDATES_ENV_VAR } from "../../src/vf/criteria.ts";

function loadDefinition(frontmatter: string) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	writeFileSync(join(configDir, "agents", "tester.md"), `---\nname: tester\n${frontmatter}\n---\n\nTester body.`);
	process.env.PI_CODING_AGENT_DIR = configDir;
	return loadAgentDefaults("tester");
}

function writeRosterAgent(frontmatter: string): void {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	mkdirSync(join(configDir, "agents"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(
		join(configDir, "agents", "tester.md"),
		`---\nname: tester\ndescription: Does verified work\n${frontmatter}\n---\n\nTester body.`,
	);
}

function rosterTesterBlock(): string {
	const entries = getAgentListEntriesForTest("/tmp");
	const reminder = renderAgentListReminderForTest(entries);
	return reminder.match(/- `tester`: Do(?:.|\n)*?(?=\n\n- `|<\/subagent-roster>)/)?.[0] ?? "";
}

describe("llm-as-a-verifier field split (candidates/model/criteria)", () => {
	afterEach(() => {
		delete process.env[VERIFIER_CANDIDATES_ENV_VAR];
		resetSubagentStateForTest();
	});

	it("parses an explicit candidate count >= 2 on its own sibling field", () => {
		assert.equal(
			loadDefinition("llm-as-a-verifier: true\nllm-as-a-verifier-candidates: 2")?.llmAsVerifierCandidates,
			2,
		);
		assert.equal(loadDefinition("llm-as-a-verifier-candidates: 5")?.llmAsVerifierCandidates, 5);
	});

	it("rejects candidate counts below 2 or not plain integers", () => {
		for (const bad of ["1", "0", "-2", "2.5", "three", ""]) {
			assert.throws(
				() => loadDefinition(`llm-as-a-verifier-candidates: ${bad}`),
				/llm-as-a-verifier-candidates must be an integer >= 2/,
			);
		}
	});

	it("canonicalizes a valid model override and rejects unparseable refs at load", () => {
		assert.equal(
			loadDefinition("llm-as-a-verifier-model: deepseek/deepseek-v4-flash:high")?.llmAsVerifierModel,
			"deepseek/deepseek-v4-flash:high",
		);
		assert.equal(loadDefinition("llm-as-a-verifier-model: deepseek-v4-flash")?.llmAsVerifierModel, "deepseek-v4-flash");
		for (const bad of ["deepseek/deepseek-v4-flash/extra", "deepseek/", "/model", "provider/model:ultra", ""]) {
			assert.throws(() => loadDefinition(`llm-as-a-verifier-model: ${bad}`), /llm-as-a-verifier-model/);
		}
	});

	it("stores the criteria value verbatim and rejects an empty one", () => {
		assert.equal(loadDefinition("llm-as-a-verifier-criteria: research")?.llmAsVerifierCriteria, "research");
		assert.equal(loadDefinition("llm-as-a-verifier-criteria: /abs/rubric.md")?.llmAsVerifierCriteria, "/abs/rubric.md");
		assert.throws(() => loadDefinition("llm-as-a-verifier-criteria:"), /llm-as-a-verifier-criteria/);
	});

	it("keeps the boolean and the siblings independent", () => {
		const both = loadDefinition(
			[
				"llm-as-a-verifier: true",
				"llm-as-a-verifier-candidates: 4",
				"llm-as-a-verifier-model: deepseek/deepseek-v4-flash",
				"llm-as-a-verifier-criteria: code-change",
			].join("\n"),
		);
		assert.equal(both?.llmAsVerifier, true);
		assert.equal(both?.llmAsVerifierCandidates, 4);
		assert.equal(both?.llmAsVerifierModel, "deepseek/deepseek-v4-flash");
		assert.equal(both?.llmAsVerifierCriteria, "code-change");
	});

	it("renders the resolved candidate count in the roster line", () => {
		writeRosterAgent("llm-as-a-verifier: true\nllm-as-a-verifier-candidates: 5");
		assert.match(rosterTesterBlock(), /verified-fan-out: true \(5 candidates\)/);

		writeRosterAgent("llm-as-a-verifier: true");
		assert.match(rosterTesterBlock(), /verified-fan-out: true \(3 candidates\)/);

		process.env[VERIFIER_CANDIDATES_ENV_VAR] = "4";
		assert.match(rosterTesterBlock(), /verified-fan-out: true \(4 candidates\)/);

		process.env[VERIFIER_CANDIDATES_ENV_VAR] = "1";
		const block = rosterTesterBlock();
		assert.match(block, /verified-fan-out: true \(/);
		assert.match(block, new RegExp(VERIFIER_CANDIDATES_ENV_VAR));
	});
});
