import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { traceSubagentLaunch } from "../launch/trace.ts";
import type { PollResult } from "../mux/poll.ts";
import { isZellijSurfaceLive } from "../mux/zellij-runtime.ts";
import { consumeSubagentExitSignal, getMuxBackend, pollForExit } from "../mux.ts";
import { findLastSubagentOutputWithSource, getNewEntries } from "../session/session.ts";
import type { RunningSubagent, SubagentResult, SubagentSummarySource } from "../types.ts";
import { resolveFinalContextUsage } from "./final-context-usage.ts";

export interface InteractiveWatchRuntime {
	cleanupNoSessionSessionFile(running: RunningSubagent): void;
	closeRunningSurface(running: RunningSubagent): Promise<void>;
}

export async function watchSubagent(
	running: RunningSubagent,
	runtime: InteractiveWatchRuntime,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const { name, task, surface, startTime, sessionFile } = running;
	if (!surface) throw new Error("watchSubagent called on a background agent (no surface)");

	const updateStats = () => {
		try {
			if (!existsSync(sessionFile)) return;
			const stat = statSync(sessionFile);
			running.entries = readFileSync(sessionFile, "utf8")
				.split("\n")
				.filter((line) => line.trim()).length;
			running.bytes = stat.size;
		} catch {}
	};

	try {
		traceSubagentLaunch("interactive.watch.start", {
			name,
			surface,
			sessionFile,
			signalAborted: signal.aborted,
		});
		const pollResult =
			getMuxBackend() === "zellij"
				? await pollForZellijFiles(running, signal, updateStats)
				: await pollForExit(surface, signal, {
						interval: 1000,
						sessionFile,
						doneSentinelFile: running.doneSentinelFile,
						onTick: updateStats,
					});

		traceSubagentLaunch("interactive.watch.pollResult", {
			name,
			surface,
			sessionFile,
			pollResult,
		});
		const elapsed = Math.floor((Date.now() - startTime) / 1000);
		const { summary, summarySource } = getSummary(running, pollResult);
		const errorMessage = pollResult.reason === "error" ? pollResult.errorMessage : undefined;
		const exitSignal = pollResult.outputTokens === undefined ? consumeSubagentExitSignal(sessionFile) : undefined;
		const finalContextUsage = resolveFinalContextUsage(
			running,
			pollResult.contextTokens === undefined ? exitSignal : pollResult,
		);
		cleanupDoneSentinel(running);
		try {
			await runtime.closeRunningSurface(running);
		} catch {}
		runtime.cleanupNoSessionSessionFile(running);

		return {
			name,
			task,
			summary,
			summarySource,
			sessionFile: running.noSession ? undefined : sessionFile,
			exitCode: pollResult.exitCode,
			elapsed,
			outputTokens: pollResult.outputTokens ?? exitSignal?.outputTokens,
			...finalContextUsage,
			ping: pollResult.ping,
			errorMessage,
		};
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		traceSubagentLaunch("interactive.watch.error", {
			name,
			surface,
			sessionFile,
			errorMessage,
			signalAborted: signal.aborted,
		});
		cleanupDoneSentinel(running);
		try {
			await runtime.closeRunningSurface(running);
		} catch {}
		runtime.cleanupNoSessionSessionFile(running);

		if (signal.aborted) {
			return {
				name,
				task,
				summary: "Subagent cancelled.",
				summarySource: "runtime",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				outputTokens: 0,
				error: "cancelled",
			};
		}
		return {
			name,
			task,
			summary: `Subagent error: ${errorMessage}`,
			summarySource: "runtime",
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			outputTokens: 0,
			error: errorMessage,
		};
	}
}

function getSummary(
	running: RunningSubagent,
	pollResult: PollResult,
): { summary: string; summarySource: SubagentSummarySource } {
	if (!running.noSession && existsSync(running.sessionFile)) {
		const output = findLastSubagentOutputWithSource(getNewEntries(running.sessionFile, running.launchEntryCount ?? 0));
		if (output) return output;
	}
	return {
		summary:
			pollResult.exitCode !== 0
				? `Sub-agent exited with code ${pollResult.exitCode}`
				: "Sub-agent exited without output",
		summarySource: "runtime",
	};
}

async function pollForZellijFiles(
	running: RunningSubagent,
	signal: AbortSignal,
	onTick: () => void,
): Promise<PollResult> {
	while (!signal.aborted) {
		const exit = consumeSubagentExitSignal(running.sessionFile);
		if (exit) return exit;
		if (running.doneSentinelFile && existsSync(running.doneSentinelFile)) {
			const match = readFileSync(running.doneSentinelFile, "utf8").match(/__SUBAGENT_DONE_(\d+)__/);
			if (match) return { reason: "sentinel", exitCode: Number(match[1]) };
		}
		if (
			running.zellijTarget &&
			running.surface &&
			!(await isZellijSurfaceLive(running.zellijTarget, running.surface))
		) {
			return {
				reason: "error",
				exitCode: 1,
				errorMessage: "Zellij child pane exited without a completion signal.",
			};
		}
		onTick();
		await waitForPoll(1000, signal);
	}
	throw new Error("Aborted while waiting for subagent to finish");
}

function waitForPoll(interval: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, interval);
		signal.addEventListener("abort", abort, { once: true });
	});
}

function cleanupDoneSentinel(running: RunningSubagent): void {
	if (!running.doneSentinelFile || !existsSync(running.doneSentinelFile)) return;
	try {
		rmSync(running.doneSentinelFile, { force: true });
	} catch {}
}
