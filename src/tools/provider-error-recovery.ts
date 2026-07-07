import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentErrorInfo } from "../auto-exit.ts";

export const PROVIDER_ERROR_RECOVERY_DELAYS_MS = [30_000, 60_000, 90_000] as const;
export const MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS = 10_000;
const PROVIDER_ERROR_RECOVERY_NUDGE = "continue";

/**
 * Override the recovery backoff windows. Mainly a live-test/debug knob so a real
 * Pi process can exercise the wait -> nudge -> kill path without waiting the full
 * 30/60/90s. Comma-separated milliseconds, e.g. "10000,11000,12000".
 * Values below MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS are clamped so live child
 * recovery cannot race Pi's own default auto-retry backoff.
 */
const PROVIDER_ERROR_RECOVERY_DELAYS_ENV =
	"PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS";

export function resolveProviderRecoveryDelaysMs(
	raw = process.env[PROVIDER_ERROR_RECOVERY_DELAYS_ENV],
): readonly number[] {
	if (!raw) return PROVIDER_ERROR_RECOVERY_DELAYS_MS;
	const parsed = raw
		.split(",")
		.map((part) => Number.parseInt(part.trim(), 10))
		.filter((ms) => Number.isFinite(ms) && ms >= 0)
		.map((ms) => Math.max(ms, MIN_PROVIDER_ERROR_RECOVERY_DELAY_MS));
	return parsed.length > 0 ? parsed : PROVIDER_ERROR_RECOVERY_DELAYS_MS;
}

type Timer = ReturnType<typeof setTimeout>;

export interface ProviderErrorRecoveryRuntime {
	sendUserMessage(message: string): void;
	requestShutdown(ctx: ExtensionContext): void;
	writeExitSignal(payload: object): void;
	getOutputTokens(): number;
	/**
	 * Render the recovery countdown (interactive panes only). Called ~once per
	 * second while a recovery window is armed, so the operator watching the pane
	 * knows a nudge is coming and when. No-op for background/print-mode children.
	 */
	showRecoveryCountdown(ctx: ExtensionContext, message: string): void;
	/** Clear the countdown once the window fires or is superseded. */
	clearRecoveryCountdown(ctx: ExtensionContext): void;
}

export interface ProviderErrorRecoveryOptions {
	/**
	 * Quiet windows for consecutive completed-on-error failures. Pi may still be
	 * doing its own provider retry after an error event, and Pi reports idle while
	 * waiting between retry attempts. A new assistant message or retry error
	 * supersedes the current window, so retry attempts do not spend this budget.
	 * The first delays send recovery nudges; the last delay closes the child as
	 * failed.
	 */
	recoveryDelaysMs?: readonly number[];
	idlePollMs?: number;
	nudgeMessage?: string;
}

export class ProviderErrorRecoveryController {
	private generation = 0;
	private consecutiveFailures = 0;
	private timer: Timer | undefined;
	private countdown: Timer | undefined;
	private countdownCtx: ExtensionContext | undefined;
	private readonly recoveryDelaysMs: readonly number[];
	private readonly idlePollMs: number;
	private readonly nudgeMessage: string;
	private readonly runtime: ProviderErrorRecoveryRuntime;

	constructor(
		runtime: ProviderErrorRecoveryRuntime,
		options: ProviderErrorRecoveryOptions = {},
	) {
		this.runtime = runtime;
		this.recoveryDelaysMs =
			options.recoveryDelaysMs ?? PROVIDER_ERROR_RECOVERY_DELAYS_MS;
		this.idlePollMs = options.idlePollMs ?? 250;
		this.nudgeMessage = options.nudgeMessage ?? PROVIDER_ERROR_RECOVERY_NUDGE;
		if (this.recoveryDelaysMs.length === 0) {
			throw new Error("Provider error recovery needs at least one delay.");
		}
	}

	getConsecutiveFailuresForTest(): number {
		return this.consecutiveFailures;
	}

	handleProviderError(errorInfo: SubagentErrorInfo, ctx: ExtensionContext): void {
		const token = this.supersedePendingTimer();
		const failureNumber = this.consecutiveFailures + 1;
		const delay = this.getRecoveryDelay(failureNumber);
		this.startCountdown(ctx, failureNumber, delay);
		this.schedule(() => {
			if (!this.isCurrent(token)) return;
			this.handleStableProviderError(errorInfo, ctx, token, failureNumber);
		}, delay);
	}

	cancelPendingRecovery(resetFailures = false): void {
		this.supersedePendingTimer();
		if (resetFailures) this.consecutiveFailures = 0;
	}

	private handleStableProviderError(
		errorInfo: SubagentErrorInfo,
		ctx: ExtensionContext,
		token: number,
		failureNumber: number,
	): void {
		this.consecutiveFailures = failureNumber;
		const shouldShutdown = failureNumber >= this.recoveryDelaysMs.length;

		this.whenIdle(ctx, token, () => {
			this.stopCountdown();
			if (shouldShutdown) {
				this.runtime.writeExitSignal({
					type: "error",
					errorMessage: formatRecoveryExhaustedMessage(
						failureNumber,
						errorInfo.errorMessage,
					),
					stopReason: errorInfo.stopReason,
					outputTokens: this.runtime.getOutputTokens(),
				});
				this.runtime.requestShutdown(ctx);
				return;
			}
			this.runtime.sendUserMessage(this.nudgeMessage);
		});
	}

	private getRecoveryDelay(failureNumber: number): number {
		return this.recoveryDelaysMs[
			Math.min(failureNumber - 1, this.recoveryDelaysMs.length - 1)
		];
	}

	private whenIdle(
		ctx: ExtensionContext,
		token: number,
		action: () => void,
	): void {
		if (!this.isCurrent(token)) return;
		let isIdle = false;
		try {
			isIdle = ctx.isIdle();
		} catch {
			this.cancelPendingRecovery();
			return;
		}
		if (isIdle) {
			action();
			return;
		}
		this.schedule(() => this.whenIdle(ctx, token, action), this.idlePollMs, false);
	}

	private supersedePendingTimer(): number {
		this.generation++;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.stopCountdown();
		return this.generation;
	}

	private isCurrent(token: number): boolean {
		return token === this.generation;
	}

	private schedule(callback: () => void, delayMs: number, replace = true): void {
		if (replace && this.timer) clearTimeout(this.timer);
		const timer = setTimeout(() => {
			if (this.timer === timer) this.timer = undefined;
			callback();
		}, delayMs);
		timer.unref?.();
		if (replace) this.timer = timer;
	}

	private startCountdown(
		ctx: ExtensionContext,
		failureNumber: number,
		delayMs: number,
	): void {
		this.countdownCtx = ctx;
		let remaining = Math.max(1, Math.ceil(delayMs / 1000));
		const paint = () => {
			try {
				this.runtime.showRecoveryCountdown(
					ctx,
					formatCountdown(failureNumber, remaining, this.recoveryDelaysMs.length),
				);
			} catch {
				this.cancelPendingRecovery();
			}
		};
		const interval = setInterval(() => {
			remaining = Math.max(0, remaining - 1);
			paint();
		}, 1000);
		interval.unref?.();
		this.countdown = interval;
		// Initial paint so the countdown is visible immediately, not after 1s.
		paint();
	}

	private stopCountdown(): void {
		if (!this.countdown) return;
		clearInterval(this.countdown);
		this.countdown = undefined;
		const ctx = this.countdownCtx;
		this.countdownCtx = undefined;
		if (!ctx) return;
		try {
			this.runtime.clearRecoveryCountdown(ctx);
		} catch {
			// Context may already be stale after session shutdown/reload.
		}
	}
}

export function formatRecoveryExhaustedMessage(
	failureNumber: number,
	lastError: string,
): string {
	return `Provider/agent error recovery exhausted after ${failureNumber} consecutive completed-on-error failures. Last error: ${lastError}`;
}

/**
 * Render the per-second countdown shown in the child pane while a recovery
 * window is armed. `failureNumber` is 1-based; the last window is the kill.
 */
export function formatCountdown(
	failureNumber: number,
	secondsRemaining: number,
	totalAttempts: number,
): string {
	const isFinal = failureNumber >= totalAttempts;
	const action = isFinal ? "final recovery attempt" : "automatic retry";
	return `Provider error — ${action} in ${secondsRemaining}s (${failureNumber}/${totalAttempts})`;
}
