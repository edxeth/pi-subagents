import { existsSync, readFileSync, statSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getSubagentActivityStartIndex } from "../session/session-files.ts";
import { readVerifiedRunDisplay, type VerifiedCandidateDisplay } from "../vf/widget.ts";
import type {
	RunningSubagent,
	SessionContentBlock,
	SessionEntryLike,
	SessionMessageLike,
	SessionUsage,
	WidgetThemeLike,
	WidgetTuiLike,
} from "../types.ts";

const SPINNER = ["◜", "◠", "◝", "◞", "◡", "◟"];
const MAX_WIDGET_LINES = 10;
const LINES_PER_AGENT = 3;

const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

function getTerminalColumns(): number {
	return process.stdout.columns ?? 80;
}

function formatCompactCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	}
	return `${count}`;
}

function formatElapsedMs(startTime: number): string {
	return `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
}

function firstNonEmptyLine(text: string, maxLen = 60): string {
	const line =
		text
			.split("\n")
			.map((value) => value.trim())
			.find(Boolean) ?? "";
	return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

function describeActivity(toolNames: string[], responseText?: string): string {
	if (toolNames.length > 0) {
		const groups = new Map<string, number>();
		for (const toolName of toolNames) {
			const action = TOOL_DISPLAY[toolName] ?? toolName;
			groups.set(action, (groups.get(action) ?? 0) + 1);
		}

		return [...groups.entries()]
			.map(([action, count]) => {
				if (count <= 1) return `${action}…`;
				const noun = action === "searching" ? "patterns" : "files";
				return `${action} ${count} ${noun}…`;
			})
			.join(", ");
	}

	const preview = responseText ? firstNonEmptyLine(responseText, 80) : "";
	return preview || "thinking…";
}

function renderAgentBadge(theme: WidgetThemeLike, agent: RunningSubagent): string {
	const label = agent.agent ?? "subagent";
	if (agent.deliveryState === "detached") {
		return theme.fg("muted", `[${label}]`);
	}
	return theme.fg("accent", `[${label}]`);
}

export class SubagentWidgetManager {
	private latestCtx: ExtensionContext | null = null;
	private widgetInterval: ReturnType<typeof setInterval> | null = null;
	private widgetFrame = 0;
	private readonly getAgents: () => Iterable<RunningSubagent>;
	/** Per-candidate stat holders for verified runs, keyed by run dir then index. */
	private readonly verifiedCandidateStats = new Map<string, Map<number, RunningSubagent>>();

	constructor(getAgents: () => Iterable<RunningSubagent>) {
		this.getAgents = getAgents;
	}

	reset(): void {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = null;
		}
		this.widgetFrame = 0;
	}

	attachContext(ctx: ExtensionContext): void {
		this.latestCtx = ctx;
		this.update();
	}

	resolveModelContextWindow(modelRef: string | undefined): number | undefined {
		if (!modelRef || !this.latestCtx?.modelRegistry?.find) return undefined;
		let provider: string | undefined;
		let modelId = modelRef;
		if (modelRef.includes("/")) {
			const [parsedProvider, ...rest] = modelRef.split("/");
			provider = parsedProvider;
			modelId = rest.join("/");
		}
		if (!provider) return undefined;
		const candidates = [modelId, modelId.replace(/:[^:]+$/, "")].filter(Boolean);
		const model = [...new Set(candidates)]
			.map((candidate) => this.latestCtx?.modelRegistry.find(provider!, candidate))
			.find(Boolean);
		return model?.contextWindow;
	}

	renderForTest(width = 120): string[] {
		return this.renderSubagentWidget(
			{ terminal: { columns: width } },
			{
				fg: (_tone: string, text: string) => text,
				bold: (text: string) => text,
			},
		);
	}

	update(): void {
		if (!this.latestCtx?.hasUI) return;

		for (const agent of this.getAgents()) {
			this.refreshRunningSubagentState(agent);
		}
		this.pruneVerifiedCandidateStats();

		this.renderWidgetNow();

		if (![...this.getAgents()].length && this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = null;
		}
	}

	/** Drop candidate stat holders whose run is no longer registered in this session. */
	private pruneVerifiedCandidateStats(): void {
		const live = new Set(
			[...this.getAgents()]
				.filter((agent) => agent.verifiedRunDir)
				.map((agent) => agent.verifiedRunDir as string),
		);
		for (const runDir of this.verifiedCandidateStats.keys()) {
			if (!live.has(runDir)) this.verifiedCandidateStats.delete(runDir);
		}
	}

	/** Reuse the ordinary session parser for one candidate's session file. */
	private candidateStats(agent: RunningSubagent, candidate: VerifiedCandidateDisplay): RunningSubagent {
		let byIndex = this.verifiedCandidateStats.get(agent.verifiedRunDir as string);
		if (!byIndex) {
			byIndex = new Map();
			this.verifiedCandidateStats.set(agent.verifiedRunDir as string, byIndex);
		}
		let stats = byIndex.get(candidate.index);
		if (!stats) {
			stats = {
				id: `${agent.id}-w${candidate.index}`,
				name: agent.name,
				agent: agent.agent,
				task: agent.task,
				title: agent.title,
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "continue",
				blocking: false,
				async: true,
				startTime: agent.startTime,
				sessionFile: candidate.sessionFile,
				modelContextWindow: agent.modelContextWindow,
			};
			byIndex.set(candidate.index, stats);
		}
		this.refreshRunningSubagentState(stats);
		return stats;
	}

	startRefresh(): void {
		this.update();
		if (this.widgetInterval) return;
		this.widgetInterval = setInterval(() => {
			this.widgetFrame++;
			this.update();
		}, 80);
	}

	private resolveContextLabel(
		provider: string | undefined,
		modelId: string | undefined,
		usage: SessionUsage | undefined,
		fallbackContextWindow?: number,
	): string | undefined {
		if (!modelId || !usage) {
			return undefined;
		}

		let resolvedProvider = provider;
		let resolvedModelId = modelId;
		if (!resolvedProvider && resolvedModelId.includes("/")) {
			const [parsedProvider, ...rest] = resolvedModelId.split("/");
			resolvedProvider = parsedProvider;
			resolvedModelId = rest.join("/");
		} else if (resolvedProvider && resolvedModelId.startsWith(`${resolvedProvider}/`)) {
			resolvedModelId = resolvedModelId.slice(resolvedProvider.length + 1);
		}

		if (!resolvedProvider && !fallbackContextWindow) return undefined;

		let contextWindow = fallbackContextWindow ?? 0;
		if (!contextWindow && this.latestCtx?.modelRegistry?.find && resolvedProvider) {
			const candidates = [resolvedModelId, resolvedModelId.replace(/:[^:]+$/, "")].filter(Boolean);
			const model = [...new Set(candidates)]
				.map((candidate) => this.latestCtx?.modelRegistry.find(resolvedProvider!, candidate))
				.find(Boolean);
			contextWindow = model?.contextWindow ?? 0;
		}
		if (!contextWindow) return undefined;

		const contextTokens =
			usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (!contextTokens) return undefined;

		const pct = Math.min((contextTokens / contextWindow) * 100, 100);
		return `${formatCompactCount(contextTokens)}/${formatCompactCount(contextWindow)} ctx (${pct.toFixed(1)}%)`;
	}

	private refreshRunningSubagentState(agent: RunningSubagent): void {
		agent.taskPreview = firstNonEmptyLine(agent.title ?? agent.task, 46);

		try {
			if (!existsSync(agent.sessionFile)) return;

			const stat = statSync(agent.sessionFile);
			agent.bytes = stat.size;
			if (agent.lastSessionSize === stat.size && agent.messageCount != null) {
				return;
			}
			agent.lastSessionSize = stat.size;

			const lines = readFileSync(agent.sessionFile, "utf8")
				.split("\n")
				.filter((line: string) => line.trim());
			const entries: SessionEntryLike[] = [];
			for (const line of lines) {
				try {
					entries.push(JSON.parse(line));
				} catch {
					break;
				}
			}

			let messageCount = 0;
			let toolUses = 0;
			let totalTokens = 0;
			let lastAssistant: SessionMessageLike | null = null;
			let lastAssistantWithUsage: SessionMessageLike | null = null;
			let lastAssistantIndex = -1;

			const activityStartIndex = getSubagentActivityStartIndex(entries);
			for (let i = activityStartIndex; i < entries.length; i++) {
				const entry = entries[i];
				if (entry?.type !== "message") continue;

				const message = entry.message;
				if (message?.role === "toolResult") {
					toolUses++;
					continue;
				}

				messageCount++;
				if (message?.role === "assistant") {
					lastAssistant = message;
					lastAssistantIndex = i;
					const usage = message.usage;
					if (usage) {
						lastAssistantWithUsage = message;
						totalTokens +=
							usage.totalTokens ??
							(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
					}
				}
			}

			const pendingTools = new Map<string, string>();
			if (lastAssistantIndex >= 0 && Array.isArray(lastAssistant?.content)) {
				for (const block of lastAssistant.content) {
					if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
					pendingTools.set(block.id, typeof block.name === "string" ? block.name : "tool");
				}

				for (let i = Math.max(lastAssistantIndex + 1, activityStartIndex); i < entries.length; i++) {
					const entry = entries[i];
					const message = entry?.message;
					if (entry?.type === "message" && message?.role === "toolResult" && typeof message.toolCallId === "string") {
						pendingTools.delete(message.toolCallId);
					}
				}
			}

			const lastAssistantText = Array.isArray(lastAssistant?.content)
				? lastAssistant.content
						.filter((block: SessionContentBlock) => block?.type === "text" && typeof block.text === "string")
						.map((block: SessionContentBlock) => block.text?.trim())
						.filter(Boolean)
						.join("\n")
				: "";

			const contextSource = lastAssistantWithUsage ?? lastAssistant;
			const stopReason = lastAssistant?.stopReason;
			const terminalActivity =
				stopReason === "aborted"
					? "interrupted"
					: stopReason === "error"
						? lastAssistant?.errorMessage
							? `error: ${firstNonEmptyLine(lastAssistant.errorMessage, 60)}`
							: "error"
						: undefined;

			agent.entries = messageCount;
			agent.messageCount = messageCount;
			agent.toolUses = toolUses;
			agent.totalTokens = totalTokens;
			agent.contextTokens = contextSource?.usage
				? (contextSource.usage.totalTokens ??
					(contextSource.usage.input ?? 0) +
						(contextSource.usage.output ?? 0) +
						(contextSource.usage.cacheRead ?? 0) +
						(contextSource.usage.cacheWrite ?? 0))
				: undefined;
			agent.contextLabel = this.resolveContextLabel(
				contextSource?.provider,
				contextSource?.model,
				contextSource?.usage,
				agent.modelContextWindow,
			);
			agent.lastAssistantText = lastAssistantText;
			agent.pendingToolCount = pendingTools.size;
			agent.activity = terminalActivity ?? describeActivity([...pendingTools.values()], lastAssistantText);
		} catch {
			agent.activity ??= "starting…";
		}
	}

	private renderSubagentWidget(tui: WidgetTuiLike, theme: WidgetThemeLike): string[] {
		const agents = [...this.getAgents()];

		// If no running subagents, show nothing
		if (agents.length === 0) return [];

		const width = tui?.terminal?.columns ?? getTerminalColumns();
		const lines: string[] = [];
		const maxVisibleAgents = Math.floor((MAX_WIDGET_LINES - 2) / LINES_PER_AGENT);
		const visibleAgents = agents.length > maxVisibleAgents ? agents.slice(0, maxVisibleAgents) : agents;
		const hiddenCount = agents.length - visibleAgents.length;
		// Verified groups render one row per candidate, so their lines must be
		// accounted against the same cap as ordinary agents. Ordinary agents
		// take a fixed LINES_PER_AGENT each; the verified groups share what is
		// left, so several concurrent runs cannot overflow the widget.
		const displays = visibleAgents.map((agent) =>
			agent.verifiedRunDir ? readVerifiedRunDisplay(agent.verifiedRunDir) : null,
		);
		const ordinaryLines = displays.filter((display) => display === null).length * LINES_PER_AGENT;
		const verifiedGroupBudget = Math.max(
			visibleAgents.length * 2,
			MAX_WIDGET_LINES - 1 - 1 - ordinaryLines,
		);
		let verifiedGroupsLeft = displays.filter((display) => display !== null).length;
		let verifiedBudgetUsed = 0;
		let candidatesTruncated = false;

		// Show running subagents section
		if (agents.length > 0) {
			const spinner = SPINNER[this.widgetFrame % SPINNER.length] ?? "●";
			const oldestStartTime = Math.min(...agents.map((agent) => agent.startTime));
			lines.push(
				theme.fg("accent", "●") +
					" " +
					theme.fg("accent", "Agents") +
					theme.fg("dim", ` · ${agents.length} running · ${formatElapsedMs(oldestStartTime)}`),
			);

			for (let i = 0; i < visibleAgents.length; i++) {
				const agent = visibleAgents[i]!;
				const isLast = i === visibleAgents.length - 1;
				const connector = isLast ? "└─" : "├─";
				const childConnector = isLast ? "   " : "│  ";

				const display = displays[i];
				if (display) {
					const groupBudget = Math.max(
						2,
						Math.floor((verifiedGroupBudget - verifiedBudgetUsed) / verifiedGroupsLeft),
					);
					verifiedGroupsLeft--;
					const group = this.renderVerifiedGroup(theme, spinner, agent, display, connector, childConnector, groupBudget);
					candidatesTruncated ||= group.truncated;
					const groupLines = group.lines;
					verifiedBudgetUsed += groupLines.length;
					lines.push(...groupLines);
					continue;
				}

				const stats: string[] = [];

				const toolUses = agent.toolUses ?? 0;
				if (toolUses > 0) {
					stats.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
				}
				if (agent.contextLabel) {
					stats.push(agent.contextLabel);
				} else {
					// No resolvable context window: show the last-message snapshot, not
					// the cumulative totalTokens sum (which balloons past any window).
					const snapshot = agent.contextTokens ?? 0;
					if (snapshot > 0) stats.push(`${formatCompactCount(snapshot)} tokens`);
				}

				const header =
					theme.fg("dim", connector) +
					` ${theme.fg("accent", spinner)} ${theme.bold(agent.name)} ${renderAgentBadge(theme, agent)}` +
					(stats.length > 0 ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}` : "");
				lines.push(header);

				const displayTitle = agent.taskPreview ?? firstNonEmptyLine(agent.title ?? agent.task, 46);
				if (displayTitle) {
					const modelSuffix = agent.modelRef ? theme.fg("dim", ` · ${agent.modelRef}`) : "";
					lines.push(theme.fg("dim", childConnector) + theme.fg("muted", `  ${displayTitle}`) + modelSuffix);
				}

				const activity = agent.activity ?? "starting…";
				lines.push(theme.fg("dim", childConnector) + theme.fg("dim", `  ${activity}`));
			}

			if (hiddenCount > 0) {
				const noun = hiddenCount === 1 ? "subagent" : "subagents";
				lines.push(theme.fg("muted", `... (+${hiddenCount} more ${noun} — Alt+S to show all)`));
			} else if (candidatesTruncated) {
				// One hint for the whole widget, never per group.
				lines.push(theme.fg("muted", "... — Alt+S to show all"));
			}
		}

		return lines.map((line) => truncateToWidth(line, Math.max(1, width - 4)));
	}

	/**
	 * One row per candidate under a single logical child. The group keeps the
	 * widget budget: its rows share the lines the other visible agents leave,
	 * and overflow folds into the same Alt+S hint the agent list uses.
	 */
	private renderVerifiedGroup(
		theme: WidgetThemeLike,
		spinner: string,
		agent: RunningSubagent,
		display: NonNullable<ReturnType<typeof readVerifiedRunDisplay>>,
		connector: string,
		childConnector: string,
		linesLeft: number,
	): { lines: string[]; truncated: boolean } {
		const phase =
			display.state === "provisioning"
				? "starting"
				: display.state === "verifying"
					? "verifying"
					: display.state;
		const header =
			theme.fg("dim", connector) +
			` ${theme.fg("accent", spinner)} ${theme.bold(agent.name)} ${renderAgentBadge(theme, agent)}` +
			` ${theme.fg("dim", "·")} ${theme.fg("dim", `${display.candidateCount} candidates · ${phase}`)}`;
		const lines = [header];

		// The group shares the widget budget with the other visible agents.
		const baseRows = Math.max(1, linesLeft - 1);

		const rows: Array<{ label: string; detail: string[]; dim: boolean }> = [];
		for (const candidate of display.candidates) {
			const stats = this.candidateStats(agent, candidate);
			const detail: string[] = [];
			const state = candidate.settled
				? candidate.exitCode === null || candidate.exitCode === 0
					? "done"
					: `exit ${candidate.exitCode}`
				: (stats.activity ?? "starting…");
			detail.push(state);
			const toolUses = stats.toolUses ?? 0;
			if (toolUses > 0) detail.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
			if (stats.contextLabel) detail.push(stats.contextLabel);
			rows.push({
				label: `candidate ${candidate.index}`,
				detail,
				dim: candidate.settled,
			});
		}
		if (display.state === "verifying") {
			rows.push({ label: "verifier", detail: [`ranking ${display.candidateCount} traces…`], dim: false });
		}

		const visibleRows = rows.slice(0, rows.length > baseRows ? baseRows - 1 : baseRows);
		for (let i = 0; i < visibleRows.length; i++) {
			const row = visibleRows[i]!;
			const isLastRow = i === visibleRows.length - 1 && visibleRows.length === rows.length;
			const rowConnector = isLastRow ? "└─" : "├─";
			const tone = row.dim ? "muted" : "dim";
			lines.push(
				theme.fg("dim", childConnector) +
					theme.fg("dim", `  ${rowConnector}`) +
					` ${theme.fg(tone, row.label)} ${theme.fg("dim", `· ${row.detail.join(" · ")}`)}`,
			);
		}
		const hiddenRows = rows.length - visibleRows.length;
		if (hiddenRows > 0) {
			const noun = hiddenRows === 1 ? "candidate" : "candidates";
			lines.push(theme.fg("muted", `${childConnector}  ... (+${hiddenRows} more ${noun})`));
		}
		return { lines, truncated: hiddenRows > 0 };
	}

	private renderWidgetNow(): void {
		if (!this.latestCtx?.hasUI) return;
		const theme = this.latestCtx.ui.theme as WidgetThemeLike;
		const lines = this.renderSubagentWidget({ terminal: { columns: getTerminalColumns() } }, theme);
		this.latestCtx.ui.setWidget("subagent-status", lines.length ? lines : undefined, { placement: "aboveEditor" });
	}
}
