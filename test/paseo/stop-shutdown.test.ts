import {
	afterEach,
	assert,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
} from "../support/index.ts";
import { stopRunningSubagent } from "../../src/runtime/wiring.ts";
import {
	setPaseoClientFactoryForTest,
	type PaseoClient,
} from "../../src/paseo/client.ts";
import type { RunningSubagent } from "../../src/types.ts";

function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function paseoRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
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
		startTime: Date.now(),
		sessionFile: "/tmp/paseo-child.jsonl",
		...overrides,
	};
}

function fakeClient(cancelled: string[]): PaseoClient {
	return {
		async createAgent() {
			throw new Error("not used");
		},
		async sendAgentMessage() {
			throw new Error("not used");
		},
		async fetchAgent() {
			throw new Error("not used");
		},
		async waitForFinish() {
			throw new Error("not used");
		},
		async fetchAgentTimeline() {
			throw new Error("not used");
		},
		async cancelAgent(agentId) {
			cancelled.push(agentId);
		},
		async close() {},
	};
}

describe("Paseo stop and shutdown", () => {
	afterEach(() => {
		setPaseoClientFactoryForTest(null);
		resetSubagentStateForTest();
	});

	it("cancels a Paseo agent when stopRunningSubagent is called", async () => {
		const cancelled: string[] = [];
		setPaseoClientFactoryForTest(async () => fakeClient(cancelled));
		const controller = new AbortController();
		let aborts = 0;
		controller.signal.addEventListener("abort", () => aborts++);

		stopRunningSubagent(paseoRunning({ abortController: controller }));
		await tick();

		assert.equal(aborts, 1);
		assert.deepEqual(cancelled, ["agent-child-1"]);
	});

	it("cancels only terminate-policy Paseo agents on parent shutdown", async () => {
		const cancelled: string[] = [];
		setPaseoClientFactoryForTest(async () => fakeClient(cancelled));
		setRunningSubagentForTest(paseoRunning({ id: "terminate", paseoAgentId: "agent-terminate" }));
		setRunningSubagentForTest(
			paseoRunning({
				id: "continue",
				paseoAgentId: "agent-continue",
				parentClosePolicy: "continue",
			}),
		);

		const actions = shutdownSubagentsForTest({ escalationMs: 1 });
		await tick();

		assert.deepEqual(
			actions.map(({ id, action }) => `${id}:${action}`),
			["terminate:terminate", "continue:continue"],
		);
		assert.deepEqual(cancelled, ["agent-terminate"]);
	});
});
