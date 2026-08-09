import { __pollForExitTest__ } from "../../src/mux/poll.ts";
import { assert, describe, it } from "../support/index.ts";

describe("interpretExitSidecar", () => {
	const { interpretExitSidecar } = __pollForExitTest__;

	it("carries the context-pressure completion reason to the parent", () => {
		// This is the only channel a --no-session child has; dropping it here
		// silently removes the parent's explanation and the resume block.
		assert.deepEqual(interpretExitSidecar({ type: "done", completionReason: "context-pressure" }), {
			reason: "done",
			exitCode: 0,
			completionReason: "context-pressure",
		});
	});

	it("does not invent a completion reason", () => {
		const decoded = interpretExitSidecar({ type: "done", outputTokens: 4 });
		assert.equal("completionReason" in decoded, false);
		assert.equal(interpretExitSidecar({ type: "done", completionReason: "bogus" }).completionReason, undefined);
	});

	it("decodes ping payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "ping",
				name: "Worker",
				message: "need help",
			}),
			{
				reason: "ping",
				exitCode: 0,
				ping: { name: "Worker", message: "need help" },
			},
		);
	});

	it("decodes done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done" }), {
			reason: "done",
			exitCode: 0,
		});
	});

	it("decodes error payloads with non-zero exit code and errorMessage", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "error",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				stopReason: "error",
			}),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
		);
	});

	it("falls back when error payload has no errorMessage", () => {
		const result = interpretExitSidecar({ type: "error" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /no errorMessage/);
	});

	it("treats unknown payload shapes as done", () => {
		assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
	});

	it("threads outputTokens through done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done", outputTokens: 42 }), {
			reason: "done",
			exitCode: 0,
			outputTokens: 42,
		});
	});

	it("threads outputTokens through error payloads", () => {
		const result = interpretExitSidecar({
			type: "error",
			errorMessage: "timeout",
			outputTokens: 17,
		});
		assert.equal(result.outputTokens, 17);
	});

	it("threads final context usage through done payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "done",
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			{
				reason: "done",
				exitCode: 0,
				contextTokens: 145_000,
				contextWindow: 200_000,
			},
		);
	});
});
