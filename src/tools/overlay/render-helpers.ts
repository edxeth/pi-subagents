import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "./render-types.ts";

function padToWidth(text: string, width: number): string {
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

export function fitLine(text: string, width: number): string {
	return padToWidth(truncateToWidth(text, width), width);
}

export function renderHighlightedLine(text: string, width: number, theme: Theme): string {
	return theme.bg("selectedBg", fitLine(text, width));
}

export function renderScrollbar(
	lineIndex: number,
	visibleHeight: number,
	totalLines: number,
	scrollOffset: number,
	theme: Theme,
): string {
	if (totalLines <= visibleHeight) return " ";
	const thumbSize = Math.max(1, Math.floor((visibleHeight / totalLines) * visibleHeight));
	const trackRange = Math.max(1, visibleHeight - thumbSize);
	const scrollRange = Math.max(1, totalLines - visibleHeight);
	const thumbStart = Math.round((scrollOffset / scrollRange) * trackRange);
	const isThumb = lineIndex >= thumbStart && lineIndex < thumbStart + thumbSize;
	return theme.fg(isThumb ? "accent" : "dim", isThumb ? "█" : "│");
}

export function formatElapsed(startTime: number): string {
	const sec = (Date.now() - startTime) / 1000;
	return formatElapsedSeconds(sec);
}

export function formatElapsedSeconds(sec: number): string {
	if (sec < 60) return `${sec.toFixed(1)}s`;
	return `${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`;
}

export function compactCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return `${n}`;
}

export function firstLine(text: string, max = 60): string {
	const line =
		text
			.split("\n")
			.map((v) => v.trim())
			.find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function wrapPlainText(text: string, width: number, maxLines = 2): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [];

	const lines: string[] = [];
	let current = "";

	for (const word of normalized.split(" ")) {
		for (const part of splitLongToken(word, width)) {
			const candidate = current ? `${current} ${part}` : part;
			if (visibleWidth(candidate) <= width) {
				current = candidate;
				continue;
			}
			if (current) lines.push(current);
			current = part;
			if (lines.length === maxLines) break;
		}
		if (lines.length === maxLines) break;
	}

	if (current && lines.length < maxLines) lines.push(current);
	if (lines.length === maxLines && !consumedAll(normalized, lines)) {
		lines[maxLines - 1] = addEllipsis(lines[maxLines - 1], width);
	}
	return lines;
}

function consumedAll(input: string, lines: string[]): boolean {
	return lines.join(" ").replace(/\s+/g, "") === input.replace(/\s+/g, "");
}

function splitLongToken(token: string, width: number): string[] {
	if (visibleWidth(token) <= width) return [token];
	const parts: string[] = [];
	let current = "";
	for (const char of token) {
		if (current && visibleWidth(`${current}${char}`) > width) {
			parts.push(current);
			current = char;
		} else {
			current += char;
		}
	}
	if (current) parts.push(current);
	return parts;
}

function addEllipsis(text: string, width: number): string {
	if (width <= 1) return "…";
	return `${truncateToWidth(text, width - 1)}…`;
}
