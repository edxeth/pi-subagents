import { existsSync, statSync } from "node:fs";
import { getTerminalAssistantSummary, shouldReapStableTerminalSummary } from "../agents/titles.ts";
import { consumeSubagentExitSignal } from "../mux.ts";
import { hasSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { findLastSubagentOutputWithSource, getEntries, getEntryCount, getNewEntries } from "../session/session.ts";
import { writeSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import type { RunningSubagent, SessionEntryLike, SubagentResult, SubagentSummarySource } from "../types.ts";
import { resolveFinalContextUsage } from "./final-context-usage.ts";
import {
	TIMEOUT_KILL_ESCALATION_MS,
	checkSubagentTimeout,
	hasChildProgress,
	observeSubagentProgress,
} from "./timeout-budget.ts";

export interface BackgroundWatchRuntime {
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
	terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void;
}

export interface BackgroundWatchOptions {
	/** Grace before a timeout kill escalates to SIGKILL. Injectable for tests. */
	timeoutKillEscalationMs?: number;
}

function terminateChildProcessGroup(running: RunningSubagent, signal: NodeJS.Signals): void {
	const child = running.childProcess!;
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

/**
 * True while any process in the child's group still exists.
 *
 * The group, not the leader: a leader can exit while the descendants it
 * spawned keep running, and those are the processes still burning the budget.
 */
function isChildProcessGroupAlive(running: RunningSubagent): boolean {
	const pid = running.childProcess?.pid;
	if (!pid) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Watch a background subagent until it exits. Listens for the child process
 * exit event, polls the session file for widget updates, and handles abort.
 */
export function watchBackgroundSubagent(
	running: RunningSubagent,
	runtime: BackgroundWatchRuntime,
	signal: AbortSignal,
	options: BackgroundWatchOptions = {},
): Promise<SubagentResult> {
	const child = running.childProcess!;
	const terminalGraceMs = 1000;
	const killEscalationMs = options.timeoutKillEscalationMs ?? TIMEOUT_KILL_ESCALATION_MS;

	return new Promise((resolve) => {
		let settled = false;
		let terminalSummary: string | null = null;
		let terminalSeenAt = 0;

		const cleanup = () => {
			clearInterval(pollInterval);
			if (running.timeoutKillTimer) {
				clearTimeout(running.timeoutKillTimer);
				running.timeoutKillTimer = undefined;
			}
			signal.removeEventListener("abort", onAbort);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};

		const finish = (result: SubagentResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			runtime.cleanupNoSessionSessionFile(running);
			resolve(result);
		};

		// A spent budget must terminate the child even when it has no session
		// file to poll, so this runs outside the session-stat block.
		const enforceTimeoutBudget = (now: number): boolean => {
			const expired = checkSubagentTimeout(running, now);
			if (!expired) return false;
			// The only honest moment to ask whether the child beat the deadline is
			// before the signal goes out. Its Pi process writes an ordinary `done`
			// on the way out of our own SIGTERM, so anything published after this
			// point is a consequence of the kill, not a verdict that outranks it.
			if (hasSubagentExitSidecar(running.sessionFile)) return false;
			running.timeoutExpiry = expired;
			runtime.terminateBackgroundChildProcess(running, "SIGTERM");
			running.timeoutKillTimer = setTimeout(() => {
				running.timeoutKillTimer = undefined;
				if (settled) return;
				// Liveness is the only thing that may cancel this. The child writes
				// an ordinary `done` sidecar from its shutdown hook *because of* the
				// SIGTERM we just sent, so reading that as "it finished, stand down"
				// would let any child that publishes and then hangs survive its
				// budget. The grace period is for dying, not for publishing.
				if (!isChildProcessGroupAlive(running)) return;
				runtime.terminateBackgroundChildProcess(running, "SIGKILL");
			}, killEscalationMs);
			running.timeoutKillTimer.unref?.();
			return true;
		};

		const pollInterval = setInterval(() => {
			const now = Date.now();
			let sessionReadable = false;
			try {
				if (existsSync(running.sessionFile)) {
					const stat = statSync(running.sessionFile);
					const previousEntries = running.entries ?? 0;
					const entries = getEntryCount(running.sessionFile);
					// Only the child's own output restarts the idle clock. Reading
					// just the new lines keeps this cheap on a long session.
					const produced =
						entries > previousEntries ? hasChildProgress(getNewEntries(running.sessionFile, previousEntries)) : false;
					observeSubagentProgress(running, stat.size, now, produced);
					running.entries = entries;
					sessionReadable = !running.noSession;
				}
			} catch {}
			if (enforceTimeoutBudget(now)) return;
			if (!sessionReadable) return;
			try {
				if (!shouldReapStableTerminalSummary(running)) return;
				const summary = getTerminalAssistantSummary(
					(getEntries(running.sessionFile) as SessionEntryLike[]).slice(running.launchEntryCount ?? 0),
				);
				if (!summary) {
					terminalSummary = null;
					terminalSeenAt = 0;
					return;
				}
				if (summary !== terminalSummary) {
					terminalSummary = summary;
					terminalSeenAt = Date.now();
					return;
				}
				if (Date.now() - terminalSeenAt < terminalGraceMs) return;
				runtime.terminateBackgroundChildProcess(running, "SIGTERM");
			} catch {}
		}, 1000);

		const onAbort = () => {
			terminateChildProcessGroup(running, "SIGTERM");
			setTimeout(() => {
				if (!child.killed && child.pid) terminateChildProcessGroup(running, "SIGKILL");
			}, 5000);
		};
		const onExit = (code: number | null) => {
			const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
			const exitSignal = consumeSubagentExitSignal(running.sessionFile);
			// A ping is child-initiated and asks the parent for help, so it still
			// outranks the kill. A `done` at this point does not: see above.
			const timedOut = running.timeoutExpiry && exitSignal?.reason !== "ping" ? running.timeoutExpiry : undefined;
			// A child shut down by the runtime often exits cleanly. Reporting that
			// as exit 0 would file a killed runaway as a success.
			const exitCode = timedOut ? (code || 1) : (exitSignal?.exitCode ?? code ?? 1);
			const errorMessage = exitSignal?.reason === "error" ? exitSignal.errorMessage : undefined;
			const finalContextUsage = resolveFinalContextUsage(running, exitSignal);
			const stderr = running.stderrTail?.trim();
			const stdout = running.stdoutTail?.trim();
			let summary = `Background agent exited with code ${exitCode}`;
			let summarySource: SubagentSummarySource = "runtime";
			if (!running.noSession && existsSync(running.sessionFile)) {
				const allEntries = getNewEntries(running.sessionFile, running.launchEntryCount ?? 0);
				const output = findLastSubagentOutputWithSource(allEntries);
				if (output) {
					({ summary, summarySource } = output);
				} else if (exitCode !== 0 && stderr) {
					summary = `Background agent exited with code ${exitCode}\n\n${stderr}`;
				} else if (exitCode === 0 && stdout) {
					summary = stdout;
					summarySource = "subagent";
				} else if (exitCode === 0) {
					summary = "Background agent exited without output";
				}
			} else if (stdout) {
				summary = stdout;
				summarySource = "subagent";
			} else if (exitCode !== 0 && stderr) {
				summary = `Background agent exited with code ${exitCode}\n\n${stderr}`;
			}
			if (timedOut) {
				if (!running.noSession) {
					writeSubagentTimeoutSidecar(running.sessionFile, {
						kind: timedOut.kind,
						blocksResume: running.timeoutBlocksResume === true,
						...(running.timeoutBudget ? { budget: running.timeoutBudget } : {}),
					});
				}
			}
			finish({
				name: running.name,
				task: running.task,
				summary,
				summarySource,
				sessionFile: running.noSession ? undefined : running.sessionFile,
				exitCode,
				elapsed,
				outputTokens: exitSignal?.outputTokens,
				...finalContextUsage,
				...(timedOut
					? {
							timedOut: timedOut.kind,
							timedOutAfter: timedOut.seconds,
							...(running.timeoutBlocksResume === true ? { timeoutBlocksResume: true } : {}),
						}
					: {}),
				ping: exitSignal?.ping,
				errorMessage,
			});
		};
		const onError = (error: Error) => {
			finish({
				name: running.name,
				task: running.task,
				summary: `Background agent failed to start: ${error.message}`,
				summarySource: "runtime",
				sessionFile: running.noSession ? undefined : running.sessionFile,
				exitCode: 1,
				elapsed: Math.floor((Date.now() - running.startTime) / 1000),
				error: error.message,
			});
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.once("exit", onExit);
		child.once("error", onError);
	});
}
