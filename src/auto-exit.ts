export interface SubagentErrorInfo {
	errorMessage: string;
	stopReason: "error";
}

/**
 * If the last assistant message ended with stopReason: "error"
 * (auto-retry exhausted on overload / rate limit / server error),
 * return its error info so the parent can surface a clear failure.
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
		return {
			errorMessage:
				raw ||
				"Subagent agent loop ended with stopReason=error (no errorMessage field).",
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
 * pi-subagents' provider-error recovery resends the task as
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
