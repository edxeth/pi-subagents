import type { CompletedSubagentResult, ParentClosePolicy, ParentShutdownAction, RunningSubagent } from "../types.ts";
import { clearSubagentShutdownTimer } from "./state.ts";

export type ShutdownSubagentsOptions = {
	escalationMs?: number;
};

export interface ShutdownRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	completedSubagentResults: Map<string, CompletedSubagentResult>;
	parentCloseEscalationMs: number;
	updateWidget(): void;
	closeRunningSurface(running: RunningSubagent): Promise<void>;
}

export function terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void {
	if (!running.childProcess?.pid) return;
	try {
		process.kill(-running.childProcess.pid, signal);
	} catch {
		running.childProcess.kill(signal);
	}
}

function abortBackgroundSubagent(running: RunningSubagent, escalationMs: number): void {
	if (running.abortController) {
		running.abortController.abort();
		return;
	}

	terminateBackgroundChildProcess(running, "SIGTERM");
	if (!running.childProcess?.pid) return;
	clearSubagentShutdownTimer(running);
	running.shutdownTimer = setTimeout(() => {
		running.shutdownTimer = undefined;
		terminateBackgroundChildProcess(running, "SIGKILL");
	}, escalationMs);
	running.shutdownTimer.unref?.();
}

async function terminateInteractiveSubagent(running: RunningSubagent, runtime: ShutdownRuntime): Promise<void> {
	running.abortController?.abort();
	try {
		await runtime.closeRunningSurface(running);
	} catch {}
}

export async function shutdownSubagentsForParentExit(
	runtime: ShutdownRuntime,
	options: ShutdownSubagentsOptions = {},
): Promise<
	Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}>
> {
	const escalationMs = options.escalationMs ?? runtime.parentCloseEscalationMs;
	const actions: Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}> = [];

	for (const agent of runtime.runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.allowSteerDelivery = false;
		agent.resultOwner = undefined;
		agent.deliveryState = "detached";

		if (agent.parentClosePolicy === "continue") {
			actions.push({
				id: agent.id,
				policy: agent.parentClosePolicy,
				action: "continue",
			});
			continue;
		}

		actions.push({
			id: agent.id,
			policy: agent.parentClosePolicy,
			action: "terminate",
		});
		if (agent.mode === "interactive") {
			await terminateInteractiveSubagent(agent, runtime);
		} else {
			abortBackgroundSubagent(agent, escalationMs);
		}
	}

	runtime.runningSubagents.clear();
	runtime.completedSubagentResults.clear();
	runtime.updateWidget();
	return actions;
}
