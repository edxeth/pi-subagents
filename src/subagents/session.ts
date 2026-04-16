import { appendFileSync, copyFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

function getNonEmptyLines(sessionFile: string): string[] {
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim());
}

function parseEntryLine(sessionFile: string, line: string, lineNumber: number): SessionEntry {
  try {
    return JSON.parse(line) as SessionEntry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid session JSONL at ${sessionFile}:${lineNumber}: ${message}`);
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

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  return getNonEmptyLines(sessionFile)
    .slice(afterLine)
    .map((line, index) => parseEntryLine(sessionFile, line, afterLine + index + 1));
}

export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
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
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
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
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
