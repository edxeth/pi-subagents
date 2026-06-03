import type { OverlayItem, OverlayState, TabId, Theme } from "./render-types.ts";
import { fitLine, renderHighlightedLine, renderScrollbar, wrapPlainText } from "./render-helpers.ts";

const EMPTY_MESSAGES: Record<TabId, string[]> = {
	running: [
		"No agents running.",
		"Launch an agent and it will appear here with live activity.",
	],
	completed: [
		"No completed agents yet.",
		"Finished, cancelled, and failed agents will appear here.",
	],
	agents: [
		"No agent definitions found.",
		"Add .md agent files in .pi/agents or ~/.pi/agent/agents.",
	],
};

export function renderList(
	state: OverlayState,
	theme: Theme,
	width: number,
	maxHeight: number,
	scroll: number,
): string[] {
	if (state.loading) return withScrollbar([` ${theme.fg("muted", "Loading…")}`], theme, width, maxHeight, 0);
	if (state.items.length === 0) return withScrollbar(renderEmptyState(state.activeTab, theme, width - 2), theme, width, maxHeight, 0);

	const contentWidth = Math.max(20, width - 2);
	const rows: string[] = [];
	for (let i = 0; i < state.items.length; i++) {
		rows.push(...renderItem(state.items[i], i === state.selectedIndex, state.activeTab, theme, contentWidth));
	}
	return withScrollbar(rows, theme, width, maxHeight, scroll);
}

export function getItemRowCount(item: OverlayItem, tab: TabId, width: number): number {
	const contentWidth = Math.max(20, width - 2);
	let count = 1;
	if (item.stats.length > 0) count++;
	const previewIndent = "    ";
	const maxPreviewLines = tab === "agents" ? 4 : 3;
	count += wrapPlainText(item.activity, Math.max(10, contentWidth - previewIndent.length), maxPreviewLines).length;
	return count;
}

function withScrollbar(rows: string[], theme: Theme, width: number, maxHeight: number, scroll: number): string[] {
	const height = Math.max(1, maxHeight);
	const contentWidth = Math.max(1, width - 2);
	const clampedScroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)));
	const visible = rows.slice(clampedScroll, clampedScroll + height);
	while (visible.length < Math.min(height, rows.length || height)) visible.push("");
	return visible.map((row, index) => {
		const content = fitLine(row, contentWidth);
		const gutter = renderScrollbar(index, height, rows.length, clampedScroll, theme);
		return fitLine(`${content} ${gutter}`, width);
	});
}

function renderEmptyState(tab: TabId, theme: Theme, width: number): string[] {
	return EMPTY_MESSAGES[tab].map((line, index) => {
		return fitLine(`  ${theme.fg(index === 0 ? "text" : "muted", line)}`, width);
	});
}

function renderItem(
	item: OverlayItem,
	isSelected: boolean,
	tab: TabId,
	theme: Theme,
	width: number,
): string[] {
	const contentWidth = Math.max(20, width - 2);
	const pointer = isSelected ? theme.fg("accent", "▸") : " ";
	const icon = theme.fg(item.iconColor, item.icon);
	const badge = item.agent ? theme.fg("muted", ` [${item.agent}]`) : "";
	const model = item.modelRef ? theme.fg("dim", ` · ${item.modelRef}`) : "";
	const status = item.status ? ` ${theme.fg(item.statusColor ?? "dim", item.status)}` : "";
	const rows = [`${pointer} ${icon} ${theme.bold(item.name)}${badge}${model}${status}`];

	const meta = item.stats.join(" · ");
	if (meta) rows.push(`    ${theme.fg("dim", meta)}`);

	const previewIndent = "    ";
	const maxPreviewLines = tab === "agents" ? 4 : 3;
	for (const preview of wrapPlainText(item.activity, Math.max(10, contentWidth - previewIndent.length), maxPreviewLines)) {
		rows.push(`${previewIndent}${theme.fg("muted", preview)}`);
	}

	const rendered = rows.map((row) => fitLine(row, width));
	if (!isSelected) return rendered;
	return rendered.map((row) => renderHighlightedLine(row, width, theme));
}
