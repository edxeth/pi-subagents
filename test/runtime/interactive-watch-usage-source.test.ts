import { describe, it } from "node:test";
import { pickFinalUsageSource } from "../../src/runtime/interactive-watch.ts";
import type { PollResult } from "../../src/mux/poll.ts";
import { assert } from "../support/index.ts";

describe("interactive watch final usage source", () => {
	// These pin the selection rule, not the call site in watchSubagent. A
	// regression to the old inline ternary there would not be caught here;
	// a full watcher harness costs more than that risk is worth.
	it("keeps the poll result when it carries no context counts", () => {
		// An interactive no-session child reports its exit reason without counts;
		// dropping the poll result here silently loses the directive.
		const pollResult = {
			reason: "done",
			exitCode: 0,
			outputTokens: 12,
			completionReason: "context-pressure",
		} as PollResult;

		assert.equal(pickFinalUsageSource(pollResult, undefined)?.completionReason, "context-pressure");
	});

	it("prefers the sidecar when it has counts the poll result lacks", () => {
		const pollResult = { reason: "done", exitCode: 0 } as PollResult;
		const exitSignal = { reason: "done", exitCode: 0, contextTokens: 5, contextWindow: 10 } as PollResult;

		assert.equal(pickFinalUsageSource(pollResult, exitSignal)?.contextTokens, 5);
	});

	it("uses the poll result once it has its own counts", () => {
		const pollResult = { reason: "done", exitCode: 0, contextTokens: 7, contextWindow: 10 } as PollResult;
		const exitSignal = { reason: "done", exitCode: 0, contextTokens: 5, contextWindow: 10 } as PollResult;

		assert.equal(pickFinalUsageSource(pollResult, exitSignal)?.contextTokens, 7);
	});
});
