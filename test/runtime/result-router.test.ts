import {
	assert,
	afterEach,
	describe,
	getCompletedSubagentResultForTest,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "child-result-router",
		name: "Result child",
		task: "Report result",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: "/tmp/result-child.jsonl",
		...overrides,
	};
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "Result child",
		task: "Report result",
		summary: "Finished the delegated work.",
		sessionFile: "/tmp/result-child.jsonl",
		exitCode: 0,
		elapsed: 3,
		...overrides,
	};
}

describe("result router", () => {
	afterEach(() => resetSubagentStateForTest());

	it("routes detached completion through one parent-visible result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		let widgetUpdates = 0;
		const running = makeRunning();
		setRunningSubagentForTest(running);

		const routed = routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult(),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {
				widgetUpdates += 1;
			},
		});

		assert.equal(routed.kind, "completion");
		assert.equal(routed.completed.status, "completed");
		assert.equal(routed.completed.deliveredTo, "steer");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
		assert.equal(widgetUpdates, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "subagent_result");
		assert.equal(sent[0].message.details.id, running.id);
		assert.equal(sent[0].message.details.deliveryState, "detached");
		assert.equal(sent[0].message.details.status, "completed");
		assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	});

	it("routes child pings without caching a completed result", () => {
		const sent: Array<{ message: any; options: any }> = [];
		let widgetUpdates = 0;
		const running = makeRunning();
		setRunningSubagentForTest(running);

		const routed = routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				ping: {
					name: "Result child",
					message: "Need parent input.",
				},
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {
				widgetUpdates += 1;
			},
		});

		assert.equal(routed.kind, "ping");
		assert.equal(getCompletedSubagentResultForTest(running.id), undefined);
		assert.equal(widgetUpdates, 1);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].message.customType, "subagent_ping");
		assert.equal(sent[0].message.details.id, running.id);
		assert.equal(sent[0].message.details.message, "Need parent input.");
		assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	});
});
