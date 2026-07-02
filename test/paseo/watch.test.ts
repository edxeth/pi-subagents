import { assert, describe, it } from "../support/index.ts";
import {
	hasRunningPaseoToolCallForTest,
	mapPaseoWaitResultForTest,
	summarizePaseoTimelineForTest,
	watchPaseoSubagent,
} from "../../src/paseo/watch.ts";
import { setPaseoClientFactoryForTest, type PaseoClient } from "../../src/paseo/client.ts";
import type { RunningSubagent } from "../../src/types.ts";

function running(): RunningSubagent {
	return {
		id: "run-1",
		name: "paseo-child",
		task: "Do Paseo work.",
		mode: "background",
		backend: "paseo",
		paseoAgentId: "agent-child-1",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: Date.now() - 2000,
		sessionFile: "/tmp/paseo-child.jsonl",
	};
}

describe("Paseo watch mapping", () => {
	it("summarizes the latest assistant message from a timeline", () => {
		assert.equal(
			summarizePaseoTimelineForTest({
				agentId: "agent-child-1",
				entries: [
					{ item: { type: "assistant_message", text: "First" } },
					{ item: { type: "reasoning", text: "hidden" } },
					{ item: { type: "assistant_message", text: "Final summary" } },
				],
			}),
			"Final summary",
		);
	});

	it("ignores injected system reminders when summarizing a timeline", () => {
		assert.equal(
			summarizePaseoTimelineForTest({
				agentId: "agent-child-1",
				entries: [
					{ item: { type: "assistant_message", text: "done" } },
					{ item: { type: "assistant_message", text: "<system-reminder>roster</system-reminder>" } },
				],
			}),
			"done",
		);
	});

	it("reconstructs final assistant text from adjacent canonical chunks", () => {
		assert.equal(
			summarizePaseoTimelineForTest({
				agentId: "agent-child-1",
				entries: [
					{ item: { type: "tool_call", status: "completed" } },
					{ item: { type: "assistant_message", text: "Completed: said `hi" } },
					{ item: { type: "assistant_message", text: "`, waited 10 seconds," } },
					{ item: { type: "assistant_message", text: " then said `bye`." } },
				],
			}),
			"Completed: said `hi`, waited 10 seconds, then said `bye`.",
		);
	});

	it("does not merge distinct adjacent assistant messages", () => {
		assert.equal(
			summarizePaseoTimelineForTest({
				agentId: "agent-child-1",
				entries: [
					{ item: { type: "assistant_message", messageId: "first", text: "First answer." } },
					{ item: { type: "assistant_message", messageId: "second", text: "Second" } },
					{ item: { type: "assistant_message", messageId: "second", text: " answer." } },
				],
			}),
			"Second answer.",
		);
	});

	it("detects running Paseo tool calls", () => {
		assert.equal(
			hasRunningPaseoToolCallForTest({
				agentId: "agent-child-1",
				entries: [{ item: { type: "tool_call", status: "running" } }],
			}),
			true,
		);
		assert.equal(
			hasRunningPaseoToolCallForTest({
				agentId: "agent-child-1",
				entries: [{ item: { type: "tool_call", detail: { exitCode: 0 } } }],
			}),
			false,
		);
		assert.equal(
			hasRunningPaseoToolCallForTest({
				agentId: "agent-child-1",
				entries: [
					{ item: { type: "tool_call", callId: "call-1", status: "running" } },
					{ item: { type: "tool_call", callId: "call-1", status: "completed" } },
				],
			}),
			false,
		);
	});

	it("maps idle completion to a successful subagent result", () => {
		const result = mapPaseoWaitResultForTest(
			running(),
			{
				status: "idle",
				final: {
					id: "agent-child-1",
					cwd: "/repo",
					status: "idle",
					lastUsage: { totalTokens: 1234 },
				},
				error: null,
				lastMessage: "fallback",
			},
			{
				agentId: "agent-child-1",
				entries: [{ item: { type: "assistant_message", text: "Finished in Paseo" } }],
			},
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.summary, "Finished in Paseo");
		assert.equal(result.outputTokens, 1234);
		assert.equal(result.ping, undefined);
	});

	it("maps error completion to a failed subagent result", () => {
		const result = mapPaseoWaitResultForTest(
			running(),
			{
				status: "error",
				final: {
					id: "agent-child-1",
					cwd: "/repo",
					status: "error",
					lastError: "model failed",
				},
				error: "model failed",
				lastMessage: null,
			},
			{
				agentId: "agent-child-1",
				entries: [{ item: { type: "error", message: "Timeline error" } }],
			},
		);

		assert.equal(result.exitCode, 1);
		assert.equal(result.summary, "Timeline error");
		assert.equal(result.errorMessage, "model failed");
	});

	it("maps permission and timeout statuses to ping results", () => {
		const permission = mapPaseoWaitResultForTest(
			running(),
			{ status: "permission", final: null, error: null, lastMessage: null },
			null,
		);
		assert.equal(permission.exitCode, 0);
		assert.match(permission.ping?.message ?? "", /needs attention/);

		const timeout = mapPaseoWaitResultForTest(
			running(),
			{ status: "timeout", final: null, error: null, lastMessage: null },
			null,
		);
		assert.equal(timeout.exitCode, 0);
		assert.match(timeout.ping?.message ?? "", /still running/);
	});

	it("waits for a newly-created Paseo agent to start before waiting for finish", async () => {
		let fetchCount = 0;
		let waitCalledAfterStart = false;
		const client: PaseoClient = {
			async createAgent() {
				throw new Error("not used");
			},
			async sendAgentMessage() {
				throw new Error("not used");
			},
			async fetchAgent() {
				fetchCount++;
				return {
					agent: {
						id: "agent-child-1",
						cwd: "/repo",
						status: fetchCount === 1 ? "idle" : "running",
					},
				};
			},
			async waitForFinish() {
				waitCalledAfterStart = fetchCount > 1;
				return {
					status: "idle",
					final: { id: "agent-child-1", cwd: "/repo", status: "idle" },
					error: null,
					lastMessage: "done",
				};
			},
			async fetchAgentTimeline() {
				return { agentId: "agent-child-1", entries: [] };
			},
			async cancelAgent() {},
			async close() {},
		};

		setPaseoClientFactoryForTest(async () => client);
		try {
			const result = await watchPaseoSubagent(running(), new AbortController().signal);
			assert.equal(result.summary, "done");
			assert.equal(waitCalledAfterStart, true);
		} finally {
			setPaseoClientFactoryForTest(null);
		}
	});

	it("keeps waiting when Paseo reports idle while a child tool is still running", async () => {
		let waitCount = 0;
		const client: PaseoClient = {
			async createAgent() {
				throw new Error("not used");
			},
			async sendAgentMessage() {
				throw new Error("not used");
			},
			async fetchAgent() {
				return {
					agent: { id: "agent-child-1", cwd: "/repo", status: "running" },
				};
			},
			async waitForFinish() {
				waitCount++;
				return {
					status: "idle",
					final: { id: "agent-child-1", cwd: "/repo", status: "idle" },
					error: null,
					lastMessage: waitCount === 1 ? "<system-reminder>roster</system-reminder>" : "done",
				};
			},
			async fetchAgentTimeline() {
				return waitCount === 1
					? {
							agentId: "agent-child-1",
							entries: [{ item: { type: "tool_call", status: "running" } }],
						}
					: {
							agentId: "agent-child-1",
							entries: [{ item: { type: "assistant_message", text: "done" } }],
						};
			},
			async cancelAgent() {},
			async close() {},
		};

		setPaseoClientFactoryForTest(async () => client);
		try {
			const result = await watchPaseoSubagent(running(), new AbortController().signal);
			assert.equal(waitCount, 2);
			assert.equal(result.summary, "done");
		} finally {
			setPaseoClientFactoryForTest(null);
		}
	});

	it("does not treat a newly idle Paseo child with no output as complete", async () => {
		process.env.PI_SUBAGENT_PASEO_IDLE_WITHOUT_OUTPUT_GRACE_MS = "20";
		let waitCount = 0;
		const client: PaseoClient = {
			async createAgent() {
				throw new Error("not used");
			},
			async sendAgentMessage() {
				throw new Error("not used");
			},
			async fetchAgent() {
				return {
					agent: { id: "agent-child-1", cwd: "/repo", status: "running" },
				};
			},
			async waitForFinish() {
				waitCount++;
				return {
					status: "idle",
					final: { id: "agent-child-1", cwd: "/repo", status: "idle" },
					error: null,
					lastMessage: null,
				};
			},
			async fetchAgentTimeline() {
				return waitCount === 1
					? { agentId: "agent-child-1", entries: [] }
					: {
							agentId: "agent-child-1",
							entries: [{ item: { type: "assistant_message", text: "done" } }],
						};
			},
			async cancelAgent() {},
			async close() {},
		};

		setPaseoClientFactoryForTest(async () => client);
		try {
			const result = await watchPaseoSubagent(running(), new AbortController().signal);
			assert.equal(waitCount, 2);
			assert.equal(result.summary, "done");
		} finally {
			setPaseoClientFactoryForTest(null);
		}
	});
});
