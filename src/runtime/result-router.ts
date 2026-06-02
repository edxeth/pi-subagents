import type {
	CompletedSubagentResult,
	RunningSubagent,
	SubagentPingMessageDetails,
	SubagentResult,
} from "../types.ts";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	clearSubagentShutdownTimer,
	runningSubagents,
	stopAfterCurrentSubagentBatch,
} from "./state.ts";

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

export function routeSubagentOutcome(
	options: RouteSubagentOutcomeOptions,
): RoutedSubagentOutcome {
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
	const completed = running.allowSteerDelivery === false && !running.resultOwner
		? buildCompletedSubagentResult(running, result)
		: cacheCompletedSubagentResult(running, result);
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
	const sessionRef = completed.sessionFile
		? `\n\nSession: ${completed.sessionFile}\nResume: pi --session ${completed.sessionFile}`
		: "";
	pi.sendMessage(
		{
			customType: "subagent_result",
			content: getCompletedSubagentContent(completed, formatElapsed, sessionRef),
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
				sessionFile: completed.sessionFile,
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
	if (completed.errorMessage) {
		return (
			`Sub-agent "${completed.name}" failed after ${formatElapsed(completed.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${completed.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent or resume the session with subagent_resume.${sessionRef}`
		);
	}
	return completed.exitCode !== 0
		? `Sub-agent "${completed.name}" failed (exit ${completed.exitCode}).\n\n${completed.summary}${sessionRef}`
		: `Sub-agent "${completed.name}" completed (${formatElapsed(completed.elapsed)}).\n\n${completed.summary}${sessionRef}`;
}
