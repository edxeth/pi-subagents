import { runningSubagents, completedSubagentResults } from "../../runtime/state.ts";
import { getEffectiveAgentDefinitions, loadAgentDefaults, type AgentDefaults } from "../../agents/definitions.ts";
import { readSubagentLaunchMetadata, getSubagentActivityStartIndex, type PersistedSubagentLaunchMetadata } from "../../session/session-files.ts";
import { getEntries } from "../../session/session.ts";
import { stopRunningSubagent } from "../../runtime/wiring.ts";
import type { CompletedSubagentResult, RunningSubagent, SessionContentBlock, SessionMessageLike, SessionUsage } from "../../types.ts";
import type { DetailSection, OverlayContext, OverlayItem } from "./render-types.ts";
import { compactCount, firstLine, formatElapsed, formatElapsedSeconds } from "./render-helpers.ts";

// ─── Section building ───────────────────────────────────────────────────────

type AgentDetailDefaults = AgentDefaults & {
	name?: string;
	description?: string;
};

const SECTION_FIELDS = [
	{
		title: "Identity",
		fields: ["name", "description", "agent file"],
	},
	{
		title: "Runtime",
		fields: ["mode", "session-mode", "async", "auto-exit", "parent-close", "no-session", "timeout", "launched"],
	},
	{
		title: "Model",
		fields: ["model", "thinking", "resolved", "allow-model-override", "override-model", "override-thinking"],
	},
	{
		title: "Workspace",
		fields: ["cwd", "trust-project", "flags", "env"],
	},
	{
		title: "Capabilities",
		fields: ["tools", "deny-tools", "extensions", "skills", "inject-skills", "spawning", "no-context-files"],
	},
];

function none(value?: string | null): string {
	return value && value.trim() ? value : "none";
}

function inherited(value?: string | null): string {
	return value && value.trim() ? value : "default";
}

function buildSections(
	defs: AgentDetailDefaults | null,
	meta?: PersistedSubagentLaunchMetadata,
): DetailSection[] {
	const fields: Array<{ label: string; value: string }> = [];
	const name = meta?.name ?? defs?.name ?? "—";

	fields.push({ label: "name", value: name });
	fields.push({ label: "description", value: defs?.description ?? "—" });
	fields.push({ label: "agent file", value: defs?.path ?? "—" });
	if (meta) {
		fields.push({
			label: "launched",
			value: meta.timestamp ? new Date(meta.timestamp).toLocaleString() : "—",
		});
	}
	fields.push({ label: "model", value: inherited(meta?.definitionModel ?? defs?.model ?? meta?.model) });
	fields.push({ label: "thinking", value: inherited(meta?.definitionThinking ?? defs?.thinking ?? meta?.thinking) });
	if (meta?.modelRef) {
		fields.push({ label: "resolved", value: meta.modelRef });
	}
	fields.push({ label: "allow-model-override", value: String(meta ? meta.allowModelOverride === true : defs?.allowModelOverride === true) });
	if (meta?.modelSource === "launch-override" || meta?.modelSource === "resume-override") {
		fields.push({ label: "override-model", value: inherited(meta.model) });
		fields.push({ label: "override-thinking", value: inherited(meta.thinking) });
	}
	fields.push({ label: "mode", value: meta?.mode ?? defs?.mode ?? "interactive" });
	fields.push({ label: "cwd", value: meta?.cwd ?? defs?.cwd ?? "parent cwd" });
	fields.push({ label: "trust-project", value: String(meta ? (meta.trustProject ?? false) : (defs?.trustProject ?? false)) });
	fields.push({ label: "flags", value: none(meta?.flags ?? defs?.flags) });
	fields.push({ label: "env", value: none(meta?.env ?? defs?.env) });
	fields.push({ label: "tools", value: meta?.tools ?? defs?.tools ?? "all" });
	fields.push({ label: "deny-tools", value: none(defs?.denyTools) });
	fields.push({
		label: "extensions",
		value: meta?.extensions?.length ? meta.extensions.join(", ") : "all",
	});
	fields.push({ label: "skills", value: meta?.skills ?? defs?.skills ?? "all" });
	fields.push({ label: "inject-skills", value: none(meta?.injectSkills ?? defs?.injectSkills) });
	fields.push({ label: "spawning", value: String(defs?.spawning ?? false) });
	fields.push({
		label: "no-context-files",
		value: String(meta ? meta.noContextFiles : (defs?.noContextFiles ?? false)),
	});
	fields.push({ label: "async", value: String(meta ? meta.async : (defs?.async ?? true)) });
	fields.push({ label: "auto-exit", value: String(meta ? (meta.autoExit ?? false) : (defs?.autoExit ?? false)) });
	fields.push({ label: "session-mode", value: (meta?.sessionMode ?? defs?.sessionMode ?? "lineage-only") as string });
	fields.push({ label: "parent-close", value: (meta?.parentClosePolicy ?? defs?.parentClosePolicy ?? "terminate") as string });
	fields.push({ label: "no-session", value: String(meta ? meta.noSession : (defs?.noSession ?? false)) });
	fields.push({ label: "timeout", value: defs?.timeout != null ? `${defs.timeout}s` : "none" });

	return SECTION_FIELDS.map((section) => ({
		title: section.title,
		fields: section.fields
			.map((label) => fields.find((field) => field.label === label))
			.filter((field): field is { label: string; value: string } => Boolean(field)),
	})).filter((section) => section.fields.length > 0);
}

interface CompletedSessionStats {
	messages: number;
	toolUses: number;
	/** Snapshot of the final assistant message's usage total — the context footprint, not a cumulative sum. */
	contextTokens: number;
	inputTokens: number;
	outputTokens: number;
	model?: string;
	provider?: string;
}

function buildRuntimeSection(isRunning: boolean, r: RunningSubagent | CompletedSubagentResult): DetailSection {
	const fields: Array<{ label: string; value: string }> = [];
	const running = r as RunningSubagent;
	const completed = r as CompletedSubagentResult;

	if (isRunning && running.startTime) {
		fields.push({ label: "elapsed", value: formatElapsed(running.startTime) });
	} else if (completed.elapsed != null) {
		fields.push({ label: "elapsed", value: `${completed.elapsed}s` });
	}
	if (running.messageCount != null) fields.push({ label: "messages", value: `${running.messageCount}` });
	if (running.toolUses != null) fields.push({ label: "tool uses", value: `${running.toolUses}` });

	const ctxUsed = running.contextTokens ?? 0;
	const ctxW = running.modelContextWindow;
	if (ctxUsed > 0 && ctxW) {
		fields.push({ label: "context", value: `${compactCount(ctxUsed)}/${compactCount(ctxW)}` });
	} else if (running.contextLabel) {
		fields.push({ label: "context", value: running.contextLabel });
	} else if ((running.contextTokens ?? 0) > 0) {
		fields.push({ label: "tokens", value: compactCount(running.contextTokens ?? 0) });
	}

	if (running.activity) fields.push({ label: "activity", value: running.activity });
	if (running.sessionFile) fields.push({ label: "session", value: running.sessionFile });
	if (running.surface) fields.push({ label: "pane", value: running.surface });
	if (running.childProcess?.pid) fields.push({ label: "PID", value: `${running.childProcess.pid}` });

	return { title: "Runtime", fields };
}

// ─── Safe helpers ───────────────────────────────────────────────────────────

function safeMeta(f: string): PersistedSubagentLaunchMetadata | undefined {
	try { return readSubagentLaunchMetadata(f); } catch { return undefined; }
}

function safeDefs(a: string, cwd: string): AgentDetailDefaults | null {
	try { return loadAgentDefaults(a, undefined, cwd, (_h, b) => b); } catch { return null; }
}

function usageTotal(usage: SessionUsage): number {
	return usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

function getSessionMessage(entry: { [key: string]: unknown }): SessionMessageLike | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	return typeof message === "object" && message !== null ? message as SessionMessageLike : undefined;
}

function readCompletedSessionStats(sessionFile?: string): CompletedSessionStats | undefined {
	if (!sessionFile) return undefined;
	try {
		let messages = 0;
		let toolUses = 0;
		let contextTokens = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		let model: string | undefined;
		let provider: string | undefined;

		const entries = getEntries(sessionFile) as Array<{ [key: string]: unknown }>;
		// Skip inherited parent history in forked child sessions; count only
		// entries after this subagent's launch marker.
		const startIndex = getSubagentActivityStartIndex(entries);
		for (let i = startIndex; i < entries.length; i++) {
			const message = getSessionMessage(entries[i]);
			if (!message) continue;
			if (message.role === "toolResult") {
				toolUses++;
				continue;
			}
			messages++;
			if (message.role !== "assistant") continue;
			if (message.model) model = message.model;
			if (message.provider) provider = message.provider;
			if (message.usage) {
				// Snapshot, not sum: the latest assistant turn reflects the context
				// footprint. Cumulative input/output are tracked separately below.
				contextTokens = usageTotal(message.usage);
				inputTokens += message.usage.input ?? 0;
				outputTokens += message.usage.output ?? 0;
			}
			if (Array.isArray(message.content)) {
				toolUses += message.content.filter((block: SessionContentBlock) => block.type === "toolCall" || block.type === "toolUse").length;
			}
		}

		return { messages, toolUses, contextTokens, inputTokens, outputTokens, model, provider };
	} catch {
		return undefined;
	}
}

function compactStats(stats?: CompletedSessionStats, fallbackOutputTokens?: number): string[] {
	if (!stats) return fallbackOutputTokens ? [`${compactCount(fallbackOutputTokens)} output`] : [];
	const result: string[] = [];
	if (stats.messages > 0) result.push(`${stats.messages} msg`);
	if (stats.toolUses > 0) result.push(`${stats.toolUses} tool${stats.toolUses === 1 ? "" : "s"}`);
	if (stats.contextTokens > 0) result.push(`${compactCount(stats.contextTokens)} ctx`);
	else if (fallbackOutputTokens) result.push(`${compactCount(fallbackOutputTokens)} output`);
	return result;
}

function completedRuntimeSection(args: {
	status: "completed" | "cancelled" | "failed";
	elapsed?: number;
	exitCode?: number;
	outputTokens?: number;
	sessionFile?: string;
	stats?: CompletedSessionStats;
}): DetailSection {
	const fields: Array<{ label: string; value: string }> = [];
	fields.push({ label: "status", value: args.status });
	if (args.elapsed != null) fields.push({ label: "elapsed", value: `${args.elapsed}s` });
	if (args.exitCode != null) fields.push({ label: "exit", value: `${args.exitCode}` });
	if (args.stats?.messages) fields.push({ label: "messages", value: `${args.stats.messages}` });
	if (args.stats?.toolUses) fields.push({ label: "tool calls", value: `${args.stats.toolUses}` });
	if (args.stats?.contextTokens) fields.push({ label: "context tokens", value: compactCount(args.stats.contextTokens) });
	if (args.stats?.inputTokens) fields.push({ label: "input tokens", value: compactCount(args.stats.inputTokens) });
	if (args.stats?.outputTokens) fields.push({ label: "output tokens", value: compactCount(args.stats.outputTokens) });
	else if (args.outputTokens) fields.push({ label: "output tokens", value: compactCount(args.outputTokens) });
	if (args.sessionFile) fields.push({ label: "session", value: args.sessionFile });
	return { title: "Execution", fields };
}

interface RecoveredResultDetails {
	id: string;
	name: string;
	agent?: string;
	status: "completed" | "cancelled" | "failed";
	exitCode?: number;
	elapsed?: number;
	sessionFile?: string;
	errorMessage?: string;
}

function getEntryDetails(entry: { [key: string]: unknown }): Record<string, unknown> | undefined {
	const direct = entry.details;
	if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
	const message = entry.message;
	if (typeof message !== "object" || message === null) return undefined;
	const details = (message as { details?: unknown }).details;
	return typeof details === "object" && details !== null ? details as Record<string, unknown> : undefined;
}

function recoverResultDetails(entry: { [key: string]: unknown }): RecoveredResultDetails | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "subagent_result") return undefined;
	const details = getEntryDetails(entry);
	if (!details) return undefined;
	const name = typeof details.name === "string" ? details.name : undefined;
	const id = typeof details.id === "string" ? details.id : name;
	const rawStatus = typeof details.status === "string" ? details.status : undefined;
	const status = rawStatus === "completed" || rawStatus === "cancelled" || rawStatus === "failed"
		? rawStatus
		: details.exitCode === 0 ? "completed" : "failed";
	if (!id || !name) return undefined;
	return {
		id,
		name,
		agent: typeof details.agent === "string" ? details.agent : undefined,
		status,
		exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
		elapsed: typeof details.elapsed === "number" ? details.elapsed : undefined,
		sessionFile: typeof details.sessionFile === "string" ? details.sessionFile : undefined,
		errorMessage: typeof details.errorMessage === "string" ? details.errorMessage : undefined,
	};
}

function recoverSummary(entry: { [key: string]: unknown }): string {
	const content = typeof entry.content === "string" ? entry.content : "";
	const [, afterHeader = content] = content.split(/\n\n/, 2);
	return firstLine(afterHeader.replace(/\n\nSession:[\s\S]*$/, ""), 90) || "completed";
}

function statusVisuals(status: "completed" | "cancelled" | "failed") {
	if (status === "completed") return { icon: "✓", color: "success", label: "completed" };
	if (status === "cancelled") return { icon: "⚡", color: "warning", label: "cancelled" };
	return { icon: "✕", color: "error", label: "failed" };
}

// ─── Public item builders ───────────────────────────────────────────────────

export function buildRunningItems(ctx: OverlayContext): OverlayItem[] {
	const items: OverlayItem[] = [];
	for (const a of runningSubagents.values()) {
		const meta = safeMeta(a.sessionFile);
		const defs = a.agent ? safeDefs(a.agent, ctx.cwd) : null;
		const sections = buildSections(defs, meta);
		sections.push(buildRuntimeSection(true, a));

		const stats: string[] = [];
		const modelRef = a.modelRef ?? meta?.modelRef;
		if (a.toolUses) stats.push(`${a.toolUses} tool${a.toolUses === 1 ? "" : "s"}`);
		const ctxUsed = a.contextTokens ?? 0;
		if (ctxUsed > 0 && a.modelContextWindow) {
			stats.push(`${compactCount(ctxUsed)}/${compactCount(a.modelContextWindow)} ctx`);
		} else if (a.contextLabel) {
			stats.push(a.contextLabel);
		} else if ((a.contextTokens ?? 0) > 0) {
			stats.push(`${compactCount(a.contextTokens ?? 0)} tokens`);
		}
		stats.push(formatElapsed(a.startTime));

		items.push({
			id: a.id,
			icon: "●",
			iconColor: "accent",
			name: a.name,
			agent: a.agent,
			modelRef,
			stats,
			activity: a.activity ?? a.taskPreview ?? "starting…",
			detailSections: sections,
			canKill: true,
			canResume: false,
			sessionFile: a.sessionFile,
			onKill: async () => {
				stopRunningSubagent(a);
				ctx.ui.notify(`Stopped ${a.name}`, "info");
			},
		});
	}
	return items;
}

export async function buildCompletedItems(ctx: OverlayContext): Promise<OverlayItem[]> {
	const items: OverlayItem[] = [];
	const seen = new Set<string>();
	const latestCompleted = new Map<string, CompletedSubagentResult>();
	const runningSessionFiles = new Set(
		[...runningSubagents.values()].map((subagent) => subagent.sessionFile).filter(Boolean),
	);

	for (const [id, r] of completedSubagentResults) {
		latestCompleted.set(r.sessionFile ?? id, r);
	}

	for (const [dedupeKey, r] of latestCompleted) {
		seen.add(dedupeKey);

		const visual = statusVisuals(r.status);

		const summary = r.errorMessage
			? `error: ${firstLine(r.errorMessage, 40)}`
			: r.summary
				? firstLine(r.summary, 40)
				: `exit ${r.exitCode}`;

		const sessionStats = readCompletedSessionStats(r.sessionFile);
		const meta = r.sessionFile ? safeMeta(r.sessionFile) : undefined;
		const defs = r.agent ? safeDefs(r.agent, ctx.cwd) : null;
		const sections = buildSections(defs, meta);
		sections.push(completedRuntimeSection({
			status: r.status,
			elapsed: r.elapsed,
			exitCode: r.exitCode,
			outputTokens: r.outputTokens,
			sessionFile: r.sessionFile,
			stats: sessionStats,
		}));

		items.push({
			id: r.id,
			icon: visual.icon,
			iconColor: visual.color,
			name: r.name,
			agent: r.agent,
			modelRef: meta?.modelRef,
			status: r.status === "completed" ? undefined : visual.label,
			statusColor: r.status === "completed" ? undefined : visual.color,
			stats: [formatElapsedSeconds(r.elapsed), ...compactStats(sessionStats, r.outputTokens)],
			activity: summary,
			detailSections: sections,
			canKill: false,
			canResume: true,
			sessionFile: r.sessionFile,
		});
	}

	const sf = ctx.sessionManager.getSessionFile?.();
	if (sf) {
		try {
			const entries = getEntries(sf) as Array<{ [key: string]: unknown }>;
			for (const entry of entries) {
				const recovered = recoverResultDetails(entry);
				if (!recovered?.sessionFile || seen.has(recovered.sessionFile) || runningSessionFiles.has(recovered.sessionFile)) continue;
				seen.add(recovered.sessionFile);
				const visual = statusVisuals(recovered.status);
				const summary = recovered.errorMessage ? `error: ${firstLine(recovered.errorMessage, 80)}` : recoverSummary(entry);
				const sessionStats = readCompletedSessionStats(recovered.sessionFile);
				const meta = safeMeta(recovered.sessionFile);
				const defs = recovered.agent ? safeDefs(recovered.agent, ctx.cwd) : null;
				const sections = buildSections(defs, meta);
				sections.push(completedRuntimeSection({
					status: recovered.status,
					elapsed: recovered.elapsed,
					exitCode: recovered.exitCode,
					sessionFile: recovered.sessionFile,
					stats: sessionStats,
				}));

				items.push({
					id: recovered.id,
					icon: visual.icon,
					iconColor: visual.color,
					name: recovered.name,
					agent: recovered.agent,
					modelRef: meta?.modelRef,
					status: recovered.status === "completed" ? undefined : visual.label,
					statusColor: recovered.status === "completed" ? undefined : visual.color,
					stats: [
						...(recovered.elapsed != null ? [formatElapsedSeconds(recovered.elapsed)] : []),
						...compactStats(sessionStats),
					],
					activity: summary,
					detailSections: sections,
					canKill: false,
					canResume: true,
					sessionFile: recovered.sessionFile,
				});
			}
		} catch { /* ignore */ }
	}

	return items;
}

export function buildAgentItems(_ctx: OverlayContext): OverlayItem[] {
	return getEffectiveAgentDefinitions().map((d) => {
		const defs = d as AgentDetailDefaults;
		const sections = buildSections(defs, undefined);
		if (d.body) {
			const bodyLines = d.body
				.split("\n")
				.filter((l: string) => l.trim())
				.map((l: string) => ({ label: "", value: l }));
			sections.push({ title: "Agent Body", fields: bodyLines });
		}

		return {
			id: d.name,
			icon: "◆",
			iconColor: "accent",
			name: d.name,
			agent: undefined,
			stats: [],
			activity: d.description ? firstLine(d.description, 60) : "(no description)",
			detailSections: sections,
			canKill: false,
			canResume: false,
		};
	});
}