import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BackgroundLaunchRuntime,
	launchBackgroundSubagent as launchBackgroundSubagentWithRuntime,
} from "../launch/background.ts";
import { getPiInvocation, getSubagentChildProcessEnv } from "../launch/child-command.ts";
import { type InteractiveLaunchRuntime, launchInteractiveSubagent } from "../launch/interactive.ts";
import type { SubagentLaunchContext } from "../launch/prep.ts";
import { cleanupNoSessionSessionFile } from "../launch/prep.ts";
import { closeSurfaceAsync } from "../mux/io.ts";
import { closeSurface } from "../mux.ts";
import type {
	CompletedSubagentResult,
	RunningSubagent,
	SubagentParamsInput,
	SubagentResult,
	WaitParams,
} from "../types.ts";
import {
	type BackgroundWatchRuntime,
	watchBackgroundSubagent as watchBackgroundSubagentWithRuntime,
} from "./background-watch.ts";
import { type InteractiveWatchRuntime, watchSubagent as watchSubagentWithRuntime } from "./interactive-watch.ts";
import {
	deliverCompletedSubagentResultViaSteer as deliverCompletedSubagentResultViaSteerWithDeps,
	findTrackedSubagent,
	getLaunchedSubagentResult as getLaunchedSubagentResultWithRuntime,
	getStartedSubagentDetails,
	routeDetachedSubagentCompletion as routeDetachedSubagentCompletionWithDeps,
	stopRunningSubagent as stopRunningSubagentWithDeps,
	wireSubagentSteerBack as wireSubagentSteerBackWithDeps,
} from "./running-registry.ts";
import {
	type ShutdownRuntime,
	type ShutdownSubagentsOptions,
	shutdownSubagentsForParentExit as shutdownSubagentsForParentExitWithRuntime,
	terminateBackgroundChildProcess,
} from "./shutdown.ts";
import {
	asSubagentToolResult,
	cacheCompletedSubagentResult,
	completedSubagentResults,
	moduleAbortController,
	resetRuntimeStateForTest,
	runningSubagents,
	widgetManager,
	withSubagentBatchStop,
} from "./state.ts";
import { type WaitRuntime, waitForSubagentResult as waitForSubagentResultWithRuntime } from "./wait.ts";
import { restartSubagentForTimeoutWrapUp } from "./timeout-wrap-up.ts";
import { requestVerifiedRunCancel } from "../vf/run/client.ts";

export {
	getWatcherSignal,
	moduleAbortController,
	runningSubagents,
	widgetManager,
} from "./state.ts";

export function formatElapsed(seconds: number): string {
	const s = Math.round(seconds);
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function getShellReadyDelayMs(): number {
	const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function updateWidget() {
	widgetManager.update();
}

export function startWidgetRefresh() {
	widgetManager.startRefresh();
}

export function getPiInvocationForTest(args: string[]) {
	return getPiInvocation(args);
}

export function getSubagentChildProcessEnvForTest(
	invocation: { command: string; args: string[] },
	envVars: Record<string, string>,
) {
	return getSubagentChildProcessEnv(invocation, envVars);
}

export function getCompletedSubagentResultForTest(id: string) {
	return completedSubagentResults.get(id);
}

export function resetSubagentStateForTest() {
	resetRuntimeStateForTest(() => {});
}

export function setRunningSubagentForTest(running: RunningSubagent) {
	runningSubagents.set(running.id, running);
}

export function renderSubagentWidgetForTest() {
	return widgetManager.renderForTest();
}

async function closeRunningSurface(running: RunningSubagent): Promise<void> {
	if (running.surfaceClosePromise) return running.surfaceClosePromise;
	if (!running.surface) return;
	const surface = running.surface;
	const closePromise = closeSurfaceAsync(surface, running.zellijTarget);
	running.surfaceClosePromise = closePromise;
	try {
		await closePromise;
		if (running.surface === surface) running.surface = undefined;
	} finally {
		if (running.surfaceClosePromise === closePromise) running.surfaceClosePromise = undefined;
	}
}

export async function stopRunningSubagent(
	running: RunningSubagent,
	options: { operator?: boolean } = {},
): Promise<void> {
	// A verified fan-out has no child process in this parent: its candidates
	// belong to a detached supervisor. Kill = cancel the run (supervisor kills
	// the candidate groups and terminalizes the manifest).
	if (running.verifiedRunDir) {
		if (running.verifiedRunCancelDenied && !options.operator) {
			throw new Error(
				`Subagent "${running.name}" is a verified fan-out this session observes but is not an authorized ` +
					`recipient of (${running.verifiedRunId}). Cancel it from the /subagents overlay as the operator, ` +
					`or resume the run's originating session.`,
			);
		}
		try {
			requestVerifiedRunCancel(running.verifiedRunDir);
		} catch {
			// surfaced by the cancelled manifest state instead
		}
	}
	await stopRunningSubagentWithDeps(running, closeRunningSurface);
	updateWidget();
}

export async function getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal) {
	return getLaunchedSubagentResultWithRuntime(
		running,
		{
			formatElapsed,
			updateWidget,
			waitForSubagentResult,
			withSubagentBatchStop,
			asSubagentToolResult,
		},
		signal,
	);
}

export function getStartedSubagentDetailsForTest(running: RunningSubagent) {
	return getStartedSubagentDetails(running);
}

export function getLaunchedSubagentResultForTest(running: RunningSubagent, signal?: AbortSignal) {
	return getLaunchedSubagentResult(running, signal);
}

export function routeDetachedSubagentCompletionForTest(
	pi: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	return routeDetachedSubagentCompletion(pi as ExtensionAPI, running, result);
}

function deliverCompletedSubagentResultViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cached: CompletedSubagentResult,
): CompletedSubagentResult {
	return deliverCompletedSubagentResultViaSteerWithDeps(pi, cached, formatElapsed);
}

function routeDetachedSubagentCompletion(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	return routeDetachedSubagentCompletionWithDeps(pi, running, result, formatElapsed, updateWidget);
}

export function wireSubagentSteerBack(
	pi: ExtensionAPI,
	running: RunningSubagent,
	watchPromise: Promise<SubagentResult>,
): void {
	wireSubagentSteerBackWithDeps(pi, running, watchPromise, formatElapsed, updateWidget);
}

function getWaitRuntime(): WaitRuntime {
	return {
		runningSubagents,
		completedSubagentResults,
		findTrackedSubagent,
		cacheCompletedSubagentResult,
		updateWidget,
		deliverCompletedSubagentResultViaSteer,
		stopRunningSubagent: (running) => stopRunningSubagentWithDeps(running, closeRunningSurface),
		closeSurface,
	};
}

async function waitForSubagentResult(params: WaitParams, signal?: AbortSignal) {
	return waitForSubagentResultWithRuntime(params, getWaitRuntime(), signal);
}

export function waitForSubagentForTest(params: WaitParams, signal?: AbortSignal) {
	return waitForSubagentResult(params, signal);
}

function getBackgroundLaunchRuntime(): BackgroundLaunchRuntime {
	return {
		getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
	};
}

export async function launchBackgroundSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
): Promise<RunningSubagent> {
	const running = await launchBackgroundSubagentWithRuntime(params, ctx, getBackgroundLaunchRuntime());
	runningSubagents.set(running.id, running);
	return running;
}

function getBackgroundWatchRuntime(): BackgroundWatchRuntime {
	return {
		cleanupNoSessionSessionFile,
		terminateBackgroundChildProcess,
		restartForTimeoutWrapUp: (running, signal) =>
			restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs }, signal),
	};
}

export async function watchBackgroundSubagent(running: RunningSubagent, signal?: AbortSignal) {
	return watchBackgroundSubagentWithRuntime(
		running,
		getBackgroundWatchRuntime(),
		signal ?? moduleAbortController.signal,
	);
}

function getInteractiveLaunchRuntime(): InteractiveLaunchRuntime {
	return {
		getContextWindow: (modelRef) => widgetManager.resolveModelContextWindow(modelRef),
		getShellReadyDelayMs,
	};
}

export async function launchSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	options?: { surface?: string },
): Promise<RunningSubagent> {
	const running = await launchInteractiveSubagent(params, ctx, getInteractiveLaunchRuntime(), options);
	runningSubagents.set(running.id, running);
	return running;
}

function getInteractiveWatchRuntime(): InteractiveWatchRuntime {
	return {
		cleanupNoSessionSessionFile,
		closeRunningSurface,
		restartForTimeoutWrapUp: (running, signal) =>
			restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs }, signal),
	};
}

export async function watchSubagent(running: RunningSubagent, signal?: AbortSignal) {
	return watchSubagentWithRuntime(running, getInteractiveWatchRuntime(), signal ?? moduleAbortController.signal);
}

function getShutdownRuntime(): ShutdownRuntime {
	return {
		runningSubagents,
		completedSubagentResults,
		parentCloseEscalationMs: 5000,
		updateWidget,
		closeRunningSurface,
	};
}

export function shutdownSubagentsForParentExit(options?: ShutdownSubagentsOptions) {
	return shutdownSubagentsForParentExitWithRuntime(getShutdownRuntime(), options);
}

export function shutdownSubagentsForTest(options?: ShutdownSubagentsOptions) {
	return shutdownSubagentsForParentExit(options);
}
