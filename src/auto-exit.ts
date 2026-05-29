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

type AgentMessageLike = {
	role?: string;
	stopReason?: string;
};

/**
 * Decide whether a subagent should auto-exit after an agent turn ends.
 *
 * Manual input should not strand an auto-exit subagent. If the latest agent
 * turn completed normally, close the session. Escape/abort still leaves it
 * open for inspection or another prompt.
 *
 * `stopReason: "error"` (e.g. exhausted retries on a provider overload) also
 * returns true — we want to shut down so the parent is woken up — but the
 * caller should pair this with findLatestAssistantError() so the parent
 * learns it was an error, not a clean completion.
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
