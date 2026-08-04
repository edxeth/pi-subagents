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
		summarySource: "subagent",
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

	it("appends final child context usage after the session reference", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {},
		});

		assert.match(
			sent[0].message.content,
			/Finished the delegated work\.\n\nSession: \/tmp\/result-child\.jsonl\nResume: pi --session \/tmp\/result-child\.jsonl\n\nSub-agent context: 145K\/200K tokens \(72%\) used at finish\.$/,
		);
		assert.equal(sent[0].message.details.contextTokens, 145_000);
		assert.equal(sent[0].message.details.contextWindow, 200_000);
	});

	it("keeps final context telemetry structured when the agent definition hides it from the parent message", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning({ reportContextUsage: false });
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {},
		});

		assert.doesNotMatch(sent[0].message.content, /Sub-agent context:/);
		assert.equal(sent[0].message.details.contextTokens, 145_000);
		assert.equal(sent[0].message.details.contextWindow, 200_000);
	});

	it("delivers salvaged child output with provider errors", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Completed the requested implementation.",
				errorMessage: "Provider unavailable",
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content, /Last output before the failure/);
		assert.match(sent[0].message.content, /Completed the requested implementation\./);
		assert.doesNotMatch(sent[0].message.content, /did not produce a result/);
		assert.match(
			sent[0].message.content,
			/Sub-agent context: 145K\/200K tokens \(72%\) used at finish\.$/,
		);
	});

	it("does not present runtime diagnostics as salvaged child output", () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = makeRunning();
		setRunningSubagentForTest(running);

		routeSubagentOutcome({
			pi: {
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			result: makeResult({
				summary: "Background agent exited with code 1\n\nprovider stack trace",
				summarySource: "runtime",
				errorMessage: "Provider unavailable",
			}),
			formatElapsed: (seconds) => `${seconds}s`,
			updateWidget: () => {},
		});

		assert.match(sent[0].message.content, /did not produce a result/);
		assert.doesNotMatch(sent[0].message.content, /Last output before the failure/);
		assert.doesNotMatch(sent[0].message.content, /provider stack trace/);
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
		assert.match(sent[0].message.content, /Need parent input\./);
		assert.deepEqual(sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	});
});
