import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fitLine, renderScrollbar, wrapPlainText } from "./render-helpers.ts";
import type { DetailField, DetailSection, OverlayItem, Theme } from "./render-types.ts";

export function renderDetail(
	item: OverlayItem,
	scroll: number,
	theme: Theme,
	width: number,
	maxHeight: number,
): string[] {
	const gutterWidth = 2;
	const contentWidth = Math.max(20, width - gutterWidth);
	const contentLines = buildDetailContent(item, theme, contentWidth);
	const visibleHeight = Math.min(maxHeight, contentLines.length);
	const clampedScroll = clampScroll(scroll, contentLines.length, visibleHeight);
	const visible = contentLines.slice(clampedScroll, clampedScroll + visibleHeight);

	return visible.map((line, index) => {
		const content = fitLine(line, contentWidth);
		const gutter = renderScrollbar(index, visibleHeight, contentLines.length, clampedScroll, theme);
		return truncateToWidth(`${content} ${gutter}`, width);
	});
}

export function getMaxScroll(item: OverlayItem, width: number, maxHeight: number): number {
	const plainTheme: Theme = {
		fg: (_tone, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
	};
	const contentLines = buildDetailContent(item, plainTheme, Math.max(20, width - 2));
	return Math.max(0, contentLines.length - maxHeight);
}

function clampScroll(scroll: number, totalLines: number, visibleHeight: number): number {
	return Math.max(0, Math.min(scroll, Math.max(0, totalLines - visibleHeight)));
}

function buildDetailContent(item: OverlayItem, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	lines.push(` ${theme.fg("accent", "▸")} ${theme.bold(theme.fg("accent", item.name))}`);
	if (item.agent && item.agent !== item.name) lines.push(`   ${theme.fg("muted", item.agent)}`);
	if (item.status) lines.push(`   ${theme.fg(item.statusColor ?? "dim", item.status)}`);
	lines.push("");

	for (const section of item.detailSections) {
		const rendered = renderSection(section, theme, width);
		if (rendered.length === 0) continue;
		if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
		lines.push(...rendered);
	}

	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function renderSection(section: DetailSection, theme: Theme, width: number): string[] {
	const fields = section.fields.filter((field) => field.value || field.label);
	if (fields.length === 0) return [];

	const lines: string[] = [];
	lines.push(renderSectionTitle(section.title, theme, width));

	const maxLabelWidth = Math.min(
		20,
		Math.max(0, ...fields.filter((field) => field.label).map((field) => visibleWidth(field.label))),
	);
	const valueWidth = Math.max(10, width - maxLabelWidth - 6);

	for (const field of fields) {
		lines.push(...renderField(field, maxLabelWidth, valueWidth, theme));
	}
	return lines;
}

function renderSectionTitle(title: string, theme: Theme, width: number): string {
	const text = title
		.replace(/^──\s*/, "")
		.replace(/\s*──$/, "")
		.trim();
	const label = ` ${text} `;
	const side = Math.max(2, Math.floor((width - visibleWidth(label)) / 2));
	return theme.fg("accent", `${"─".repeat(side)}${label}${"─".repeat(side)}`);
}

function renderField(field: DetailField, labelWidth: number, valueWidth: number, theme: Theme): string[] {
	if (!field.label) {
		return wrapPlainText(field.value, labelWidth + valueWidth + 2, Number.MAX_SAFE_INTEGER).map(
			(line) => `   ${theme.fg("muted", line)}`,
		);
	}

	const label = field.label.padEnd(labelWidth);
	const value = field.value || "—";
	const wrapped = wrapPlainText(value, valueWidth, Number.MAX_SAFE_INTEGER);
	if (wrapped.length === 0) return [`   ${theme.fg("dim", label)}  ${theme.fg("text", "—")}`];
	return wrapped.map((line, index) => {
		const renderedLabel = index === 0 ? label : "".padEnd(labelWidth);
		return `   ${theme.fg("dim", renderedLabel)}  ${theme.fg("text", line)}`;
	});
}
