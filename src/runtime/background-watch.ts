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
	checkSubagentTimeoutWrapUp,
	type ExpiredTimeoutBudget,
	getSubagentNextDeadlineAt,
	hasChildProgress,
	observeSubagentProgress,
} from "./timeout-budget.ts";
import { startTimeoutWrapUpWithinDeadline } from "./timeout-restart.ts";

export interface BackgroundWatchRuntime {
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
	terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void;
	restartForTimeoutWrapUp?(running: RunningSubagent, signal: AbortSignal): Promise<void>;
}

export interface BackgroundWatchOptions {
	/** Grace before a timeout kill escalates to SIGKILL. Injectable for tests. */
	timeoutKillEscalationMs?: number;
}

type BackgroundGenerationOutcome = { kind: "restart" } | { kind: "result"; result: SubagentResult };

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
	return pid ? isProcessGroupAlive(pid) : false;
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function terminateBackgroundGeneration(
	running: RunningSubagent,
	runtime: BackgroundWatchRuntime,
	escalationMs: number,
): Promise<void> {
	const pid = running.childProcess?.pid;
	runtime.terminateBackgroundChildProcess(running, "SIGTERM");
	if (!pid) return;
	const escalationAt = Date.now() + escalationMs;
	const giveUpAt = escalationAt + 1000;
	let escalated = false;
	while (isProcessGroupAlive(pid) && Date.now() < giveUpAt) {
		if (!escalated && Date.now() >= escalationAt) {
			escalated = true;
			runtime.terminateBackgroundChildProcess(running, "SIGKILL");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (isProcessGroupAlive(pid)) running.timeoutKillFailed = true;
}

function buildBackgroundRestartTimeoutResult(
	running: RunningSubagent,
	expiry: ExpiredTimeoutBudget,
): SubagentResult {
	let summary = "The report-only continuation could not start before the original hard deadline.";
	let summarySource: SubagentSummarySource = "runtime";
	if (existsSync(running.sessionFile)) {
		const output = findLastSubagentOutputWithSource(
			getNewEntries(running.sessionFile, running.launchEntryCount ?? 0),
		);
		if (output) ({ summary, summarySource } = output);
	}
	if (!running.noSession) {
		writeSubagentTimeoutSidecar(running.sessionFile, {
			kind: expiry.kind,
			blocksResume: running.timeoutBlocksResume === true,
			...(running.timeoutBudget ? { budget: running.timeoutBudget } : {}),
		});
	}
	return {
		name: running.name,
		task: running.task,
		summary,
		summarySource,
		sessionFile: running.noSession ? undefined : running.sessionFile,
		exitCode: 1,
		elapsed: Math.floor((Date.now() - running.startTime) / 1000),
		timedOut: expiry.kind,
		timedOutAfter: expiry.seconds,
		...(running.timeoutBlocksResume === true ? { timeoutBlocksResume: true } : {}),
		...(running.timeoutKillFailed === true ? { timeoutKillFailed: true } : {}),
		...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
	};
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
	return watchBackgroundSubagentUntilFinal(running, runtime, signal, options);
}

async function watchBackgroundSubagentUntilFinal(
	running: RunningSubagent,
	runtime: BackgroundWatchRuntime,
	signal: AbortSignal,
	options: BackgroundWatchOptions,
): Promise<SubagentResult> {
	try {
		while (true) {
			const outcome = await watchBackgroundGeneration(running, runtime, signal, options);
			if (outcome.kind === "result") return outcome.result;
			if (signal.aborted) return buildBackgroundCancellationResult(running);
			try {
				if (!runtime.restartForTimeoutWrapUp) {
					throw new Error("Timeout wrap-up restart is unavailable.");
				}
				const restart = await startTimeoutWrapUpWithinDeadline(running, signal, {
					restart: runtime.restartForTimeoutWrapUp,
					stopStarted: (current) =>
						terminateBackgroundGeneration(
							current,
							runtime,
							options.timeoutKillEscalationMs ?? TIMEOUT_KILL_ESCALATION_MS,
						),
				});
				if (restart.kind === "cancelled") return buildBackgroundCancellationResult(running);
				if (restart.kind === "timedOut") {
					return buildBackgroundRestartTimeoutResult(running, restart.expiry);
				}
				running.timeoutWrapUpMode = true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					name: running.name,
					task: running.task,
					summary: `The system interrupted this sub-agent for its time-limit wrap-up, but the wrap-up continuation failed to start: ${message}`,
					summarySource: "runtime",
					sessionFile: running.noSession ? undefined : running.sessionFile,
					exitCode: 1,
					elapsed: Math.floor((Date.now() - running.startTime) / 1000),
					error: message,
					...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
				};
			}
		}
	} finally {
		runtime.cleanupNoSessionSessionFile(running);
	}
}

function watchBackgroundGeneration(
	running: RunningSubagent,
	runtime: BackgroundWatchRuntime,
	signal: AbortSignal,
	options: BackgroundWatchOptions,
): Promise<BackgroundGenerationOutcome> {
	const child = running.childProcess!;
	const processGroupPid = child.pid;
	const terminalGraceMs = 1000;
	const killEscalationMs = options.timeoutKillEscalationMs ?? TIMEOUT_KILL_ESCALATION_MS;

	return new Promise((resolve) => {
		let settled = false;
		let terminalSummary: string | null = null;
		let terminalSeenAt = 0;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		let groupExitPoll: ReturnType<typeof setInterval> | undefined;

		const cleanup = () => {
			clearInterval(pollInterval);
			if (deadlineTimer) clearTimeout(deadlineTimer);
			if (groupExitPoll) clearInterval(groupExitPoll);
			if (running.timeoutKillTimer) {
				clearTimeout(running.timeoutKillTimer);
				running.timeoutKillTimer = undefined;
			}
			signal.removeEventListener("abort", onAbort);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};

		const finish = (outcome: BackgroundGenerationOutcome) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(outcome);
		};

		const beginKill = () => {
			if (!running.timeoutKillTimer) {
				running.timeoutKillTimer = setTimeout(() => {
					running.timeoutKillTimer = undefined;
					if (settled || !processGroupPid || !isProcessGroupAlive(processGroupPid)) return;
					runtime.terminateBackgroundChildProcess(running, "SIGKILL");
				}, killEscalationMs);
				running.timeoutKillTimer.unref?.();
			}
			runtime.terminateBackgroundChildProcess(running, "SIGTERM");
		};

		// A spent hard budget must terminate the child even when it has no
		// session file to poll, so this runs outside the session-stat block.
		const enforceTimeoutBudget = (now: number): boolean => {
			const expired = checkSubagentTimeout(running, now);
			if (!expired) return false;
			// The only honest moment to ask whether the child beat the deadline is
			// before the signal goes out. Its Pi process writes an ordinary `done`
			// on the way out of our own SIGTERM, so anything published after this
			// point is a consequence of the kill, not a verdict that outranks it.
			if (hasSubagentExitSidecar(running.sessionFile)) return false;
			running.timeoutExpiry = expired;
			if (!running.timeoutKillTimer) beginKill();
			return true;
		};

		const enforceTimeoutWrapUp = (now: number): boolean => {
			const due = checkSubagentTimeoutWrapUp(running, now);
			if (!due || running.timeoutWrapUpMode) return false;
			if (hasSubagentExitSidecar(running.sessionFile)) return false;
			running.timeoutWrapUp = due;
			const baseline = due.kind === "timeout" ? running.startTime : (running.lastProgressAt ?? running.startTime);
			running.timeoutWrapUpDeadlineAt = baseline + due.seconds * 1000;
			beginKill();
			return true;
		};

		const checkTimeoutDeadlines = (now: number) => {
			if (enforceTimeoutBudget(now)) return;
			enforceTimeoutWrapUp(now);
		};

		const observeSession = (now: number): boolean => {
			try {
				if (!existsSync(running.sessionFile)) return false;
				const stat = statSync(running.sessionFile);
				const previousEntries = running.entries ?? 0;
				const entries = getEntryCount(running.sessionFile);
				const produced =
					entries > previousEntries ? hasChildProgress(getNewEntries(running.sessionFile, previousEntries)) : false;
				observeSubagentProgress(running, stat.size, now, produced);
				running.entries = entries;
				return !running.noSession || running.timeoutWarnThreshold !== undefined;
			} catch {
				return false;
			}
		};

		const armDeadlineTimer = () => {
			if (deadlineTimer) clearTimeout(deadlineTimer);
			const deadlineAt = getSubagentNextDeadlineAt(running);
			if (deadlineAt === undefined || settled) {
				deadlineTimer = undefined;
				return;
			}
			deadlineTimer = setTimeout(() => {
				deadlineTimer = undefined;
				const now = Date.now();
				observeSession(now);
				checkTimeoutDeadlines(now);
				armDeadlineTimer();
			}, Math.max(1, deadlineAt - Date.now()));
			deadlineTimer.unref?.();
		};

		const pollInterval = setInterval(() => {
			const now = Date.now();
			const sessionReadable = observeSession(now);
			checkTimeoutDeadlines(now);
			armDeadlineTimer();
			if (running.timeoutExpiry || (running.timeoutWrapUp && !running.timeoutWrapUpMode)) return;
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
				if (processGroupPid && isProcessGroupAlive(processGroupPid)) {
					terminateChildProcessGroup(running, "SIGKILL");
				}
			}, 5000);
		};
		const finalizeExit = (
			code: number | null,
			exitSignal: ReturnType<typeof consumeSubagentExitSignal>,
		) => {
			if (
				running.timeoutWrapUp &&
				!running.timeoutWrapUpMode &&
				!running.timeoutExpiry &&
				!signal.aborted &&
				exitSignal?.reason !== "ping"
			) {
				finish({ kind: "restart" });
				return;
			}
			const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
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
			if ((!running.noSession || running.timeoutWarnThreshold !== undefined) && existsSync(running.sessionFile)) {
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
				kind: "result",
				result: {
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
				...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
				ping: exitSignal?.ping,
				errorMessage,
				},
			});
		};
		const onExit = (code: number | null) => {
			const exitSignal = consumeSubagentExitSignal(running.sessionFile);
			const runtimeOwnsExit =
				Boolean(running.timeoutExpiry) ||
				Boolean(running.timeoutWrapUp && !running.timeoutWrapUpMode) ||
				signal.aborted;
			if (runtimeOwnsExit && processGroupPid && isProcessGroupAlive(processGroupPid)) {
				if (!groupExitPoll) {
					groupExitPoll = setInterval(() => {
						if (isProcessGroupAlive(processGroupPid)) return;
						clearInterval(groupExitPoll!);
						groupExitPoll = undefined;
						finalizeExit(code, exitSignal);
					}, 25);
					groupExitPoll.unref?.();
				}
				return;
			}
			finalizeExit(code, exitSignal);
		};
		const onError = (error: Error) => {
			if (running.timeoutWrapUp && !running.timeoutWrapUpMode && !running.timeoutExpiry && !signal.aborted) {
				finish({ kind: "restart" });
				return;
			}
			finish({
				kind: "result",
				result: {
				name: running.name,
				task: running.task,
				summary: `Background agent failed to start: ${error.message}`,
				summarySource: "runtime",
				sessionFile: running.noSession ? undefined : running.sessionFile,
				exitCode: 1,
				elapsed: Math.floor((Date.now() - running.startTime) / 1000),
				error: error.message,
				...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
				},
			});
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.once("exit", onExit);
		child.once("error", onError);
		armDeadlineTimer();
	});
}

function buildBackgroundCancellationResult(running: RunningSubagent): SubagentResult {
	return {
		name: running.name,
		task: running.task,
		summary: "Subagent cancelled.",
		summarySource: "runtime",
		sessionFile: running.noSession ? undefined : running.sessionFile,
		exitCode: 1,
		elapsed: Math.floor((Date.now() - running.startTime) / 1000),
		error: "cancelled",
		...(running.timeoutWrapUp ? { timeoutWrapUp: running.timeoutWrapUp } : {}),
	};
}
