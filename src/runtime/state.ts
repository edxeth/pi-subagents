import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getSubagentTerminalStopReason } from "../session/session.ts";
import type { CompletedSubagentResult, RunningSubagent, SubagentCompletionStatus, SubagentResult } from "../types.ts";
import { releaseSpawnWidthSlot, resetSpawnWidthForTest } from "./spawn-width.ts";
import { SubagentWidgetManager } from "./widget.ts";

export const runningSubagents = new Map<string, RunningSubagent>();
export const completedSubagentResults = new Map<string, CompletedSubagentResult>();

function getSubagentCompletionStatus(
	result: SubagentResult,
	running?: Pick<RunningSubagent, "mode" | "autoExit">,
): SubagentCompletionStatus {
	if (result.error === "cancelled") return "cancelled";
	// A runaway the runtime had to kill is never a completion, whatever it
	// managed to print before the signal. Without this an interactive child with
	// `auto-exit: false` and real output falls through to the operator-close
	// branch below and is filed as a success.
	if (result.timedOut) return "failed";
	// Provider/network errors may set errorMessage with exitCode 0
	// (Pi exits cleanly even when model calls fail after retry exhaustion).
	if (result.errorMessage) return "failed";
	if (getSubagentTerminalStopReason(result.summary)) return "failed";
	if (result.exitCode === 0) return "completed";
	// Manual interactive children (auto-exit: false) complete when the operator
	// closes the pane. A forced mux/pane close can leave the shell EXIT-trap with a
	// non-zero status; if the child already produced a real final assistant message
	// and the watcher did not hit an error path, that close is a successful operator
	// close rather than a crash.
	if (running?.mode === "interactive" && running.autoExit === false && !result.error && hasRealSubagentOutput(result)) {
		return "completed";
	}
	return "failed";
}

/** True when the summary came from the child rather than runtime diagnostics. */
export function hasRealSubagentOutput(result: Pick<SubagentResult, "summary" | "summarySource">): boolean {
	return result.summarySource !== "runtime" && result.summary.trim() !== "";
}

export function buildCompletedSubagentResult(
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	return {
		...result,
		id: running.id,
		agent: running.agent,
		mode: running.mode,
		status: getSubagentCompletionStatus(result, running),
		deliveryState: running.deliveryState,
		parentClosePolicy: running.parentClosePolicy,
		async: running.async !== false,
		autoExit: running.autoExit,
		reportContextUsage: running.reportContextUsage,
		deliveredTo: null,
	};
}

export function cacheCompletedSubagentResult(
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	const cached = buildCompletedSubagentResult(running, result);
	completedSubagentResults.set(running.id, cached);
	return cached;
}

export function clearSubagentShutdownTimer(running: RunningSubagent): void {
	if (!running.shutdownTimer) return;
	clearTimeout(running.shutdownTimer);
	running.shutdownTimer = undefined;
}

export const widgetManager = new SubagentWidgetManager(() => runningSubagents.values());

const WIDGET_MANAGER_KEY = Symbol.for("pi-subagents/widget-manager");
const MODULE_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

function initializeModuleReloadState(): AbortController {
	const previousWidgetManager = (globalThis as Record<PropertyKey, unknown>)[WIDGET_MANAGER_KEY] as
		| SubagentWidgetManager
		| undefined;
	previousWidgetManager?.reset();

	const previousAbortController = (globalThis as Record<PropertyKey, unknown>)[MODULE_ABORT_KEY] as
		| AbortController
		| undefined;
	previousAbortController?.abort();

	const controller = new AbortController();
	(globalThis as Record<PropertyKey, unknown>)[WIDGET_MANAGER_KEY] = widgetManager;
	(globalThis as Record<PropertyKey, unknown>)[MODULE_ABORT_KEY] = controller;
	return controller;
}

export type SubagentToolResult = AgentToolResult<unknown> & {
	terminate?: true;
};

export function asSubagentToolResult(result: unknown): SubagentToolResult {
	return result as SubagentToolResult;
}

export let moduleAbortController = initializeModuleReloadState();
export let stopAfterCurrentSubagentBatch = false;
let currentSubagentBatchHasBlocking = false;

export function resetSubagentBatchStopRequest(): void {
	stopAfterCurrentSubagentBatch = false;
	currentSubagentBatchHasBlocking = false;
}

export function markSubagentBatchBlocking(): void {
	currentSubagentBatchHasBlocking = true;
}

export function isSubagentBatchBlocking(): boolean {
	return currentSubagentBatchHasBlocking;
}

function isCoordinatorOnlyTurnDisabled(): boolean {
	return process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN === "1";
}

export function requestSubagentBatchStop(): void {
	if (isCoordinatorOnlyTurnDisabled()) return;
	stopAfterCurrentSubagentBatch = true;
}

export function getCoordinatorOnlyTurnPrompt(): string {
	if (isCoordinatorOnlyTurnDisabled()) {
		return "You may continue with non-overlapping work after launching a tool_return=later_message helper. Do not redo delegated work or claim results before the later report appears.";
	}
	return "For helpers with tool_return=later_message, the runtime may stop after this tool batch so the helper's later report can be inserted into this chat. Do not redo delegated work or claim results before the later report appears.";
}

export function getSubagentBatchStopMetadata(): { terminate?: true } {
	return stopAfterCurrentSubagentBatch && !currentSubagentBatchHasBlocking ? { terminate: true } : {};
}

export function withSubagentBatchStop<T extends AgentToolResult<unknown>>(result: T): T & { terminate?: true } {
	return {
		...result,
		...getSubagentBatchStopMetadata(),
	};
}

export function getWatcherSignal(_running: RunningSubagent, watcherAbort: AbortController): AbortSignal {
	return watcherAbort.signal;
}

export function resetRuntimeStateForTest(resetAmbient: () => void): void {
	resetAmbient();
	// A test may abort the module controller; the next test needs a live one.
	moduleAbortController = initializeModuleReloadState();
	for (const agent of runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.abortController?.abort();
		releaseSpawnWidthSlot(agent);
	}
	runningSubagents.clear();
	completedSubagentResults.clear();
	resetSpawnWidthForTest();
	resetSubagentBatchStopRequest();
	widgetManager.reset();
}
