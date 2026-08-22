import {
	afterEach,
	assert,
	createTestDir,
	describe,
	getAgentListEntriesForTest,
	getAgentListSignatureForTest,
	it,
	join,
	loadAgentDefaults,
	mkdirSync,
	renderAgentListReminderForTest,
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

function writeRosterAgents(markTester: boolean) {
	const dir = createTestDir();
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(
		join(agentsDir, "tester.md"),
		`---\nname: tester\ndescription: Does verified work\n${
			markTester ? "llm-as-a-verifier: true\n" : ""
		}---\n\nTester body.`,
	);
	writeFileSync(
		join(agentsDir, "plain.md"),
		`---\nname: plain\ndescription: Does ordinary work\n---\n\nPlain body.`,
	);
	return dir;
}

describe("llm-as-a-verifier field", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("marks a definition verified only on an explicit true", () => {
		assert.equal(loadDefinition("llm-as-a-verifier: true")?.llmAsVerifier, true);
		assert.equal(loadDefinition("llm-as-a-verifier: false")?.llmAsVerifier, false);
		assert.equal(loadDefinition("model: provider/model")?.llmAsVerifier, undefined);
	});

	it("rejects an integer or any non-boolean value instead of guessing a count", () => {
		for (const bad of ["3", "5", "0", "1", "yes", "no", "True", "true-ish", ""]) {
			assert.throws(
				() => loadDefinition(`llm-as-a-verifier: ${bad}`),
				/llm-as-a-verifier must be "true" or "false"/,
			);
		}
	});

	it("keeps the sibling fields from flipping the boolean marker", () => {
		// Ticket 10 parses the siblings into their own fields; none of them may
		// set the boolean, which stays true/false only.
		const defs = loadDefinition(
			"llm-as-a-verifier-candidates: 5\nllm-as-a-verifier-model: provider/model\nllm-as-a-verifier-criteria: code-change",
		);
		assert.equal(defs?.llmAsVerifier, undefined);
		assert.equal(defs?.llmAsVerifierCandidates, 5);
		const marked = loadDefinition("llm-as-a-verifier: true\nllm-as-a-verifier-candidates: 5");
		assert.equal(marked?.llmAsVerifier, true);
		assert.equal(marked?.llmAsVerifierCandidates, 5);
	});

	it("surfaces a verified marker in the ambient roster only for marked definitions", () => {
		writeRosterAgents(true);
		const entries = getAgentListEntriesForTest("/tmp");
		const tester = entries.find((entry) => entry.name === "tester");
		const plain = entries.find((entry) => entry.name === "plain");
		assert.equal(tester?.llmAsVerifier, true);
		assert.equal(plain?.llmAsVerifier, undefined);

		const reminder = renderAgentListReminderForTest(entries);
		const plainBlock = reminder.match(/- `plain`: Do(?:.|\n)*?(?=\n\n- `|<\/subagent-roster>)/)?.[0] ?? "";
		assert.match(reminder, /- `tester`: Does verified work\n(?:[^\n]*\n)* {2}verified-fan-out: true/);
		assert.ok(!plainBlock.includes("verified-fan-out"), `plain block must not carry the marker:\n${plainBlock}`);
		assert.match(reminder, /`verified-fan-out: true` means one launch/);
		assert.ok(JSON.stringify(getAgentListSignatureForTest(entries)).includes("llmAsVerifier"));

		writeRosterAgents(false);
		const unmarked = renderAgentListReminderForTest(getAgentListEntriesForTest("/tmp"));
		assert.doesNotMatch(unmarked, /verified-fan-out/);
		assert.ok(!JSON.stringify(getAgentListSignatureForTest(getAgentListEntriesForTest("/tmp"))).includes("llmAsVerifier"));
	});
});
