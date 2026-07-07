import { isContextOverflow } from "@earendil-works/pi-ai";

type SubagentErrorRecoveryKind = "none" | "provider" | "pi";

export interface SubagentErrorInfo {
	errorMessage: string;
	isRetryable: boolean;
	recoveryKind: SubagentErrorRecoveryKind;
	stopReason: "error";
}

const NON_RETRYABLE_PROVIDER_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

const RETRYABLE_PROVIDER_ERROR_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

export function isRetryableProviderErrorMessage(errorMessage: string): boolean {
	if (NON_RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

export function shouldDeferErrorForPiRecovery(message: unknown): boolean {
	return isContextOverflow(message as any);
}

/**
 * If the last assistant message ended with stopReason: "error", return its
 * error info so the parent can surface a clear failure. `recoveryKind` separates
 * transient provider/transport retries from Pi-native context-overflow recovery.
 * Permanent quota/billing/auth failures should fail immediately.
 */
export function findLatestAssistantError(
	messages: any[] | undefined,
): SubagentErrorInfo | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw =
			typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		const errorMessage =
			raw ||
			"Subagent agent loop ended with stopReason=error (no errorMessage field).";
		const recoveryKind: SubagentErrorRecoveryKind =
			!!raw && shouldDeferErrorForPiRecovery(msg)
				? "pi"
				: !!raw && isRetryableProviderErrorMessage(raw)
					? "provider"
					: "none";
		return {
			errorMessage,
			isRetryable: recoveryKind !== "none",
			recoveryKind,
			stopReason: "error",
		};
	}
	return null;
}

export type InputStreamingBehavior = "steer" | "followUp" | undefined;

export function shouldMarkUserTookOver(
	agentStarted: boolean,
	streamingBehavior?: InputStreamingBehavior,
): boolean {
	return agentStarted || streamingBehavior === "steer" || streamingBehavior === "followUp";
}

/**
 * Whether an `input` event represents the operator (not the extension itself).
 *
 * pi-subagents' provider-error recovery sends a nudge with
 * `pi.sendUserMessage(...)`, which Pi delivers with `source: "extension"`. That
 * nudge is autonomous recovery, not operator steering — treating it as takeover
 * would cancel the recovery and reset the consecutive-failure chain on every
 * nudge, looping forever instead of escalating to the kill.
 */
export function isOperatorInput(source: unknown): boolean {
	return source !== "extension";
}

type AgentMessageLike = {
	role?: string;
	stopReason?: string;
};

/**
 * Decide whether an auto-exit subagent reached a terminal agent turn.
 *
 * Manual input should not strand an auto-exit subagent. If the latest agent
 * turn completed normally, close the session. Escape/abort still leaves it
 * open for inspection or another prompt.
 *
 * `stopReason: "error"` also returns true because it is terminal from the
 * current agent turn's point of view. The child-side lifecycle code must still
 * let Pi's provider retries and pi-subagents recovery backoff run before it
 * actually shuts the child down.
 */
export function shouldAutoExitOnAgentEnd(
	_messages: AgentMessageLike[] | undefined,
): boolean {
	if (_messages) {
		for (let i = _messages.length - 1; i >= 0; i--) {
			const msg = _messages[i];
			if (msg?.role === "assistant") {
				return msg.stopReason !== "aborted";
			}
		}
	}

	return true;
}
