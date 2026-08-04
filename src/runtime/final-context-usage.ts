import { existsSync } from "node:fs";
import { splitModelRef } from "../agents/model-refs.ts";
import {
	findLatestAssistantContextSnapshot,
	getNewEntries,
} from "../session/session.ts";
import type { RunningSubagent } from "../types.ts";
import type { PollResult } from "../mux/poll.ts";

export interface FinalContextUsage {
	contextTokens?: number;
	contextWindow?: number;
}

function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
	return `${Math.round(tokens)}`;
}

export function formatFinalContextUsage(result: FinalContextUsage): string {
	const used = result.contextTokens;
	const maximum = result.contextWindow;
	if (
		typeof used !== "number" ||
		typeof maximum !== "number" ||
		!Number.isFinite(used) ||
		!Number.isFinite(maximum) ||
		used < 0 ||
		maximum <= 0
	) {
		return "";
	}
	const percent = Math.floor(Math.min((used / maximum) * 100, 100));
	return (
		`\n\nSub-agent context: ${formatCompactTokens(used)}/` +
		`${formatCompactTokens(maximum)} tokens (${percent}%) used at finish.`
	);
}

export function resolveFinalContextUsage(
	running: RunningSubagent,
	exitSignal: PollResult | null | undefined,
): FinalContextUsage {
	if (
		typeof exitSignal?.contextTokens === "number" &&
		typeof exitSignal.contextWindow === "number"
	) {
		return {
			contextTokens: exitSignal.contextTokens,
			contextWindow: exitSignal.contextWindow,
		};
	}
	if (
		running.noSession ||
		!running.modelContextWindow ||
		!existsSync(running.sessionFile)
	) {
		return {};
	}
	try {
		const snapshot = findLatestAssistantContextSnapshot(
			getNewEntries(running.sessionFile, running.launchEntryCount ?? 0),
		);
		const launchModel = running.modelRef
			? splitModelRef(running.modelRef).model
			: undefined;
		const snapshotModel = snapshot?.provider && snapshot.model
			? `${snapshot.provider}/${snapshot.model}`
			: undefined;
		if (!snapshot || !launchModel || launchModel !== snapshotModel) return {};
		return {
			contextTokens: snapshot.contextTokens,
			contextWindow: running.modelContextWindow,
		};
	} catch {
		return {};
	}
}
