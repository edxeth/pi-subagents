import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import type {
	RunningSubagent,
	SessionContentBlock,
	SessionEntryLike,
	SessionMessageLike,
	SessionUsage,
	WidgetThemeLike,
	WidgetTuiLike,
} from "./runtime-types.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

interface RenderCapableTui extends WidgetTuiLike {
	requestRender?(): void;
}

function formatCompactCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
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
	private widgetRegistered = false;
	private widgetTui: RenderCapableTui | null = null;
	private readonly getAgents: () => Iterable<RunningSubagent>;

	constructor(getAgents: () => Iterable<RunningSubagent>) {
		this.getAgents = getAgents;
	}

	reset(): void {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = null;
		}
		this.latestCtx = null;
		this.widgetFrame = 0;
		this.widgetRegistered = false;
		this.widgetTui = null;
	}

	attachContext(ctx: ExtensionContext): void {
		if (this.latestCtx !== ctx) {
			this.latestCtx = ctx;
			this.widgetRegistered = false;
			this.widgetTui = null;
		}
		this.ensureWidgetRegistered();
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
			.map((candidate) => this.latestCtx!.modelRegistry.find(provider!, candidate))
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

		this.ensureWidgetRegistered();
		this.widgetTui?.requestRender?.();

		if (![...this.getAgents()].length && this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = null;
		}
	}

	startRefresh(): void {
		this.ensureWidgetRegistered();
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
		} else if (
			resolvedProvider &&
			resolvedModelId.startsWith(`${resolvedProvider}/`)
		) {
			resolvedModelId = resolvedModelId.slice(resolvedProvider.length + 1);
		}

		if (!resolvedProvider && !fallbackContextWindow) return undefined;

		let contextWindow = fallbackContextWindow ?? 0;
		if (!contextWindow && this.latestCtx?.modelRegistry?.find && resolvedProvider) {
			const candidates = [
				resolvedModelId,
				resolvedModelId.replace(/:[^:]+$/, ""),
			].filter(Boolean);
			const model = [...new Set(candidates)]
				.map((candidate) => this.latestCtx!.modelRegistry.find(resolvedProvider!, candidate))
				.find(Boolean);
			contextWindow = model?.contextWindow ?? 0;
		}
		if (!contextWindow) return undefined;

		const contextTokens =
			usage.totalTokens ??
			(usage.input ?? 0) +
				(usage.output ?? 0) +
				(usage.cacheRead ?? 0) +
				(usage.cacheWrite ?? 0);
		if (!contextTokens) return undefined;

		const pct = Math.min((contextTokens / contextWindow) * 100, 100);
		return `${pct.toFixed(1)}%/${formatCompactCount(contextWindow)} ctx`;
	}

	private refreshRunningSubagentState(agent: RunningSubagent): void {
		agent.taskPreview = firstNonEmptyLine(agent.task, 46);

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

			for (let i = 0; i < entries.length; i++) {
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
							(usage.input ?? 0) +
								(usage.output ?? 0) +
								(usage.cacheRead ?? 0) +
								(usage.cacheWrite ?? 0);
					}
				}
			}

			const pendingTools = new Map<string, string>();
			if (lastAssistantIndex >= 0 && Array.isArray(lastAssistant?.content)) {
				for (const block of lastAssistant.content) {
					if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
					pendingTools.set(
						block.id,
						typeof block.name === "string" ? block.name : "tool",
					);
				}

				for (let i = lastAssistantIndex + 1; i < entries.length; i++) {
					const entry = entries[i];
					const message = entry?.message;
					if (
						entry?.type === "message" &&
						message?.role === "toolResult" &&
						typeof message.toolCallId === "string"
					) {
						pendingTools.delete(message.toolCallId);
					}
				}
			}

			const lastAssistantText = Array.isArray(lastAssistant?.content)
				? lastAssistant.content
						.filter(
							(block: SessionContentBlock) =>
								block?.type === "text" && typeof block.text === "string",
						)
						.map((block: SessionContentBlock) => block.text!.trim())
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
			agent.contextLabel = this.resolveContextLabel(
				contextSource?.provider,
				contextSource?.model,
				contextSource?.usage,
				agent.modelContextWindow,
			);
			agent.lastAssistantText = lastAssistantText;
			agent.pendingToolCount = pendingTools.size;
			agent.activity =
				terminalActivity ??
				describeActivity([...pendingTools.values()], lastAssistantText);
		} catch {
			agent.activity ??= "starting…";
		}
	}

	private renderSubagentWidget(tui: WidgetTuiLike, theme: WidgetThemeLike): string[] {
		const agents = [...this.getAgents()];
		if (agents.length === 0) return [];

		const width = tui?.terminal?.columns ?? 80;
		const spinner = SPINNER[this.widgetFrame % SPINNER.length] ?? "●";
		const runningCount = agents.filter((agent) => (agent.pendingToolCount ?? 0) > 0).length;
		const oldestStartTime = Math.min(...agents.map((agent) => agent.startTime));
		const lines: string[] = [
			truncateToWidth(
				theme.fg("accent", "●") +
					" " +
					theme.fg("accent", "Agents") +
					theme.fg(
						"dim",
						` ${runningCount}/${agents.length} running · ${formatElapsedMs(oldestStartTime)}`,
					),
				width,
			),
		];

		for (let i = 0; i < agents.length; i++) {
			const agent = agents[i]!;
			const isLast = i === agents.length - 1;
			const connector = isLast ? "└─" : "├─";
			const childConnector = isLast ? "   " : "│  ";
			const stats: string[] = [];

			if (agent.messageCount != null) {
				stats.push(
					`${agent.messageCount} message${agent.messageCount === 1 ? "" : "s"}`,
				);
			}
			if ((agent.toolUses ?? 0) > 0) {
				stats.push(`${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`);
			}
			if (agent.contextLabel) {
				stats.push(agent.contextLabel);
			} else if ((agent.totalTokens ?? 0) > 0) {
				stats.push(`${formatCompactCount(agent.totalTokens)} tokens`);
			}

			const header =
				theme.fg("dim", connector) +
				` ${theme.fg("accent", spinner)} ${theme.bold(agent.name)} ${renderAgentBadge(theme, agent)}` +
				(stats.length > 0
					? ` ${theme.fg("dim", "·")} ${theme.fg("dim", stats.join(" · "))}`
					: "");
			lines.push(truncateToWidth(header, width));

			if (agent.taskPreview) {
				lines.push(
					truncateToWidth(
						theme.fg("dim", childConnector) +
							theme.fg("muted", `  ${agent.taskPreview}`),
						width,
					),
				);
			}

			const activity = agent.activity ?? "starting…";
			lines.push(
				truncateToWidth(
					theme.fg("dim", childConnector) +
						theme.fg("dim", `  ${activity}`),
					width,
				),
			);
		}

		return lines;
	}

	private ensureWidgetRegistered(): void {
		if (!this.latestCtx?.hasUI || this.widgetRegistered) return;

		this.latestCtx.ui.setWidget(
			"subagent-status",
			(tui: WidgetTuiLike, theme: WidgetThemeLike) => {
				this.widgetTui = tui as RenderCapableTui;
				return {
					render: () => this.renderSubagentWidget(tui, theme),
					invalidate: () => {
						this.widgetRegistered = false;
						this.widgetTui = null;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
		this.widgetRegistered = true;
	}
}
