import { assert, describe, it } from "../support/index.ts";
import { buildCompletedSubagentResult, getWatcherSignal } from "../../src/runtime/state.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "test-id",
		name: "test-agent",
		task: "test task",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: false,
		async: true,
		autoExit: true,
		sessionFile: "/tmp/test.jsonl",
		startTime: Date.now(),
		...overrides,
	} as RunningSubagent;
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		name: "test-agent",
		task: "test task",
		summary: "done",
		exitCode: 0,
		elapsed: 5,
		...overrides,
	};
}

describe("getWatcherSignal", () => {
	it("is scoped to the child watcher controller", () => {
		const watcherAbort = new AbortController();

		const signal = getWatcherSignal(makeRunning(), watcherAbort);

		assert.equal(signal, watcherAbort.signal);
		assert.equal(signal.aborted, false);
		watcherAbort.abort();
		assert.equal(signal.aborted, true);
	});
});

describe("getSubagentCompletionStatus (via buildCompletedSubagentResult)", () => {
	it("returns completed when exitCode is 0 and no errorMessage", () => {
		const result = buildCompletedSubagentResult(makeRunning(), makeResult());
		assert.equal(result.status, "completed");
		assert.equal(result.exitCode, 0);
	});

	it("returns failed when exitCode is non-zero", () => {
		const result = buildCompletedSubagentResult(
			makeRunning(),
			makeResult({ exitCode: 1 }),
		);
		assert.equal(result.status, "failed");
	});

	it("returns cancelled when error is 'cancelled'", () => {
		const result = buildCompletedSubagentResult(
			makeRunning(),
			makeResult({ error: "cancelled", exitCode: 1 }),
		);
		assert.equal(result.status, "cancelled");
	});

	it("returns failed when errorMessage is set even if exitCode is 0", () => {
		const result = buildCompletedSubagentResult(
			makeRunning(),
			makeResult({
				exitCode: 0,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			}),
		);
		assert.equal(result.status, "failed");
	});

	it("returns failed when the child stopped before producing a result", () => {
		const result = buildCompletedSubagentResult(
			makeRunning(),
			makeResult({
				exitCode: 0,
				summary: "Subagent stopped before producing a result (stopReason: length)",
			}),
		);
		assert.equal(result.status, "failed");
	});

	it("prefers cancelled over errorMessage", () => {
		const result = buildCompletedSubagentResult(
			makeRunning(),
			makeResult({
				error: "cancelled",
				exitCode: 0,
				errorMessage: "would be ignored",
			}),
		);
		assert.equal(result.status, "cancelled");
	});

	it("threads errorMessage through to CompletedSubagentResult", () => {
		const result = buildCompletedSubagentResult(
			makeRunning(),
			makeResult({
				exitCode: 0,
				errorMessage: "Provider timeout",
			}),
		);
		assert.equal(result.errorMessage, "Provider timeout");
	});
});
