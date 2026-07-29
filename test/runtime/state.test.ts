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
		summarySource: "subagent",
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

	it("treats an operator-closed manual interactive child as completed when it produced output", () => {
		// Manual interactive children (auto-exit: false) complete when the operator
		// closes the pane. A forced pane close can leave the shell exit trap with a
		// non-zero status, but the child already wrote a real final assistant message,
		// so the close is a successful operator close — not a failure.
		const result = buildCompletedSubagentResult(
			makeRunning({ mode: "interactive", autoExit: false }),
			makeResult({ exitCode: 1, summary: "TMP_INTERACTIVE_MANUAL_READY" }),
		);
		assert.equal(result.status, "completed");
	});

	it("keeps a manual interactive child failed when it produced no output", () => {
		// A crash before the child answered still looks like a failure even for
		// manual interactive children: the operator-close carve-out only applies
		// when there is a real final message to return.
		const result = buildCompletedSubagentResult(
			makeRunning({ mode: "interactive", autoExit: false }),
			makeResult({
				exitCode: 1,
				summary: "Sub-agent exited with code 1",
				summarySource: "runtime",
			}),
		);
		assert.equal(result.status, "failed");
	});

	it("keeps a manual interactive child failed on an explicit provider error", () => {
		const result = buildCompletedSubagentResult(
			makeRunning({ mode: "interactive", autoExit: false }),
			makeResult({ exitCode: 1, summary: "partial work", errorMessage: "529 Overloaded" }),
		);
		assert.equal(result.status, "failed");
	});

	it("does not apply the manual-close carve-out to auto-exit or background children", () => {
		const interactiveAutoExit = buildCompletedSubagentResult(
			makeRunning({ mode: "interactive", autoExit: true }),
			makeResult({ exitCode: 1, summary: "TMP_INTERACTIVE_AUTO_OK" }),
		);
		assert.equal(interactiveAutoExit.status, "failed");

		const backgroundManual = buildCompletedSubagentResult(
			makeRunning({ mode: "background", autoExit: false }),
			makeResult({ exitCode: 1, summary: "TMP_BACKGROUND_MANUAL_OK" }),
		);
		assert.equal(backgroundManual.status, "failed");
	});

	it("keeps a manual interactive child failed when the watcher hit an error path", () => {
		// If the pane was destroyed before the EXIT trap ran, the watcher returns an
		// error result with an "Subagent error: …" summary. That is not a clean
		// operator close, so it must stay failed even for manual interactive children.
		const result = buildCompletedSubagentResult(
			makeRunning({ mode: "interactive", autoExit: false }),
			makeResult({
				exitCode: 1,
				summary: "Subagent error: Failed to read subagent surface while polling for exit",
				error: "Failed to read subagent surface while polling for exit",
			}),
		);
		assert.equal(result.status, "failed");
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
