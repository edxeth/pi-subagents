import type { CompletedSubagentResult, RunningSubagent, SubagentPingMessageDetails, SubagentResult } from "../types.ts";
import { formatContextExitNotice, formatFinalContextUsage, formatSessionRef } from "./final-context-usage.ts";
import { releaseSpawnWidthSlot } from "./spawn-width.ts";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	clearSubagentShutdownTimer,
	hasRealSubagentOutput,
	runningSubagents,
	stopAfterCurrentSubagentBatch,
} from "./state.ts";
import { formatTimeoutOutcome, formatTimeoutWrapUpOutcome, getTimeoutResultDetails } from "./timeout-budget.ts";

interface ParentMessageSink {
	sendMessage(message: unknown, options: unknown): void;
}

export interface RouteSubagentOutcomeOptions {
	pi: ParentMessageSink;
	running: RunningSubagent;
	result: SubagentResult;
	formatElapsed(elapsed: number): string;
	updateWidget(): void;
}

interface RoutedCompletionOutcome {
	kind: "completion";
	completed: CompletedSubagentResult;
}

interface RoutedPingOutcome {
	kind: "ping";
	delivered: boolean;
}

export type RoutedSubagentOutcome = RoutedCompletionOutcome | RoutedPingOutcome;

export function routeSubagentOutcome(options: RouteSubagentOutcomeOptions): RoutedSubagentOutcome {
	const { pi, running, result, formatElapsed, updateWidget } = options;
	clearSubagentShutdownTimer(running);
	if (result.ping) {
		runningSubagents.delete(running.id);
		updateWidget();
		if (running.allowSteerDelivery === false) {
			return { kind: "ping", delivered: false };
		}
		deliverSubagentPing(pi, running, result, formatElapsed);
		return { kind: "ping", delivered: true };
	}
	const completed =
		running.allowSteerDelivery === false && !running.resultOwner
			? buildCompletedSubagentResult(running, result)
			: cacheCompletedSubagentResult(running, result);
	releaseSpawnWidthSlot(running);
	runningSubagents.delete(running.id);
	updateWidget();
	if (running.allowSteerDelivery === false) {
		return { kind: "completion", completed };
	}
	return {
		kind: "completion",
		completed: deliverCompletedSubagentResult(pi, completed, formatElapsed),
	};
}

export function deliverCompletedSubagentResult(
	pi: ParentMessageSink,
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): CompletedSubagentResult {
	if (completed.deliveryState !== "detached" || completed.deliveredTo) {
		return completed;
	}

	const deliverAs = stopAfterCurrentSubagentBatch ? "nextTurn" : "steer";
	completed.deliveredTo = "steer";
	const sessionRef = formatSessionRef(completed);
	const contextRef =
		completed.reportContextUsage === false ? formatContextExitNotice(completed) : formatFinalContextUsage(completed);
	pi.sendMessage(
		{
			customType: "subagent_result",
			content: getCompletedSubagentContent(completed, formatElapsed, `${sessionRef}${contextRef}`),
			display: true,
			details: {
				id: completed.id,
				name: completed.name,
				task: completed.task,
				agent: completed.agent,
				mode: completed.mode,
				status: completed.status,
				deliveryState: completed.deliveryState,
				parentClosePolicy: completed.parentClosePolicy,
				blocking: completed.blocking,
				async: completed.async,
				exitCode: completed.exitCode,
				elapsed: completed.elapsed,
				outputTokens: completed.outputTokens,
				contextTokens: completed.contextTokens,
				contextWindow: completed.contextWindow,
				sessionFile: completed.sessionFile,
				...(completed.deliveryId ? { deliveryId: completed.deliveryId } : {}),
				...getTimeoutResultDetails(completed),
				...(completed.timeoutWrapUp ? { timeoutWrapUp: completed.timeoutWrapUp } : {}),
				...(completed.errorMessage ? { errorMessage: completed.errorMessage } : {}),
			},
		},
		{ triggerTurn: true, deliverAs },
	);
	return completed;
}

function deliverSubagentPing(
	pi: ParentMessageSink,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
): void {
	if (!result.ping) return;
	const sessionRef = result.sessionFile
		? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
		: "";
	pi.sendMessage(
		{
			customType: "subagent_ping",
			content:
				`Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}).\n\n` +
				`${result.ping.message}${sessionRef}`,
			display: true,
			details: {
				id: running.id,
				name: result.ping.name,
				task: running.task,
				agent: running.agent,
				mode: running.mode,
				deliveryState: running.deliveryState,
				parentClosePolicy: running.parentClosePolicy,
				blocking: running.blocking,
				async: running.async ?? !running.blocking,
				elapsed: result.elapsed,
				outputTokens: result.outputTokens,
				sessionFile: result.sessionFile,
				message: result.ping.message,
			} as SubagentPingMessageDetails,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function getCompletedSubagentContent(
	completed: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
	sessionRef: string,
): string {
	// A budget kill is the dominant fact about this run: without it the parent
	// reads an ordinary non-zero exit and retries the same runaway.
	if (completed.timedOut) {
		return `${formatTimeoutOutcome(
			{ ...completed, timedOut: completed.timedOut },
			hasRealSubagentOutput(completed),
			formatElapsed,
		)}${sessionRef}`;
	}
	if (completed.errorMessage) {
		const resultBody = hasRealSubagentOutput(completed)
			? `Last output before the failure (may be incomplete — verify before trusting):\n\n${completed.summary}`
			: completed.contextExhausted
				? `The subagent did not produce a result, and its context window is spent. ` +
					`A fresh subagent is usually better than resuming this session.`
				: `The subagent did not produce a result. You can retry by spawning a new ` +
					`subagent or resume the session with subagent_resume.`;
		return (
			`Sub-agent "${completed.name}" failed after ${formatElapsed(completed.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${completed.errorMessage}\n\n${resultBody}${sessionRef}`
		);
	}
	if (completed.exitCode === 0 && completed.timeoutWrapUp) {
		return `${formatTimeoutWrapUpOutcome(
			{ ...completed, timeoutWrapUp: completed.timeoutWrapUp },
			formatElapsed,
		)}${sessionRef}`;
	}
	return completed.exitCode !== 0
		? `Sub-agent "${completed.name}" failed (exit ${completed.exitCode}).\n\n${completed.summary}${sessionRef}`
		: `Sub-agent "${completed.name}" completed (${formatElapsed(completed.elapsed)}).\n\n${completed.summary}${sessionRef}`;
}
