import { assert, describe, it } from "./support/index.ts";
import {
	findLatestAssistantError,
	isOperatorInput,
	isRetryableProviderErrorMessage,
	shouldDeferErrorForPiRecovery,
} from "../src/auto-exit.ts";

describe("findLatestAssistantError", () => {
	it("returns error info when last assistant has stopReason=error with errorMessage", () => {
		const messages = [
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
			{ role: "toolResult", content: [] },
			{ role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
		];
		assert.deepEqual(findLatestAssistantError(messages), {
			errorMessage: "Anthropic 529 Overloaded",
			isRetryable: true,
			recoveryKind: "provider",
			stopReason: "error",
		});
	});

	it("returns null when the latest assistant completed normally", () => {
		const messages = [
			{ role: "assistant", stopReason: "error", errorMessage: "old failure" },
			{ role: "user", content: [] },
			{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
		];
		assert.equal(findLatestAssistantError(messages), null);
	});

	it("returns null when the latest assistant was aborted", () => {
		const messages = [{ role: "assistant", stopReason: "aborted" }];
		assert.equal(findLatestAssistantError(messages), null);
	});

	it("falls back to a placeholder when stopReason=error has no errorMessage", () => {
		const messages = [{ role: "assistant", stopReason: "error" }];
		const info = findLatestAssistantError(messages);
		assert.ok(info);
		assert.equal(info!.stopReason, "error");
		assert.equal(info!.isRetryable, false);
		assert.equal(info!.recoveryKind, "none");
		assert.match(info!.errorMessage, /stopReason=error/);
	});

	it("stops scanning at the first assistant message (newest)", () => {
		const messages = [
			{ role: "assistant", stopReason: "error", errorMessage: "first" },
			{ role: "assistant", stopReason: "error", errorMessage: "second" },
		];
		const info = findLatestAssistantError(messages);
		assert.ok(info);
		assert.equal(info!.errorMessage, "second");
	});

	it("returns null when messages is undefined or empty", () => {
		assert.equal(findLatestAssistantError(undefined), null);
		assert.equal(findLatestAssistantError([]), null);
	});

	it("returns null when there are no assistant messages", () => {
		const messages = [
			{ role: "user", content: [] },
			{ role: "toolResult", content: [] },
		];
		assert.equal(findLatestAssistantError(messages), null);
	});

	it("marks context overflow errors for Pi-native recovery only", () => {
		const messages = [
			{
				role: "assistant",
				provider: "openai",
				model: "gpt-test",
				stopReason: "error",
				errorMessage: "Your input exceeds the context window of this model",
			},
		];

		assert.deepEqual(findLatestAssistantError(messages), {
			errorMessage: "Your input exceeds the context window of this model",
			isRetryable: true,
			recoveryKind: "pi",
			stopReason: "error",
		});
	});
});

describe("isRetryableProviderErrorMessage", () => {
	it("recognizes transient provider and transport failures", () => {
		assert.equal(isRetryableProviderErrorMessage("Connection error."), true);
		assert.equal(isRetryableProviderErrorMessage("HTTP 429 rate limit"), true);
		assert.equal(isRetryableProviderErrorMessage("service unavailable"), true);
		assert.equal(isRetryableProviderErrorMessage("stream ended before message_stop"), true);
	});

	it("rejects permanent quota, billing, and auth failures", () => {
		assert.equal(isRetryableProviderErrorMessage("insufficient_quota"), false);
		assert.equal(isRetryableProviderErrorMessage("Monthly usage limit reached"), false);
		assert.equal(isRetryableProviderErrorMessage("invalid API key"), false);
	});
});

describe("shouldDeferErrorForPiRecovery", () => {
	it("recognizes Pi context-overflow messages that should reach compaction", () => {
		assert.equal(
			shouldDeferErrorForPiRecovery({
				role: "assistant",
				stopReason: "error",
				errorMessage: "Requested token count exceeds the model's maximum context length of 131072 tokens",
			}),
			true,
		);
	});
});

describe("isOperatorInput", () => {
	it("treats interactive and rpc input as operator steering", () => {
		assert.equal(isOperatorInput("interactive"), true);
		assert.equal(isOperatorInput("rpc"), true);
		assert.equal(isOperatorInput(undefined), true);
	});

	it("ignores extension-originated input so recovery nudges do not loop", () => {
		assert.equal(isOperatorInput("extension"), false);
	});
});
