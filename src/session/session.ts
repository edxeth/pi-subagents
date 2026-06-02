import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CALLER_PING_TOOL_NAME,
	SUBAGENT_DONE_TOOL_NAME,
} from "../tools/tool-names.ts";

export interface SessionEntry {
	type: string;
	id: string;
	parentId?: string;
	[key: string]: unknown;
}

interface MessageEntry extends SessionEntry {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		toolName?: string;
		content: Array<{ type: string; text?: string; [key: string]: unknown }>;
	};
}

function getNonEmptyLines(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim());
}

function parseEntryLine(
	sessionFile: string,
	line: string,
	lineNumber: number,
): SessionEntry {
	try {
		return JSON.parse(line) as SessionEntry;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Invalid session JSONL at ${sessionFile}:${lineNumber}: ${message}`,
		);
	}
}

export function getEntries(sessionFile: string): SessionEntry[] {
	return getNonEmptyLines(sessionFile).map((line, index) =>
		parseEntryLine(sessionFile, line, index + 1),
	);
}

export function getLeafId(sessionFile: string): string | null {
	const entries = getEntries(sessionFile);
	return entries.length > 0 ? entries[entries.length - 1].id : null;
}

export function getEntryCount(sessionFile: string): number {
	return getNonEmptyLines(sessionFile).length;
}

export function getNewEntries(
	sessionFile: string,
	afterLine: number,
): SessionEntry[] {
	return getNonEmptyLines(sessionFile)
		.slice(afterLine)
		.map((line, index) =>
			parseEntryLine(sessionFile, line, afterLine + index + 1),
		);
}

function getTextContent(msg: MessageEntry): string | null {
	const texts = msg.message.content
		.filter(
			(block) =>
				block.type === "text" &&
				typeof block.text === "string" &&
				block.text.trim() !== "",
		)
		.map((block) => block.text as string);

	return texts.length > 0 && texts.join("").trim() ? texts.join("\n") : null;
}

function getTerminalStopMessage(msg: MessageEntry): string | null {
	const stopReason = (msg.message as Record<string, unknown>).stopReason;
	if (typeof stopReason !== "string" || stopReason.trim() === "") {
		return null;
	}

	const errorMessage = (msg.message as Record<string, unknown>).errorMessage;
	if (stopReason === "error") {
		return typeof errorMessage === "string" && errorMessage.trim() !== ""
			? `Subagent error: ${errorMessage.trim()}`
			: "Subagent error";
	}

	return getSubagentTerminalStopMessage(stopReason);
}

function getSubagentTerminalStopMessage(stopReason: string): string {
	return `Subagent stopped before producing a result (stopReason: ${stopReason})`;
}

export function getSubagentTerminalStopReason(summary: string): string | null {
	const match = /^Subagent stopped before producing a result \(stopReason: (.+)\)$/.exec(summary);
	return match?.[1]?.trim() || null;
}

export function findLastAssistantMessage(
	entries: SessionEntry[],
): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry as MessageEntry;
		if (msg.message.role !== "assistant") continue;
		const text = getTextContent(msg);
		if (text) return text;

		// A terminal assistant turn with no text is still the child outcome.
		// Surface it instead of scanning past it to stale earlier status text.
		const stopMessage = getTerminalStopMessage(msg);
		if (stopMessage) return stopMessage;
	}
	return null;
}

export function findLastSubagentOutput(entries: SessionEntry[]): string | null {
	const assistantText = findLastAssistantMessage(entries);
	if (assistantText) return assistantText;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const msg = entry as MessageEntry;
		if (msg.message.role !== "toolResult") continue;
		if (msg.message.toolName === SUBAGENT_DONE_TOOL_NAME) continue;
		if (msg.message.toolName === CALLER_PING_TOOL_NAME) continue;
		const text = getTextContent(msg);
		if (text) return text;
	}
	return null;
}

export function appendBranchSummary(
	sessionFile: string,
	branchPointId: string,
	fromId: string | null,
	summary: string,
): string {
	const id = randomBytes(4).toString("hex");
	const entry = {
		type: "branch_summary",
		id,
		parentId: branchPointId,
		timestamp: new Date().toISOString(),
		fromId: fromId ?? branchPointId,
		summary,
	};
	appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
	return id;
}

export function copySessionFile(sessionFile: string, destDir: string): string {
	const id = randomBytes(4).toString("hex");
	const dest = join(destDir, `subagent-${id}.jsonl`);
	copyFileSync(sessionFile, dest);
	return dest;
}

export function mergeNewEntries(
	sourceFile: string,
	targetFile: string,
	afterLine: number,
): SessionEntry[] {
	const entries = getNewEntries(sourceFile, afterLine);
	for (const entry of entries) {
		appendFileSync(targetFile, `${JSON.stringify(entry)}\n`, "utf8");
	}
	return entries;
}
