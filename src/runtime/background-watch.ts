import { existsSync, statSync } from "node:fs";
import { consumeSubagentExitSignal } from "../mux.ts";
import type { RunningSubagent, SessionEntryLike, SubagentResult, SubagentSummarySource } from "../types.ts";
import { findLastSubagentOutputWithSource, getEntries, getEntryCount, getNewEntries } from "../session/session.ts";
import { getTerminalAssistantSummary, shouldReapStableTerminalSummary } from "../agents/titles.ts";
import { resolveFinalContextUsage } from "./final-context-usage.ts";

export interface BackgroundWatchRuntime {
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
	terminateBackgroundChildProcess(running: RunningSubagent, signal: NodeJS.Signals): void;
}

function terminateChildProcessGroup(
	running: RunningSubagent,
	signal: NodeJS.Signals,
): void {
	const child = running.childProcess!;
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

/**
 * Watch a background subagent until it exits. Listens for the child process
 * exit event, polls the session file for widget updates, and handles timeout
 * and abort.
 */
export function watchBackgroundSubagent(
	running: RunningSubagent,
	runtime: BackgroundWatchRuntime,
	signal: AbortSignal,
	timeout?: number,
): Promise<SubagentResult> {
	const child = running.childProcess!;
	const terminalGraceMs = 1000;

	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let terminalSummary: string | null = null;
		let terminalSeenAt = 0;
		if (timeout && timeout > 0) {
			timer = setTimeout(() => {
				terminateChildProcessGroup(running, "SIGTERM");
			}, timeout * 1000);
		}

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			clearInterval(pollInterval);
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

		const pollInterval = setInterval(() => {
			try {
				if (!existsSync(running.sessionFile)) return;
				const stat = statSync(running.sessionFile);
				running.entries = getEntryCount(running.sessionFile);
				running.bytes = stat.size;
				if (running.noSession) return;
				if (!shouldReapStableTerminalSummary(running)) return;
				const summary = getTerminalAssistantSummary(
					(getEntries(running.sessionFile) as SessionEntryLike[]).slice(
						running.launchEntryCount ?? 0,
					),
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
			const exitCode = exitSignal?.exitCode ?? code ?? 1;
			const errorMessage =
				exitSignal?.reason === "error"
					? exitSignal.errorMessage
					: undefined;
			const finalContextUsage = resolveFinalContextUsage(running, exitSignal);
			const stderr = running.stderrTail?.trim();
			const stdout = running.stdoutTail?.trim();
			let summary = `Background agent exited with code ${exitCode}`;
			let summarySource: SubagentSummarySource = "runtime";
			if (!running.noSession && existsSync(running.sessionFile)) {
				const allEntries = getNewEntries(
					running.sessionFile,
					running.launchEntryCount ?? 0,
				);
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
