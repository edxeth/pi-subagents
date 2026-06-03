import type { FooterHint, OverlayState, TabDef, Theme } from "./render-types.ts";
import { fitLine } from "./render-helpers.ts";

/**
 * Render the overlay header: accent border, title, tab bar.
 */
export function renderHeader(
	state: OverlayState,
	tabs: TabDef[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];

	// Top border
	lines.push(theme.fg("accent", "─".repeat(width)));

	lines.push(fitLine(` ${theme.bold(theme.fg("accent", "Subagents"))}`, width));
	lines.push(" ".repeat(width));
	lines.push(renderTabBar(state.activeTab, tabs, theme, width));
	lines.push(" ".repeat(width));

	return lines;
}

/**
 * Render the overlay footer: context-sensitive keymaps + bottom border.
 */
export function renderFooter(
	hints: FooterHint[],
	theme: Theme,
	width: number,
): string[] {
	const lines: string[] = [];
	lines.push(" ".repeat(width));

	const hintText = hints
		.map((h) => `${theme.fg("accent", h.key)} ${theme.fg("dim", h.action)}`)
		.join(theme.fg("muted", "  ·  "));

	lines.push(fitLine(` ${hintText}`, width));
	lines.push(theme.fg("accent", "─".repeat(width)));

	return lines;
}

/**
 * Get context-sensitive footer hints based on current view state.
 */
export function getFooterHints(state: OverlayState): FooterHint[] {
	if (state.view.kind === "detail") {
		return [
			{ key: "↑↓", action: "scroll" },
			{ key: "Esc", action: "back" },
			{ key: "alt+s", action: "close" },
		];
	}

	if (state.view.kind === "editor") {
		return [
			{ key: "Enter", action: "send" },
			{ key: "Esc", action: "cancel" },
		];
	}

	const hints: FooterHint[] = [
		{ key: "↑↓", action: "navigate" },
		{ key: "←→", action: "tabs" },
	];

	if (state.activeTab === "running" && state.items.length > 0) {
		hints.push({ key: "x", action: "kill" });
	}
	if (state.activeTab === "completed" && state.items.length > 0) {
		hints.push({ key: "m", action: "resume" });
	}
	if (state.items.length > 0) {
		hints.push({ key: "Enter", action: "details" });
	}
	hints.push({ key: "Esc", action: "close" });

	return hints;
}

function renderTabBar(
	activeTab: string,
	tabs: TabDef[],
	theme: Theme,
	width: number,
): string {
	const rendered = tabs.map((tab) => {
		const text = ` ${tab.label} `;
		if (tab.id === activeTab) {
			return theme.bg("selectedBg", theme.fg("text", text));
		}
		return theme.fg("muted", text);
	});

	const separator = " ";
	const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
	const leftArrow = activeIndex > 0 ? theme.fg("dim", "←  ") : "   ";
	const rightArrow = activeIndex >= 0 && activeIndex < tabs.length - 1 ? theme.fg("dim", "  →") : "";
	const tabContent = rendered.join(separator);

	return fitLine(`${leftArrow}${tabContent}${rightArrow}`, width);
}
