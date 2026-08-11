import { routeSubagentOutcome } from "../../src/runtime/result-router.ts";
import { formatSessionRef } from "../../src/runtime/final-context-usage.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest, setRunningSubagentForTest } from "../support/index.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "child-timeout-delivery",
		name: "runaway",
		task: "Loop forever",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile: "/tmp/runaway-child.jsonl",
		...overrides,
	};
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "runaway",
		task: "Loop forever",
		summary: "Background agent exited with code 143",
		summarySource: "runtime",
		sessionFile: "/tmp/runaway-child.jsonl",
		exitCode: 143,
		elapsed: 900,
		...overrides,
	};
}

function deliver(running: RunningSubagent, result: SubagentResult): string {
	const sent: Array<{ content: string; details: Record<string, unknown> }> = [];
	setRunningSubagentForTest(running);
	routeSubagentOutcome({
		pi: {
			sendMessage(message: unknown) {
				sent.push(message as { content: string; details: Record<string, unknown> });
			},
		},
		running,
		result,
		formatElapsed: (seconds) => `${seconds}s`,
		updateWidget: () => {},
	});
	return sent[0]?.content ?? "";
}

describe("timeout result delivery", () => {
	afterEach(() => resetSubagentStateForTest());

	it("explains the kill instead of reporting a bare non-zero exit", () => {
		const content = deliver(
			makeRunning(),
			makeResult({ timedOut: "timeout", timedOutAfter: 900 }),
		);

		assert.match(content, /ran out of time, so the system stopped it after 900s/);
		assert.match(content, /It produced no output before it stopped/);
		assert.doesNotMatch(content, /failed \(exit 143\)/);
		assert.doesNotMatch(content, /Background agent exited with code 143/);
	});

	it("hands the parent the partial work a warned child managed to deliver", () => {
		const content = deliver(
			makeRunning(),
			makeResult({
				summary: "Mapped the auth flow; the session layer is untouched.",
				summarySource: "subagent",
				timedOut: "idle-timeout",
				timedOutAfter: 180,
			}),
		);

		assert.match(content, /limit of 3m without output/);
		assert.match(content, /Mapped the auth flow; the session layer is untouched\./);
		assert.match(content, /better to finish the work yourself/);
	});

	it("names the session but never hands out an unbounded raw resume command", () => {
		const content = deliver(makeRunning(), makeResult({ timedOut: "timeout", timedOutAfter: 900 }));

		assert.match(content, /Session: \/tmp\/runaway-child\.jsonl/);
		assert.match(content, /use the subagent_resume tool/);
		// A raw pi run is not a tracked child and carries no budget, so offering
		// that command here would undo the guarantee the text just made.
		assert.doesNotMatch(content, /Resume: pi --session/);
	});

	it("withholds the resume command when the agent blocks resume", () => {
		const content = deliver(
			makeRunning({ timeoutBlocksResume: true }),
			makeResult({ timedOut: "timeout", timedOutAfter: 900, timeoutBlocksResume: true }),
		);

		assert.match(content, /does not allow a resume after a limit stops it/);
		assert.doesNotMatch(content, /Resume: pi --session/);
	});

	it("leaves an ordinary completion untouched", () => {
		const content = deliver(
			makeRunning(),
			makeResult({ summary: "All done.", summarySource: "subagent", exitCode: 0, elapsed: 12 }),
		);

		assert.match(content, /completed \(12s\)/);
		assert.doesNotMatch(content, /the system stopped it/);
	});

	it("explains that a completed report followed a forced warning-threshold interruption", () => {
		const content = deliver(
			makeRunning(),
			makeResult({
				summary: "Reported the committed findings; the final integration check remains unfinished.",
				summarySource: "subagent",
				exitCode: 0,
				elapsed: 81,
				timeoutWrapUp: { kind: "timeout", seconds: 100, threshold: 80 },
			}),
		);

		assert.match(content, /interrupted its active operation at 80%/i);
		assert.match(content, /remaining time.*report/i);
		assert.match(content, /short or partial report.*expected/i);
		assert.match(content, /Reported the committed findings/);
		assert.doesNotMatch(content, /ran out of time/);
	});
});

describe("session reference under a timeout", () => {
	it("keeps the reference for a recoverable timeout", () => {
		assert.match(
			formatSessionRef({ sessionFile: "/tmp/child.jsonl", timeoutBlocksResume: false }),
			/Resume: pi --session \/tmp\/child\.jsonl/,
		);
	});

	it("drops the reference once resume is blocked", () => {
		assert.equal(formatSessionRef({ sessionFile: "/tmp/child.jsonl", timeoutBlocksResume: true }), "");
	});
});
