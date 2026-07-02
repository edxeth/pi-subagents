import type { RunningSubagent, SubagentResult } from "../types.ts";
import {
	createPaseoClient,
	type PaseoAgentSnapshot,
	type PaseoClient,
	type PaseoFetchAgentTimelinePayload,
	type PaseoTimelineEntry,
	type PaseoWaitForFinishResult,
} from "./client.ts";

function elapsedSeconds(running: RunningSubagent): number {
	return Math.floor((Date.now() - running.startTime) / 1000);
}

const DEFAULT_IDLE_WITHOUT_OUTPUT_GRACE_MS = 120_000;
const PASEO_WAIT_POLL_TIMEOUT_MS = 1000;

function idleWithoutOutputGraceMs(): number {
	const raw = process.env.PI_SUBAGENT_PASEO_IDLE_WITHOUT_OUTPUT_GRACE_MS;
	if (!raw) return DEFAULT_IDLE_WITHOUT_OUTPUT_GRACE_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0
		? parsed
		: DEFAULT_IDLE_WITHOUT_OUTPUT_GRACE_MS;
}

function usageTotal(agent: PaseoAgentSnapshot | null | undefined): number | undefined {
	const usage = agent?.lastUsage;
	if (!usage) return undefined;
	return usage.totalTokens ??
		(usage.input ?? 0) +
			(usage.output ?? 0) +
			(usage.cacheRead ?? 0) +
			(usage.cacheWrite ?? 0);
}

function getTimelineText(entry: PaseoTimelineEntry): string | null {
	const item = entry.item;
	if (!item) return null;
	if (item.type === "assistant_message" && item.text?.trim()) {
		const text = item.text.trim();
		return text.startsWith("<system-reminder>") ? null : text;
	}
	if (item.type === "error" && item.message?.trim()) {
		return item.message.trim();
	}
	return null;
}

function isAssistantTimelineText(entry: PaseoTimelineEntry): boolean {
	const item = entry.item;
	if (item?.type !== "assistant_message") return false;
	const text = item.text?.trim();
	return Boolean(text && !text.startsWith("<system-reminder>"));
}

function shouldMergeAssistantTimelineText(
	previous: PaseoTimelineEntry,
	current: PaseoTimelineEntry,
): boolean {
	const currentMessageId = current.item?.messageId;
	const previousMessageId = previous.item?.messageId;
	return currentMessageId === undefined || previousMessageId === currentMessageId;
}

function summarizeTimeline(
	timeline: PaseoFetchAgentTimelinePayload | null,
): string | null {
	const entries = timeline?.entries ?? [];
	for (let index = entries.length - 1; index >= 0; index--) {
		if (isAssistantTimelineText(entries[index]!)) {
			const chunks: string[] = [];
			let chunkIndex = index;
			while (chunkIndex >= 0) {
				const current = entries[chunkIndex]!;
				if (!isAssistantTimelineText(current)) break;
				chunks.unshift(current.item!.text!);
				const previous = entries[chunkIndex - 1];
				if (
					!previous ||
					!isAssistantTimelineText(previous) ||
					!shouldMergeAssistantTimelineText(previous, current)
				) {
					break;
				}
				chunkIndex--;
			}
			return chunks.join("").trim();
		}
		const text = getTimelineText(entries[index]!);
		if (text) return text;
	}
	return null;
}

function hasRunningToolCall(
	timeline: PaseoFetchAgentTimelinePayload | null,
): boolean {
	const runningByCallId = new Map<string, boolean>();
	let hasAnonymousRunningTool = false;
	for (const entry of timeline?.entries ?? []) {
		const item = entry.item;
		if (item?.type !== "tool_call") continue;
		const isRunning = item.status === "running" ||
			(item.status === undefined && item.detail?.exitCode === null);
		if (item.callId) {
			runningByCallId.set(item.callId, isRunning);
		} else if (isRunning) {
			hasAnonymousRunningTool = true;
		}
	}
	return hasAnonymousRunningTool || [...runningByCallId.values()].some(Boolean);
}

function isUsableLastMessage(message: string | null | undefined): boolean {
	const text = message?.trim();
	return Boolean(text && !text.startsWith("<system-reminder>"));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(new DOMException("Aborted", "AbortError"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitForPaseoAgentToStart(
	client: PaseoClient,
	agentId: string,
	signal: AbortSignal,
	timeoutMs = 30000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		const fetched = await client.fetchAgent(agentId).catch(() => null);
		const status = fetched?.agent?.status;
		if (status === "running" || status === "error" || status === "closed") return;

		// Very fast children may finish before a polling tick observes `running`.
		// In that case an assistant/error timeline item is enough evidence that the
		// initial prompt ran and it is now safe to ask Paseo for the final state.
		const timeline = await fetchTimelineOrNull(client, agentId);
		if (summarizeTimeline(timeline)) return;

		await sleep(500, signal);
	}
}

function mapPaseoWaitResult(
	running: RunningSubagent,
	wait: PaseoWaitForFinishResult,
	timeline: PaseoFetchAgentTimelinePayload | null,
): SubagentResult {
	const final = wait.final ?? timeline?.agent ?? null;
	const summary =
		summarizeTimeline(timeline) ??
		(isUsableLastMessage(wait.lastMessage) ? wait.lastMessage!.trim() : null) ??
		wait.error?.trim() ??
		(final?.lastError?.trim() || null) ??
		`Paseo agent ${running.paseoAgentId ?? running.id} finished without output.`;
	const elapsed = elapsedSeconds(running);
	const outputTokens = usageTotal(final);

	if (wait.status === "permission") {
		return {
			name: running.name,
			task: running.task,
			summary,
			exitCode: 0,
			elapsed,
			outputTokens,
			ping: {
				name: running.name,
				message:
					`Paseo agent ${running.paseoAgentId ?? running.id} needs attention or permission in Paseo. ` +
					"Open the child agent in Paseo to resolve it.",
			},
		};
	}

	if (wait.status === "timeout") {
		return {
			name: running.name,
			task: running.task,
			summary,
			exitCode: 0,
			elapsed,
			outputTokens,
			ping: {
				name: running.name,
				message:
					`Paseo agent ${running.paseoAgentId ?? running.id} is still running in Paseo. ` +
					"Open the child agent in Paseo for live status.",
			},
		};
	}

	const failed = wait.status === "error" || final?.status === "error";
	const errorMessage = wait.error ?? final?.lastError;
	return {
		name: running.name,
		task: running.task,
		summary,
		exitCode: failed ? 1 : 0,
		elapsed,
		outputTokens,
		...(errorMessage ? { errorMessage } : {}),
	};
}

function cancelledResult(running: RunningSubagent): SubagentResult {
	return {
		name: running.name,
		task: running.task,
		summary: "Paseo subagent cancelled.",
		exitCode: 1,
		elapsed: elapsedSeconds(running),
		outputTokens: 0,
		error: "cancelled",
	};
}

async function fetchTimelineOrNull(
	client: PaseoClient,
	agentId: string,
): Promise<PaseoFetchAgentTimelinePayload | null> {
	try {
		return await client.fetchAgentTimeline(agentId, {
			direction: "tail",
			limit: 100,
			projection: "canonical",
		});
	} catch {
		return null;
	}
}

function isTerminalPaseoAgentWithoutOutput(
	wait: PaseoWaitForFinishResult,
	timeline: PaseoFetchAgentTimelinePayload | null,
): boolean {
	const final = wait.final ?? timeline?.agent ?? null;
	return final?.status === "closed" || final?.status === "error";
}

export async function watchPaseoSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const agentId = running.paseoAgentId;
	if (!agentId) {
		return {
			name: running.name,
			task: running.task,
			summary: "Paseo subagent is missing its Paseo agent id.",
			exitCode: 1,
			elapsed: elapsedSeconds(running),
			error: "missing_paseo_agent_id",
		};
	}

	const client = await createPaseoClient();
	try {
		if (signal.aborted) {
			await client.cancelAgent(agentId).catch(() => {});
			return cancelledResult(running);
		}

		let cleanupAbort = () => {};
		const abortPromise = new Promise<SubagentResult>((resolve) => {
			const onAbort = () => {
				void client.cancelAgent(agentId).catch(() => {});
				resolve(cancelledResult(running));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			cleanupAbort = () => signal.removeEventListener("abort", onAbort);
		});

		const waitPromise = (async () => {
			await waitForPaseoAgentToStart(client, agentId, signal);
			let idleWithoutOutputSince: number | null = null;
			const noOutputGraceMs = idleWithoutOutputGraceMs();
			while (true) {
				const wait = await client.waitForFinish(agentId, {
					timeoutMs: PASEO_WAIT_POLL_TIMEOUT_MS,
				});
				const timeline = await fetchTimelineOrNull(client, agentId);
				const hasOutput = Boolean(
					summarizeTimeline(timeline) || isUsableLastMessage(wait.lastMessage),
				);
				const stillRunningTool = hasRunningToolCall(timeline);
				const terminalWithoutOutput = isTerminalPaseoAgentWithoutOutput(wait, timeline);

				if (wait.status === "timeout" && !hasOutput && !terminalWithoutOutput) {
					await sleep(500, signal);
					continue;
				}

				const effectiveWait = wait.status === "timeout" && hasOutput
					? { ...wait, status: "idle" as const, error: null }
					: wait;
				if (wait.status === "idle" && !hasOutput && !stillRunningTool) {
					idleWithoutOutputSince ??= Date.now();
				} else {
					idleWithoutOutputSince = null;
				}
				if (
					wait.status !== "idle" ||
					terminalWithoutOutput ||
					(!stillRunningTool && hasOutput) ||
					(idleWithoutOutputSince !== null && Date.now() - idleWithoutOutputSince > noOutputGraceMs)
				) {
					return mapPaseoWaitResult(running, effectiveWait, timeline);
				}
				await sleep(500, signal);
			}
		})();

		try {
			return await Promise.race([waitPromise, abortPromise]);
		} finally {
			cleanupAbort();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			name: running.name,
			task: running.task,
			summary: `Paseo subagent error: ${message}`,
			exitCode: 1,
			elapsed: elapsedSeconds(running),
			error: message,
		};
	} finally {
		await client.close().catch(() => {});
	}
}

export const summarizePaseoTimelineForTest = summarizeTimeline;
export const mapPaseoWaitResultForTest = mapPaseoWaitResult;
export const hasRunningPaseoToolCallForTest = hasRunningToolCall;
