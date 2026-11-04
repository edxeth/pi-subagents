import { existsSync, readFileSync } from "node:fs";
import { clearSubagentExitSidecar, getSubagentExitSidecarPath } from "../session/exit-sidecar.ts";
import { getInteractiveProcessFile } from "../session/interactive-process.ts";
import { readScreenAsync } from "./io.ts";

export interface PollResult {
	reason: "done" | "ping" | "sentinel" | "error";
	exitCode: number;
	outputTokens?: number;
	contextTokens?: number;
	contextWindow?: number;
	/** Set when the child's exit was owned by its context-warning policy. */
	completionReason?: "context-pressure" | "context-pressure-failure";
	ping?: { name: string; message: string };
	errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload. Centralized so both
 * consumeSubagentExitSignal and pollForExit decode the same way.
 */
function withDefinedTokens(obj: PollResult, tokens: number | undefined): PollResult {
	if (tokens !== undefined) {
		obj.outputTokens = tokens;
	}
	return obj;
}

function withDefinedContextUsage(
	obj: PollResult,
	contextTokens: number | undefined,
	contextWindow: number | undefined,
): PollResult {
	if (contextTokens !== undefined && contextWindow !== undefined) {
		obj.contextTokens = contextTokens;
		obj.contextWindow = contextWindow;
	}
	return obj;
}

function withDefinedCompletionReason(obj: PollResult, reason: unknown): PollResult {
	if (reason === "context-pressure") {
		obj.completionReason = "context-pressure";
	}
	if (reason === "context-pressure-failure") {
		obj.completionReason = "context-pressure-failure";
	}
	return obj;
}

/**
 * Interpret an `.exit` sidecar payload. Centralized so both
 * consumeSubagentExitSignal and pollForExit decode the same way.
 */
function interpretExitSidecar(data: any): PollResult {
	const tokens = typeof data?.outputTokens === "number" ? data.outputTokens : undefined;
	const contextTokens = typeof data?.contextTokens === "number" ? data.contextTokens : undefined;
	const contextWindow = typeof data?.contextWindow === "number" ? data.contextWindow : undefined;
	const withUsage = (result: PollResult) =>
		withDefinedCompletionReason(
			withDefinedContextUsage(withDefinedTokens(result, tokens), contextTokens, contextWindow),
			data?.completionReason,
		);
	if (data?.type === "ping") {
		return withUsage({
			reason: "ping" as const,
			exitCode: 0,
			ping: {
				name: data.name ?? "subagent",
				message: data.message ?? "",
			},
		});
	}
	if (data?.type === "error") {
		const errorMessage =
			typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
				? data.errorMessage
				: "Subagent exited with stopReason=error (no errorMessage in sidecar).";
		return withUsage({ reason: "error" as const, exitCode: 1, errorMessage });
	}
	return withUsage({ reason: "done" as const, exitCode: 0 });
}

export const __pollForExitTest__ = { interpretExitSidecar };

export function consumeSubagentExitSignal(sessionFile: string): PollResult | null {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (!existsSync(exitFile)) return null;

	try {
		const parsed = JSON.parse(readFileSync(exitFile, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		clearSubagentExitSidecar(sessionFile);
		return interpretExitSidecar(parsed);
	} catch {
		return null;
	}
}

async function waitForNextPoll(interval: number, signal: AbortSignal) {
	await new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(new Error("Aborted"));
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, interval);
		function onAbort() {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function readDoneSentinel(doneSentinelFile: string): PollResult | null {
	if (!existsSync(doneSentinelFile)) return null;
	let fileText: string;
	try {
		fileText = readFileSync(doneSentinelFile, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
	const fileMatch = fileText.match(/__SUBAGENT_DONE_(\d+)__/);
	return fileMatch ? { reason: "sentinel", exitCode: parseInt(fileMatch[1], 10) } : null;
}

function readInteractiveProcessId(processIdFile: string): number | null {
	if (!existsSync(processIdFile)) return null;
	try {
		const pid = Number(readFileSync(processIdFile, "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw error;
	}
}

function hasInteractiveProcessExited(doneSentinelFile: string): boolean {
	const processIdFile = getInteractiveProcessFile(doneSentinelFile);
	const pid = readInteractiveProcessId(processIdFile);
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		// Only ESRCH proves that the launcher is absent. Permission and unknown
		// probe failures leave the child supervised.
		if (!hasErrorCode(error, "ESRCH")) return false;
		// Normal launcher completion removes the marker before the shell publishes
		// its sentinel. Re-read it so that transition does not look abrupt.
		return readInteractiveProcessId(processIdFile) === pid;
	}
}

export async function pollForExit(
	surface: string,
	signal: AbortSignal,
	options: {
		interval: number;
		sessionFile?: string;
		doneSentinelFile?: string;
		onTick?: (elapsed: number) => void;
	},
): Promise<PollResult> {
	const start = Date.now();

	while (true) {
		if (signal.aborted) {
			throw new Error("Aborted while waiting for subagent to finish");
		}

		if (options.sessionFile) {
			const exitSignal = consumeSubagentExitSignal(options.sessionFile);
			if (exitSignal) return exitSignal;
		}

		if (options.doneSentinelFile) {
			const sentinel = readDoneSentinel(options.doneSentinelFile);
			if (sentinel) return sentinel;
			if (hasInteractiveProcessExited(options.doneSentinelFile)) {
				return {
					reason: "error",
					exitCode: 1,
					errorMessage: "Interactive child process exited without a completion signal.",
				};
			}
		}

		try {
			const screen = await readScreenAsync(surface, 5);
			const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
			if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
		} catch {
			if (options.sessionFile) {
				const exitSignal = consumeSubagentExitSignal(options.sessionFile);
				if (exitSignal) return exitSignal;
			}
			if (options.doneSentinelFile) {
				const sentinel = readDoneSentinel(options.doneSentinelFile);
				if (sentinel) return sentinel;
			}
			// A launcher record that survived the exit check above means the child is
			// still running, so a failed read alone does not end supervision.
			if (
				!options.doneSentinelFile ||
				readInteractiveProcessId(getInteractiveProcessFile(options.doneSentinelFile)) === null
			) {
				throw new Error("Failed to read subagent surface while polling for exit");
			}
		}

		const elapsed = Math.floor((Date.now() - start) / 1000);
		options.onTick?.(elapsed);
		await waitForNextPoll(options.interval, signal);
	}
}
