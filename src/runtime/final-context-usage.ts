import { existsSync } from "node:fs";
import { splitModelRef } from "../agents/model-refs.ts";
import type { PollResult } from "../mux/poll.ts";
import { findLatestAssistantContextSnapshot, getNewEntries } from "../session/session.ts";
import { endedUnderContextPressure } from "../session/completion-reason.ts";
import type { RunningSubagent } from "../types.ts";

export interface FinalContextUsage {
	contextTokens?: number;
	contextWindow?: number;
	/** True when the child's exit was owned by its context-warning policy. */
	contextWarned?: boolean;
	/** True when the child failed while its context was already spent. */
	contextExhausted?: boolean;
	/** Set when the child failed; a failure is never an instructed wrap-up. */
	errorMessage?: string;
}

/**
 * Session reference for a finished child. Nothing is shown once the run ended
 * under context pressure, or once a timeout kill the agent marked
 * `on-timeout: block-resume` refuses: the guard refuses those resumes, and a
 * path or command in model-visible text is an invitation to route around it
 * with a shell. The operator still gets the path from the structured result
 * details.
 */
export function formatSessionRef(
	result: FinalContextUsage & { sessionFile?: string; timedOut?: string; timeoutBlocksResume?: boolean },
): string {
	if (!result.sessionFile) return "";
	if (result.contextWarned) return "";
	if (result.timeoutBlocksResume) return "";
	// A raw `pi --session` run is not a tracked child, so it carries no budget:
	// handing that command to a model right after telling it a resume stays
	// bounded would advertise the one path that reruns the runaway unbounded.
	if (result.timedOut) {
		return (
			`\n\nSession: ${result.sessionFile}\n` +
			"To continue this work, use the subagent_resume tool. It applies the same limit again. " +
			"Do not open this file with a plain pi --session command, because that run has no limit."
		);
	}
	return `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
}

function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return `${Math.round(tokens)}`;
}

const CONTEXT_EXIT_NOTICE =
	"stopped early as instructed by its context-warning policy: " +
	"check what is unfinished and launch a fresh sub-agent for it if needed. " +
	"A short or partial report here is expected and not a failure. " +
	"Do not resume this session; resuming re-does already-summarized work and wastes a turn.";

export function formatFinalContextUsage(result: FinalContextUsage): string {
	const used = result.contextTokens;
	const maximum = result.contextWindow;
	if (
		typeof used !== "number" ||
		typeof maximum !== "number" ||
		!Number.isFinite(used) ||
		!Number.isFinite(maximum) ||
		used < 0 ||
		maximum <= 0
	) {
		// The counts are unusable, but an instructed stop must still be explained.
		return formatContextExitNotice(result);
	}
	const percent = Math.floor(Math.min((used / maximum) * 100, 100));
	const usage =
		`\n\nSub-agent context: ${formatCompactTokens(used)}/` +
		`${formatCompactTokens(maximum)} tokens (${percent}%) used at finish.`;
	if (!result.contextWarned) return usage;
	// A failed child did not wrap up as instructed, so the reassurance would lie.
	if (result.errorMessage) return usage;
	// Without this the parent reads a deliberate, policy-driven wrap-up as a
	// premature exit and resumes the child into a context it cannot work in.
	return `${usage} It ${CONTEXT_EXIT_NOTICE}`;
}

/**
 * The parent must learn that an early stop was instructed even when the agent
 * turned off usage reporting, otherwise it resumes a child that cannot work.
 * Reports the reason without the token counts that `report-context-usage:
 * false` opts out of.
 */
export function formatContextExitNotice(result: FinalContextUsage): string {
	if (!result.contextWarned || result.errorMessage) return "";
	return `\n\nSub-agent ${CONTEXT_EXIT_NOTICE}`;
}

export function resolveFinalContextUsage(
	running: RunningSubagent,
	exitSignal: PollResult | null | undefined,
): FinalContextUsage {
	// The exit sidecar is authoritative: a `--no-session` child persists nothing,
	// so its session entries can never carry this.
	const warned: { contextWarned?: true } =
		exitSignal?.completionReason === "context-pressure"
			? { contextWarned: true }
			: wasContextWarned(running);
	const exhausted: { contextExhausted?: true } =
		exitSignal?.completionReason === "context-pressure-failure" ? { contextExhausted: true } : {};
	if (typeof exitSignal?.contextTokens === "number" && typeof exitSignal.contextWindow === "number") {
		return {
			contextTokens: exitSignal.contextTokens,
			contextWindow: exitSignal.contextWindow,
			...warned,
			...exhausted,
		};
	}
	if (running.noSession || !running.modelContextWindow || !existsSync(running.sessionFile)) {
		return { ...warned, ...exhausted };
	}
	try {
		const snapshot = findLatestAssistantContextSnapshot(
			getNewEntries(running.sessionFile, running.launchEntryCount ?? 0),
		);
		const launchModel = running.modelRef ? splitModelRef(running.modelRef).model : undefined;
		const snapshotModel = snapshot?.provider && snapshot.model ? `${snapshot.provider}/${snapshot.model}` : undefined;
		if (!snapshot || !launchModel || launchModel !== snapshotModel) return { ...warned, ...exhausted };
		return {
			contextTokens: snapshot.contextTokens,
			contextWindow: running.modelContextWindow,
			...warned,
			...exhausted,
		};
	} catch {
		return { ...warned, ...exhausted };
	}
}

/**
 * A child records every delivered context warning in its own session. Thresholds
 * it is still holding at the end mean it was told to wrap up early, which the
 * parent must not mistake for a premature or failed exit.
 */
function wasContextWarned(running: RunningSubagent): { contextWarned?: true } {
	// Ephemeral children count too: their session file is removed only after the
	// watcher has built the result, so the warning is still readable here.
	return endedUnderContextPressure(running.sessionFile) ? { contextWarned: true } : {};
}
