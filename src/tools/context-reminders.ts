export const PI_SUBAGENT_CONTEXT_WARN_THRESHOLD = "PI_SUBAGENT_CONTEXT_WARN_THRESHOLD";
export const PI_SUBAGENT_CONTEXT_WARN_STEP = "PI_SUBAGENT_CONTEXT_WARN_STEP";

export const SUBAGENT_CONTEXT_REMINDER_ENTRY = "pi-subagent-context-reminders";

const DEFAULT_CONTEXT_WARN_STEP = 5;

export interface SubagentContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface SelectedContextReminder {
	threshold: number;
	message: string;
	sentThresholds: number[];
}

/**
 * Parse the opt-in starting percentage used by subagent context reminders.
 * `off`, an empty value, and invalid values disable reminders. Values above
 * 90 are rejected so all three reminders can fire before 100% usage.
 */
export function parseContextWarnThreshold(raw: string | undefined): number | null {
	if (!raw) return null;
	const normalized = raw.trim().toLowerCase();
	if (!normalized || normalized === "off") return null;
	const match = normalized.match(/^(\d+(?:\.\d+)?)%?$/);
	if (!match) return null;
	const threshold = Math.floor(Number.parseFloat(match[1]));
	return threshold >= 1 && threshold <= 99 ? threshold : null;
}

/**
 * Parse the increment between progressive context reminders. Decimal values are
 * rounded down to the nearest integer; the minimum step is 1%. Falls back to
 * the default 5% step for missing or invalid values so the feature still works
 * when only `context-warn-threshold` is set.
 */
export function parseContextWarnStep(raw: string | undefined): number {
	if (!raw) return DEFAULT_CONTEXT_WARN_STEP;
	const match = raw.trim().match(/^(\d+(?:\.\d+)?)%?$/);
	if (!match) return DEFAULT_CONTEXT_WARN_STEP;
	const step = Math.floor(Number.parseFloat(match[1]));
	return step >= 1 && step <= 99 ? step : DEFAULT_CONTEXT_WARN_STEP;
}

export function getContextReminderThresholds(startingThreshold: number, step: number): number[] {
	const scheduled = [startingThreshold, startingThreshold + step, startingThreshold + 2 * step].map((threshold) =>
		Math.min(threshold, 99),
	);
	const unique: number[] = [];
	for (const threshold of scheduled) {
		if (!unique.includes(threshold)) unique.push(threshold);
	}
	return unique;
}

function formatCompactTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K`;
	}
	return `${Math.round(tokens)}`;
}

function formatUsage(usage: SubagentContextUsage): string {
	return `${formatCompactTokens(usage.tokens)}/${formatCompactTokens(
		usage.contextWindow,
	)} tokens (${usage.percent.toFixed(1)}%)`;
}

function getReminderMessage(stage: number, usage: SubagentContextUsage): string {
	const currentUsage = formatUsage(usage);
	if (stage === 0) {
		return (
			`Your own context window is at ${currentUsage}; compaction is approaching. ` +
			"Avoid new scope and start bringing the current work to a close."
		);
	}
	if (stage === 1) {
		return (
			`Your own context window is at ${currentUsage}; compaction is close. ` +
			"Wrap up now, even if the work is partially finished — still complete and report per your instructions."
		);
	}
	return (
		`Your own context window is critically full (${currentUsage}); compaction is imminent. ` +
		"Stop taking new actions and deliver your result now per your instructions, even if incomplete."
	);
}

/**
 * Select at most one reminder for the current usage snapshot. When usage jumps
 * across multiple levels, the most urgent crossed level wins and all lower
 * crossed levels are marked sent so stale reminders are not queued later.
 */
export function selectContextReminder(
	startingThreshold: number | null,
	step: number,
	usage: SubagentContextUsage,
	sentThresholds: ReadonlySet<number>,
): SelectedContextReminder | null {
	if (startingThreshold === null) return null;
	const thresholds = getContextReminderThresholds(startingThreshold, step);
	const crossed = thresholds.filter((threshold) => usage.percent >= threshold && !sentThresholds.has(threshold));
	if (crossed.length === 0) return null;

	const threshold = crossed.at(-1)!;
	const stage = thresholds.indexOf(threshold);
	const nextSent = new Set(sentThresholds);
	for (const candidate of thresholds) {
		if (candidate <= threshold) nextSent.add(candidate);
	}

	return {
		threshold,
		message: getReminderMessage(stage, usage),
		sentThresholds: [...nextSent].sort((a, b) => a - b),
	};
}

/** Install the context monitor inside the child Pi process. */
export function installSubagentContextReminders(pi: ExtensionAPI): void {
	const startingThreshold = parseContextWarnThreshold(process.env[PI_SUBAGENT_CONTEXT_WARN_THRESHOLD]);
	const step = parseContextWarnStep(process.env[PI_SUBAGENT_CONTEXT_WARN_STEP]);
	const sentThresholds = new Set<number>();
	const pendingThresholds = new Set<number>();
	const pendingMessages = new Map<string, number[]>();

	const restoreSentThresholds = (entries: unknown[]) => {
		sentThresholds.clear();
		pendingThresholds.clear();
		pendingMessages.clear();
		for (const entry of entries) {
			const persisted = entry as {
				type?: unknown;
				customType?: unknown;
				data?: { sentThresholds?: unknown };
			};
			if (
				persisted.type !== "custom" ||
				persisted.customType !== SUBAGENT_CONTEXT_REMINDER_ENTRY ||
				!Array.isArray(persisted.data?.sentThresholds)
			) {
				continue;
			}
			sentThresholds.clear();
			for (const threshold of persisted.data.sentThresholds) {
				if (typeof threshold === "number") sentThresholds.add(threshold);
			}
		}
	};

	const queueReminder = (ctx: ExtensionContext) => {
		if (startingThreshold === null) return;
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		const contextWindow = usage?.contextWindow;
		const percent = usage?.percent;
		if (
			typeof tokens !== "number" ||
			typeof contextWindow !== "number" ||
			typeof percent !== "number" ||
			!Number.isFinite(tokens) ||
			!Number.isFinite(contextWindow) ||
			!Number.isFinite(percent) ||
			contextWindow <= 0
		) {
			return;
		}

		const reminder = selectContextReminder(
			startingThreshold,
			step,
			{ tokens, contextWindow, percent },
			new Set([...sentThresholds, ...pendingThresholds]),
		);
		if (!reminder) return;

		pi.sendUserMessage(reminder.message, { deliverAs: "steer" });
		pendingMessages.set(reminder.message, reminder.sentThresholds);
		for (const threshold of reminder.sentThresholds) {
			if (!sentThresholds.has(threshold)) pendingThresholds.add(threshold);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		restoreSentThresholds(ctx.sessionManager?.getEntries?.() ?? []);
	});

	pi.on("message_end", (event) => {
		const message = event.message as {
			role?: unknown;
			content?: Array<{ type?: unknown; text?: unknown }>;
		};
		if (message.role !== "user" || !Array.isArray(message.content)) return;
		const text = message.content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		const deliveredThresholds = pendingMessages.get(text);
		if (!deliveredThresholds) return;
		pendingMessages.delete(text);
		for (const threshold of deliveredThresholds) {
			if (typeof threshold !== "number") continue;
			sentThresholds.add(threshold);
			pendingThresholds.delete(threshold);
		}
		pi.appendEntry(SUBAGENT_CONTEXT_REMINDER_ENTRY, {
			sentThresholds: [...sentThresholds].sort((a, b) => a - b),
		});
	});

	pi.on("tool_result", (_event, ctx) => {
		queueReminder(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant") as
			| { stopReason?: unknown }
			| undefined;
		if (assistant?.stopReason === "error" || assistant?.stopReason === "aborted") {
			pendingThresholds.clear();
			pendingMessages.clear();
			return;
		}
		if (assistant?.stopReason === "toolUse") return;
		queueReminder(ctx);
	});
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
