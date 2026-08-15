import { getAgentListEntries, getAgentListSignature, renderAgentListReminder } from "../../src/agents/agent-list.ts";
import { getEffectiveAgentDefinitions } from "../../src/agents/definitions.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

function writeLimitedAgent(dir: string, frontmatter: string): void {
	const configDir = join(dir, "agent-root");
	const agentsDir = join(configDir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = configDir;
	writeFileSync(
		join(agentsDir, "limited.md"),
		`---\nname: limited\ndescription: Limited worker\n${frontmatter}\n---\n\nLimited body.`,
	);
}

function resolveSessionMode(agent: ReturnType<typeof getEffectiveAgentDefinitions>[number]) {
	return agent.sessionMode ?? "lineage-only";
}

function listEntries(dir: string) {
	return getAgentListEntries(dir, resolveSessionMode, { callerAgent: null, callerSpawnable: true });
}

describe("roster limit fields", () => {
	afterEach(() => resetSubagentStateForTest());

	it("renders limit lines and handling rules when the fields are set", () => {
		const dir = createTestDir();
		writeLimitedAgent(
			dir,
			"timeout: 900\nidle-timeout: 180\ncontext-warn-threshold: 80%\ncontext-warn-step: 5%\nreport-context-usage: false",
		);
		const entry = listEntries(dir)[0];
		assert.equal(entry?.timeout, 900);
		assert.equal(entry?.idleTimeout, 180);
		assert.equal(entry?.contextWarnThreshold, "80%");
		assert.equal(entry?.reportContextUsage, false);

		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /timeout: 15m/);
		assert.match(reminder, /idle-timeout: 3m/);
		assert.match(reminder, /context-warn: 80%/);
		assert.match(reminder, /report-context-usage: false/);
		assert.match(reminder, /A stop is not a failure/);
		assert.match(reminder, /wrap up and report before its own context window fills/);
		assert.match(reminder, /Do not resume an agent that stopped this way/);
	});

	it("omits limit lines and handling rules when no agent sets them", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "model: provider/model");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.doesNotMatch(reminder, /timeout:/);
		assert.doesNotMatch(reminder, /idle-timeout:/);
		assert.doesNotMatch(reminder, /context-warn/);
		assert.doesNotMatch(reminder, /report-context-usage/);
		assert.doesNotMatch(reminder, /partial work/);
	});

	it("does not render report-context-usage when true or absent", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "report-context-usage: true");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.doesNotMatch(reminder, /report-context-usage/);
		assert.doesNotMatch(reminder, /partial work/);
	});

	it("skips a context-warn threshold that launch policy would disable", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "timeout: 60\ncontext-warn-threshold: banana");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.doesNotMatch(reminder, /context-warn/);
		assert.match(reminder, /timeout: 1m/);
		assert.match(reminder, /A stop is not a failure/);
	});

	it("skips an explicit context-warn off value", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: off");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.doesNotMatch(reminder, /context-warn/);
	});

	it("normalizes a context-warn threshold written without a percent sign", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: 75");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /context-warn: 75%/);
	});

	it("includes limit fields in the signature so edits re-send the roster", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "timeout: 900");
		const before = getAgentListSignature(listEntries(dir));
		writeLimitedAgent(dir, "timeout: 60\ncontext-warn-threshold: 70%");
		const after = getAgentListSignature(listEntries(dir));
		assert.notEqual(before, after);
	});

	it("keeps the signature stable across raw-equivalent threshold spellings", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: 80%");
		const withPercent = getAgentListSignature(listEntries(dir));
		writeLimitedAgent(dir, "context-warn-threshold: 80");
		const withoutPercent = getAgentListSignature(listEntries(dir));
		assert.equal(withPercent, withoutPercent);
	});

	it("omits a context-warn schedule that collapsed below three stages", () => {
		const dir = createTestDir();
		// 95% with the default 5% step yields thresholds [95, 99]: the runtime
		// never delivers the final stop instruction, so no stop behavior exists.
		writeLimitedAgent(dir, "context-warn-threshold: 95%");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.doesNotMatch(reminder, /context-warn/);

		// The same 80% start with a 10% step keeps three stages and renders.
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 10%");
		assert.match(renderAgentListReminder(listEntries(dir)), /context-warn: 80%/);

		// A step that collapses the schedule hides the line again.
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 20%");
		assert.doesNotMatch(renderAgentListReminder(listEntries(dir)), /context-warn/);
	});

	it("lets an idle-timeout alone drive the time-limit rule", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "idle-timeout: 240");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /idle-timeout: 4m/);
		assert.doesNotMatch(reminder, /(?<!idle-)timeout: \d/);
		assert.match(reminder, /A stop is not a failure/);
	});

	it("tells the parent a steer does not feed the idle clock", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "idle-timeout: 240");
		assert.match(renderAgentListReminder(listEntries(dir)), /steer you send is not its output/);

		writeLimitedAgent(dir, "timeout: 240");
		assert.doesNotMatch(renderAgentListReminder(listEntries(dir)), /steer you send/);
	});

	it("warns that a forked context-warn agent starts with a partly full window", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "session-mode: fork\ncontext-warn-threshold: 80%");
		const reminder = renderAgentListReminder(listEntries(dir));
		assert.match(reminder, /already using part of its window/);
		assert.match(reminder, /less room for its own work/);
		assert.doesNotMatch(reminder, /stop early soon after launch/);

		writeLimitedAgent(dir, "context-warn-threshold: 80%");
		assert.doesNotMatch(renderAgentListReminder(listEntries(dir)), /already using part of its window/);

		writeLimitedAgent(dir, "session-mode: fork");
		assert.doesNotMatch(renderAgentListReminder(listEntries(dir)), /already using part of its window/);
	});

	it("changes the signature when a step-only edit collapses the schedule", () => {
		const dir = createTestDir();
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 10%");
		const threeStages = getAgentListSignature(listEntries(dir));
		writeLimitedAgent(dir, "context-warn-threshold: 80%\ncontext-warn-step: 20%");
		const collapsed = getAgentListSignature(listEntries(dir));
		assert.notEqual(threeStages, collapsed);
	});
});
