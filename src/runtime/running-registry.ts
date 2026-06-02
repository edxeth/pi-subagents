import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	CompletedSubagentResult,
	RunningSubagent,
	StartedSubagentToolDetails,
	SubagentResult,
} from "../types.ts";
import {
	clearSubagentShutdownTimer,
	completedSubagentResults,
	getSubagentBatchStopMetadata,
	isSubagentBatchBlocking,
	requestSubagentBatchStop,
	runningSubagents,
} from "./state.ts";
import {
	deliverCompletedSubagentResult,
	routeSubagentOutcome,
} from "./result-router.ts";

export interface RunningRegistryRuntime {
	formatElapsed(elapsed: number): string;
	updateWidget(): void;
	waitForSubagentResult(params: { id: string }, signal?: AbortSignal): Promise<unknown>;
	withSubagentBatchStop(result: any): any;
	asSubagentToolResult(result: unknown): any;
}

export function findRunningSubagent(query: string): {
	running?: RunningSubagent;
	error?: string;
} {
	const byId = runningSubagents.get(query);
	if (byId) return { running: byId };

	const exactNameMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactNameMatches.length === 1) return { running: exactNameMatches[0] };
	if (exactNameMatches.length > 1) {
		return { error: `Multiple subagents named "${query}". Use the id instead.` };
	}

	const normalizedQuery = query.toLowerCase();
	const ciMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciMatches.length === 1) return { running: ciMatches[0] };
	if (ciMatches.length > 1) {
		return { error: `Multiple subagents named "${query}". Use the id instead.` };
	}

	return { error: `No running subagent matches "${query}".` };
}

export function findTrackedSubagent(query: string): {
	id?: string;
	running?: RunningSubagent;
	cached?: CompletedSubagentResult;
	error?: string;
} {
	const cachedById = completedSubagentResults.get(query);
	if (cachedById) return { id: cachedById.id, cached: cachedById };
	const runningById = runningSubagents.get(query);
	if (runningById) return { id: runningById.id, running: runningById };

	const exactCachedMatches = [...completedSubagentResults.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactCachedMatches.length === 1) {
		return { id: exactCachedMatches[0].id, cached: exactCachedMatches[0] };
	}
	if (exactCachedMatches.length > 1) {
		return {
			error: `Multiple completed subagents match "${query}". Use the id instead.`,
		};
	}

	const exactRunningMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactRunningMatches.length === 1) {
		return { id: exactRunningMatches[0].id, running: exactRunningMatches[0] };
	}
	if (exactRunningMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	const normalizedQuery = query.toLowerCase();
	const ciCachedMatches = [...completedSubagentResults.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciCachedMatches.length === 1) {
		return { id: ciCachedMatches[0].id, cached: ciCachedMatches[0] };
	}
	if (ciCachedMatches.length > 1) {
		return {
			error: `Multiple completed subagents match "${query}". Use the id instead.`,
		};
	}

	const ciRunningMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciRunningMatches.length === 1) {
		return { id: ciRunningMatches[0].id, running: ciRunningMatches[0] };
	}
	if (ciRunningMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	return { error: `No subagent matches "${query}".` };
}

export function stopRunningSubagent(
	running: RunningSubagent,
	closeSurface: (surface: string) => void,
): void {
	clearSubagentShutdownTimer(running);
	running.abortController?.abort();

	// Always kill the child process/surface regardless of abortController.
	// abortController only stops the watcher polling loop; the child would
	// otherwise keep running and deliver stale results via steer.
	if (running.childProcess?.pid) {
		try {
			process.kill(-running.childProcess.pid, "SIGTERM");
		} catch {
			running.childProcess.kill("SIGTERM");
		}
	}
	if (running.surface) {
		try {
			closeSurface(running.surface);
		} catch {}
	}
}

export function getStartedSubagentDetails(
	running: RunningSubagent,
): StartedSubagentToolDetails & Record<string, unknown> {
	return {
		id: running.id,
		name: running.name,
		title: running.title,
		task: running.task,
		agent: running.agent,
		sessionFile: running.noSession ? undefined : running.sessionFile,
		noSession: running.noSession,
		status: "started" as const,
		mode: running.mode,
		deliveryState: running.deliveryState,
		parentClosePolicy: running.parentClosePolicy,
		async: running.async !== false,
		autoExit: running.autoExit,
	};
}

function getStartedSubagentResult(running: RunningSubagent) {
	const isAsync = running.async ?? !(running.blocking ?? false);
	if (isAsync) requestSubagentBatchStop();
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Sub-agent "${running.name}" launched ${isAsync ? "async" : "sync"} with id ${running.id}. ` +
					(isAsync
						? `Results will be delivered automatically as a steer message when it finishes. `
						: `The parent is waiting for this result before continuing. `) +
					`Use this exact id if you need to resume or stop this child.`,
			},
		],
		details: getStartedSubagentDetails(running),
		...getSubagentBatchStopMetadata(),
	};
}

export async function getLaunchedSubagentResult(
	running: RunningSubagent,
	runtime: RunningRegistryRuntime,
	signal?: AbortSignal,
) {
	const parentShouldWait = shouldAwaitSubagentLaunch(running);
	if (!parentShouldWait) return getStartedSubagentResult(running);
	const result = await runtime.waitForSubagentResult({ id: running.id }, signal);
	return runtime.withSubagentBatchStop(runtime.asSubagentToolResult(result));
}

/**
 * Whether the parent should await this subagent launch synchronously instead
 * of returning a started result. True when the agent is blocking
 * (`async: false` in frontmatter or via launch param) OR when the current
 * tool batch was marked blocking by the message_end mixed-batch classifier.
 *
 * Shared between the subagent and subagent_resume tools so both paths agree
 * on the await decision and inherit the same mixed-batch sync semantics.
 */
export function shouldAwaitSubagentLaunch(
	running: Pick<RunningSubagent, "blocking" | "async">,
): boolean {
	return (running.blocking ?? false) || isSubagentBatchBlocking();
}

export function deliverCompletedSubagentResultViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cached: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): CompletedSubagentResult {
	return deliverCompletedSubagentResult(pi, cached, formatElapsed);
}

export function routeDetachedSubagentCompletion(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
	updateWidget: () => void,
): CompletedSubagentResult {
	const routed = routeSubagentOutcome({
		pi,
		running,
		result,
		formatElapsed,
		updateWidget,
	});
	if (routed.kind !== "completion") {
		throw new Error("routeDetachedSubagentCompletion received a child ping result");
	}
	return routed.completed;
}

function handleDetachedSubagentOutcome(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
	updateWidget: () => void,
): void {
	routeSubagentOutcome({
		pi,
		running,
		result,
		formatElapsed,
		updateWidget,
	});
}

export function wireSubagentSteerBack(
	pi: ExtensionAPI,
	running: RunningSubagent,
	watchPromise: Promise<SubagentResult>,
	formatElapsed: (elapsed: number) => string,
	updateWidget: () => void,
): void {
	watchPromise
		.then((result) => {
			handleDetachedSubagentOutcome(pi, running, result, formatElapsed, updateWidget);
		})
		.catch((err) => {
			runningSubagents.delete(running.id);
			updateWidget();
			pi.sendMessage(
				{
					customType: "subagent_result",
					content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
					display: true,
					details: {
						id: running.id,
						name: running.name,
						task: running.task,
						deliveryState: running.deliveryState,
						parentClosePolicy: running.parentClosePolicy,
						error: err?.message,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		});
}
