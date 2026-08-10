import { isContextOverflow } from "@earendil-works/pi-ai";

type SubagentErrorRecoveryKind = "none" | "provider" | "pi";

export interface SubagentErrorInfo {
	errorMessage: string;
	isRetryable: boolean;
	recoveryKind: SubagentErrorRecoveryKind;
	stopReason: "error";
}

const PERMANENT_PROVIDER_ERROR_PATTERNS = [
	/\busage limit\b|\binsufficient quota\b|\bout of budget\b|\bquota exceeded\b|\bcredit balance too low\b|\binsufficient(?: available)? balance\b|\bavailable balance (?:is )?(?:too low|zero|exhausted)\b|\bbilling\b|\bpayment method required\b|\baccount suspended\b/,
	/\bno api key\b|\bapi (?:key|token) (?:is )?(?:invalid|incorrect|expired|not valid|missing|required)\b|\b(?:invalid|incorrect|expired|missing) api (?:key|token)\b|\btoken (?:is )?(?:invalid|expired)\b|\bauth(?:entication|orization) (?:failed|failure|error|required)\b|\bunauthorized\b|\bforbidden\b|\baccess denied(?: exception)?\b|\baccessdeniedexception\b|\bdon t have access\b|\b(?:401|403)\b/,
	/\bmodel not found\b|\bunknown model\b|\bmodel\b.{0,100}\bdoes not exist\b/,
	/\bhttp (?:404|422)\b|\b404 not found\b|\b422 unprocessable entity\b|\bcontent filter\b|\bsafety filter\b|\bmoderation (?:blocked|failed|rejected|triggered)\b/,
] as const;

function normalizeProviderErrorMessage(errorMessage: string): string {
	return errorMessage
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

/**
 * Provider failures are eligible for bounded recovery by default. Pi may still
 * be retrying when the error event arrives, so the recovery controller waits
 * for a stable quiet window before nudging. Exclude only failures that are
 * clearly permanent without maintaining provider-specific allowlists.
 */
export function shouldRecoverProviderErrorMessage(errorMessage: string): boolean {
	const normalized = normalizeProviderErrorMessage(errorMessage);
	return !PERMANENT_PROVIDER_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function shouldDeferErrorForPiRecovery(message: unknown): boolean {
	return isContextOverflow(message as any);
}

/**
 * If the last assistant message ended with stopReason: "error", return its
 * error info so the parent can surface a clear failure. `recoveryKind` separates
 * bounded provider recovery from Pi-native context-overflow recovery. Provider
 * failures recover by default; clearly permanent quota, billing, auth, and
 * missing-model failures fail immediately.
 */
export function findLatestAssistantError(messages: any[] | undefined): SubagentErrorInfo | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		const errorMessage = raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).";
		const recoveryKind: SubagentErrorRecoveryKind =
			raw && shouldDeferErrorForPiRecovery(msg)
				? "pi"
				: raw && shouldRecoverProviderErrorMessage(raw)
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

export function shouldMarkUserTookOver(agentStarted: boolean, streamingBehavior?: InputStreamingBehavior): boolean {
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

export function endedAtToolUseBoundary(messages: unknown[] | undefined): boolean {
	if (!messages) return false;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		if (typeof message.stopReason !== "string") return false;
		return message.stopReason.replace(/[-_]/g, "").toLowerCase() === "tooluse";
	}
	return false;
}

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
export function shouldAutoExitOnAgentEnd(_messages: AgentMessageLike[] | undefined): boolean {
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
