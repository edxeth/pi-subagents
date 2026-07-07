import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatCountdown,
	formatRecoveryExhaustedMessage,
	PROVIDER_ERROR_RECOVERY_DELAYS_MS,
	MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS,
	ProviderErrorRecoveryController,
	resolveProviderRecoveryDelaysMs,
} from "../../src/tools/provider-error-recovery.ts";

function createHarness(options: { idle?: boolean } = {}) {
	const sentMessages: string[] = [];
	const exitSignals: object[] = [];
	const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
	let shutdowns = 0;
	let idle = options.idle ?? true;

	const ctx = {
		isIdle: () => idle,
		ui: {
			setStatus: (key: string, text: string | undefined) =>
				statusUpdates.push({ key, text }),
		},
	} as unknown as ExtensionContext;

	const controller = new ProviderErrorRecoveryController(
		{
			sendUserMessage: (message) => sentMessages.push(message),
			requestShutdown: () => {
				shutdowns++;
			},
			writeExitSignal: (payload) => exitSignals.push(payload),
			getOutputTokens: () => 42,
			showRecoveryCountdown: (c, message) =>
				c.ui.setStatus("pi-subagent-recovery", message),
			clearRecoveryCountdown: (c) =>
				c.ui.setStatus("pi-subagent-recovery", undefined),
		},
		{ recoveryDelaysMs: [30, 60, 90], idlePollMs: 5 },
	);

	return {
		ctx,
		controller,
		exitSignals,
		sentMessages,
		statusUpdates,
		get shutdowns() {
			return shutdowns;
		},
		setIdle(value: boolean) {
			idle = value;
		},
		error(message = "Connection error.") {
			controller.handleProviderError(
				{ stopReason: "error", errorMessage: message, isRetryable: true, recoveryKind: "provider" },
				ctx,
			);
		},
	};
}

	describe("resolveProviderRecoveryDelaysMs", () => {
		it("defaults to the production 30/60/90 windows", () => {
			assert.deepEqual(resolveProviderRecoveryDelaysMs(undefined), [
				30_000, 60_000, 90_000,
			]);
			assert.deepEqual(PROVIDER_ERROR_RECOVERY_DELAYS_MS, [30_000, 60_000, 90_000]);
		});

		it("parses a comma-separated override for live tests", () => {
			assert.deepEqual(resolveProviderRecoveryDelaysMs("16000,17000,18000"), [
				16000, 17000, 18000,
			]);
		});

		it("clamps override delays above Pi's default auto-retry backoff window", () => {
			assert.deepEqual(resolveProviderRecoveryDelaysMs("1500,3000,4500"), [
				MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS,
				MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS,
				MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS,
			]);
		});

		it("ignores junk and falls back to defaults", () => {
			assert.deepEqual(resolveProviderRecoveryDelaysMs("junk,, -1"), [
				30_000, 60_000, 90_000,
			]);
		});
	});

	describe("formatCountdown", () => {
		it("labels non-final windows as automatic retry", () => {
			assert.equal(
				formatCountdown(1, 28, 3),
				"Provider error — automatic retry in 28s (1/3)",
			);
		});

		it("labels the last window as the final recovery attempt", () => {
			assert.equal(
				formatCountdown(3, 5, 3),
				"Provider error — final recovery attempt in 5s (3/3)",
			);
		});
	});

	describe("constructor guard", () => {
		it("rejects an empty delays list", () => {
			assert.throws(
				() =>
					new ProviderErrorRecoveryController(
						{
							sendUserMessage: () => {},
							requestShutdown: () => {},
							writeExitSignal: () => {},
							getOutputTokens: () => 0,
							showRecoveryCountdown: () => {},
							clearRecoveryCountdown: () => {},
						},
						{ recoveryDelaysMs: [] },
					),
				/Provider error recovery needs at least one delay/,
			);
		});
	});

	describe("provider error recovery", () => {
	it("keeps the child open while Pi retry could still land", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const h = createHarness();
			h.error();

			mock.timers.tick(29);

			assert.deepEqual(h.sentMessages, []);
			assert.deepEqual(h.exitSignals, []);
			assert.equal(h.shutdowns, 0);
			assert.equal(h.controller.getConsecutiveFailuresForTest(), 0);
		} finally {
			mock.timers.reset();
		}
	});

	it("counts retry-attempt errors as one stable completed-on-error failure", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const h = createHarness();
			h.error("first retryable provider error");
			mock.timers.tick(5);
			h.error("second retryable provider error");

			mock.timers.tick(29);
			assert.deepEqual(h.sentMessages, []);
			assert.equal(h.controller.getConsecutiveFailuresForTest(), 0);

			mock.timers.tick(1);
			assert.equal(h.controller.getConsecutiveFailuresForTest(), 1);
			assert.deepEqual(h.sentMessages, ["continue"]);
			assert.equal(h.controller.getConsecutiveFailuresForTest(), 1);
		} finally {
			mock.timers.reset();
		}
	});

	it("nudges after 30s then 60s for consecutive stable failures", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const h = createHarness();

			h.error("first stable failure");
			mock.timers.tick(30);
			assert.deepEqual(h.sentMessages, ["continue"]);

			h.error("second stable failure");
			mock.timers.tick(59);
			assert.deepEqual(h.sentMessages, ["continue"]);
			mock.timers.tick(1);
			assert.deepEqual(h.sentMessages, ["continue", "continue"]);
			assert.equal(h.controller.getConsecutiveFailuresForTest(), 2);
		} finally {
			mock.timers.reset();
		}
	});

	it("does NOT reset the chain on a transient successful message between errors", () => {
		// Regression: a flaky provider often lets the agent get off one successful
		// tool call before the connection drops again. That single non-error
		// assistant message must not snap the failure counter back to 0, or the
		// recovery loops forever (always "failure 1"). Escalation is driven only by
		// error agent_ends; a real recovery resets via the successful agent_end path.
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const h = createHarness();

			// failure 1 -> nudge
			h.error("first stable failure");
			mock.timers.tick(30);
			assert.deepEqual(h.sentMessages, ["continue"]);

			// failure 2 -> nudge (no reset in between, even though no message fires here)
			h.error("second stable failure");
			mock.timers.tick(60);
			assert.deepEqual(h.sentMessages, ["continue", "continue"]);
			assert.equal(h.controller.getConsecutiveFailuresForTest(), 2);
		} finally {
			mock.timers.reset();
		}
	});

	it("kills after the third consecutive stable failure waits out its 90s window", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const h = createHarness();

			h.error("first stable failure");
			mock.timers.tick(30);
			h.error("second stable failure");
			mock.timers.tick(60);
			h.error("third stable failure");
			mock.timers.tick(89);

			assert.deepEqual(h.exitSignals, []);
			assert.equal(h.shutdowns, 0);

			mock.timers.tick(1);

			assert.deepEqual(h.sentMessages, ["continue", "continue"]);
			assert.equal(h.shutdowns, 1);
			assert.deepEqual(h.exitSignals, [
				{
					type: "error",
					errorMessage: formatRecoveryExhaustedMessage(3, "third stable failure"),
					stopReason: "error",
					outputTokens: 42,
				},
			]);
		} finally {
			mock.timers.reset();
		}
	});

	it("waits for idle before sending a recovery nudge", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const h = createHarness({ idle: false });
			h.error();

			mock.timers.tick(30);
			assert.deepEqual(h.sentMessages, []);

			h.setIdle(true);
			mock.timers.tick(5);
			assert.deepEqual(h.sentMessages, ["continue"]);
		} finally {
			mock.timers.reset();
		}
	});

	it("cancels delayed idle checks without touching a stale context", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			let stale = false;
			const h = createHarness();
			const ctx = {
				isIdle() {
					if (stale) throw new Error("stale context");
					return true;
				},
				ui: { setStatus() {} },
			} as unknown as ExtensionContext;

			h.controller.handleProviderError(
				{
					stopReason: "error",
					errorMessage: "Connection error.",
					isRetryable: true,
					recoveryKind: "provider",
				},
				ctx,
			);
			stale = true;
			h.controller.cancelPendingRecovery();

			assert.doesNotThrow(() => mock.timers.tick(30));
			assert.deepEqual(h.sentMessages, []);
			assert.deepEqual(h.exitSignals, []);
		} finally {
			mock.timers.reset();
		}
	});

	it("treats stale context during idle polling as a cancelled recovery", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			const h = createHarness();
			const ctx = {
				isIdle() {
					throw new Error("stale context");
				},
				ui: { setStatus() {} },
			} as unknown as ExtensionContext;

			h.controller.handleProviderError(
				{
					stopReason: "error",
					errorMessage: "Connection error.",
					isRetryable: true,
					recoveryKind: "provider",
				},
				ctx,
			);

			assert.doesNotThrow(() => mock.timers.tick(30));
			assert.deepEqual(h.sentMessages, []);
			assert.deepEqual(h.exitSignals, []);
		} finally {
			mock.timers.reset();
		}
	});
});

describe("recovery countdown", () => {
	it("paints a countdown while a window is armed and clears it when it fires", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			const h = createHarness();
			h.error("boom");

			// Initial paint lands immediately and labels it the first automatic retry.
			assert.match(h.statusUpdates.at(-1)?.text ?? "", /automatic retry .*\(1\/3\)/);

			// Window fires (30ms delay) -> nudge sent, status cleared.
			mock.timers.tick(30);
			assert.deepEqual(h.sentMessages, ["continue"]);
			assert.deepEqual(h.statusUpdates.at(-1), { key: "pi-subagent-recovery", text: undefined });
		} finally {
			mock.timers.reset();
		}
	});

	it("clears the status when recovery is cancelled (successful agent_end)", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			const h = createHarness();
			h.error("boom");
			assert.ok(h.statusUpdates.some((u) => u.text));

			// A run that completes successfully cancels recovery and clears the countdown.
			h.controller.cancelPendingRecovery(true);
			assert.deepEqual(h.statusUpdates.at(-1), { key: "pi-subagent-recovery", text: undefined });
		} finally {
			mock.timers.reset();
		}
	});

	it("labels the last window as the final recovery attempt", () => {
		mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		try {
			const h = createHarness();
			h.error("one");
			mock.timers.tick(30);
			h.error("two");
			mock.timers.tick(60);
			h.error("three");
			// Third window is the kill: its countdown says "final recovery attempt".
			assert.match(h.statusUpdates.at(-1)?.text ?? "", /final recovery attempt .*\(3\/3\)/);
		} finally {
			mock.timers.reset();
		}
	});
});
