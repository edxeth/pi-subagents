import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { SubagentPingMessageDetails, SubagentResultMessageDetails } from "../types.ts";

type ThemeLike = Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2];
type RenderOptions = { expanded: boolean; outputPad?: number };

type BatchChildArgs = {
	name?: string;
	agent?: string;
	task?: string;
	title?: string;
};

type SubagentCompletionDetails = SubagentResultMessageDetails & {
	id?: string;
	name?: string;
	status?: string;
	mode?: "interactive" | "background";
	deliveryState?: string;
	blocking?: boolean;
	async?: boolean;
	autoExit?: boolean;
	summary?: string;
	task?: string;
	title?: string;
};

type SubagentBatchDetails = {
	status?: string;
	children?: SubagentCompletionDetails[];
};

type SubagentBatchArgs = {
	children?: BatchChildArgs[];
};

function formatElapsedDefault(seconds: number): string {
	const s = Math.round(seconds);
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

function stripSessionRef(text: string): string {
	return text.replace(/\n\nSub-agent context: .+ used at finish\.$/, "").replace(/\n\nSession: .+\nResume: .+$/, "");
}

function firstTextContent(result: AgentToolResult<unknown>): string {
	const first = result.content?.[0];
	return first?.type === "text" ? first.text : "";
}

function getChildArg(args: SubagentBatchArgs | undefined, index: number): BatchChildArgs | undefined {
	return Array.isArray(args?.children) ? args.children[index] : undefined;
}

function getChildAgent(
	child: SubagentCompletionDetails,
	args: SubagentBatchArgs | undefined,
	index: number,
): string | undefined {
	return child.agent ?? getChildArg(args, index)?.agent;
}

function getChildName(child: SubagentCompletionDetails, args: SubagentBatchArgs | undefined, index: number): string {
	return child.name ?? getChildArg(args, index)?.name ?? "subagent";
}

function extractSummary(
	rawContent: string,
	details: (SubagentResultMessageDetails & { summary?: string; status?: string }) | undefined,
	elapsed: string,
): string {
	if (typeof details?.summary === "string") return details.summary;
	const name = details?.name ?? "subagent";
	const exitCode = details?.exitCode ?? 0;
	return stripSessionRef(rawContent)
		.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
		.replace(`Sub-agent "${name}" completed (exit code ${exitCode}).\n\n`, "")
		.replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
		.replace(`Sub-agent "${name}" failed (status failed).\n\n`, "")
		.replace(`Sub-agent "${name}" was cancelled (status cancelled).\n\n`, "")
		.replace(`Sub-agent "${name}" failed after ${elapsed} (provider/agent error — auto-retry exhausted).\n\n`, "");
}
function appendExpandableLines(
	lines: string[],
	body: string,
	options: RenderOptions,
	theme: ThemeLike,
	maxCollapsedLines = 10,
	color: "dim" | "toolOutput" = "dim",
): void {
	if (!body) return;
	const bodyLines = body.split("\n");
	const visibleLines = options.expanded ? bodyLines : bodyLines.slice(0, maxCollapsedLines);
	for (const line of visibleLines) {
		lines.push(theme.fg(color, line));
	}
	const remaining = bodyLines.length - visibleLines.length;
	if (!options.expanded && remaining > 0) {
		lines.push(theme.fg("muted", `... (${remaining} more lines,`) + ` ${expandHint()}` + theme.fg("muted", ")"));
	}
}

export function formatTaskPreview(task: string | undefined, options: RenderOptions, theme: ThemeLike): string {
	if (!task) return "";
	const lines: string[] = [];
	appendExpandableLines(lines, task, options, theme, 10, "toolOutput");
	return lines.length ? `\n${lines.join("\n")}` : "";
}

function formatSubagentCompletionHeader(
	details: SubagentCompletionDetails | undefined,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string,
	fallbackName = "subagent",
	fallbackAgent?: string,
): string {
	const name = details?.name ?? fallbackName;
	const errorMessage = details?.errorMessage;
	const exitCode = details?.exitCode ?? 0;
	const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const agent = details?.agent ?? fallbackAgent;
	const agentTag = agent ? theme.fg("dim", ` (${agent})`) : "";
	const failed = !!errorMessage || exitCode !== 0;
	const status =
		details?.status === "cancelled"
			? "cancelled"
			: errorMessage
				? "failed (provider/agent error)"
				: exitCode === 0
					? "completed"
					: `failed (exit ${exitCode})`;
	const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	return `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
}

export function formatSubagentCompletionLines(
	result: AgentToolResult<unknown>,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string = formatElapsedDefault,
): string[] {
	const details = result.details as SubagentCompletionDetails | undefined;
	const rawContent = firstTextContent(result);
	const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const lines = [formatSubagentCompletionHeader(details, theme, formatElapsed)];
	const summary = extractSummary(rawContent, details, elapsed);
	appendExpandableLines(lines, summary, options, theme);
	if (options.expanded && details?.sessionFile) {
		lines.push("");
		lines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
		lines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
	}
	return lines;
}

export function formatSubagentBatchLines(
	result: AgentToolResult<unknown>,
	args: SubagentBatchArgs | undefined,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string = formatElapsedDefault,
): string[] {
	const details = result.details as SubagentBatchDetails | undefined;
	const children = Array.isArray(details?.children) ? details.children : [];
	const lines: string[] = [];

	children.forEach((child, index) => {
		if (index > 0) lines.push("");
		const fallbackName = getChildName(child, args, index);
		const fallbackAgent = getChildAgent(child, args, index);
		lines.push(formatSubagentCompletionHeader(child, theme, formatElapsed, fallbackName, fallbackAgent));

		const summary = child.summary ?? "";
		appendExpandableLines(lines, summary, options, theme);

		if (options.expanded && child.sessionFile) {
			lines.push("");
			lines.push(theme.fg("dim", `Session: ${child.sessionFile}`));
			lines.push(theme.fg("dim", `Resume:  pi --session ${child.sessionFile}`));
		}
	});

	return lines;
}

export function renderSubagentCompletionText(
	result: AgentToolResult<unknown>,
	options: RenderOptions,
	theme: ThemeLike,
	component?: Text,
	prefixBlankLine = false,
): Text {
	const text = component ?? new Text("", 0, 0);
	const rendered = formatSubagentCompletionLines(result, options, theme).join("\n");
	text.setText(prefixBlankLine ? `\n${rendered}` : rendered);
	return text;
}

export function registerSubagentMessageRenderers(pi: ExtensionAPI, formatElapsed: (elapsed: number) => string): void {
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		const details = message.details as SubagentResultMessageDetails | undefined;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
				const failed = !!errorMessage || (details.exitCode ?? 0) !== 0;
				const bgFn = failed
					? (text: string) => theme.bg("toolErrorBg", text)
					: (text: string) => theme.bg("toolSuccessBg", text);
				const result = {
					content: [
						{
							type: "text" as const,
							text: typeof message.content === "string" ? message.content : "",
						},
					],
					details,
				};
				const box = new Box(options.outputPad ?? 1, 1, bgFn);
				box.addChild(new Text(formatSubagentCompletionLines(result, options, theme, formatElapsed).join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		const details = message.details as SubagentPingMessageDetails | undefined;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
				const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
				const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} needs help ${theme.fg("dim", `(${elapsed})`)}`;
				const rawMessage = details.message ?? (typeof message.content === "string" ? message.content : "");
				const body = stripSessionRef(rawMessage);
				const contentLines = [header];

				appendExpandableLines(contentLines, body, options, theme, 4);
				if (options.expanded && details.sessionFile) {
					contentLines.push("");
					contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
					contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
				}

				const box = new Box(options.outputPad ?? 1, 1, (text: string) => theme.bg("toolPendingBg", text));
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}
