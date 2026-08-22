/**
 * Session transcript flattening for the verified fan-out verifier.
 *
 * Converts a candidate's Pi session JSONL into the linear trace text the
 * LLM verifier scores. The walk follows the `parentId` tree from the active
 * leaf (the most recently appended entry) so abandoned branches never reach
 * the verifier. Block text is capped per block (head+tail) and the whole
 * trace is capped again against a total character budget, because every
 * verifier prompt carries two full traces and the scoring library truncates
 * nothing.
 */
import { getEntries, type SessionEntry } from "../session/session.ts";

export const DEFAULT_TRACE_BLOCK_LIMIT = 4096;
export const DEFAULT_TRACE_TOTAL_BUDGET = 24_000;

export const EMPTY_TRACE_SENTINEL = "(no trajectory data)";

export type TraceBlockKind = "text" | "command" | "output" | "image";

export interface TraceBlock {
	kind: TraceBlockKind;
	text: string;
	originalChars: number;
	capped: boolean;
}

export interface TraceBudgetCap {
	totalBudget: number;
	originalChars: number;
	finalChars: number;
	omittedChars: number;
}

export interface FlattenedTrace {
	text: string;
	blocks: TraceBlock[];
	blockLimit: number;
	cappedBlockCount: number;
	/** Entries in the file that are not on the active leaf path (abandoned branches). */
	branchExcludedCount: number;
	/** Entries on the active path dropped by the flatten rules (thinking/system/branch/compaction/bookkeeping). */
	droppedEntryCount: number;
	/** Present only when the total-trace budget forced a deterministic reduction. */
	budgetCap: TraceBudgetCap | null;
}

export interface FlattenTraceOptions {
	/** Per-block head+tail character cap. Default 4096. */
	blockLimit?: number;
	/** Total trace character budget across blocks. Default 24000. */
	totalBudget?: number;
	/** Override the active leaf (defaults to the last entry in the file). */
	activeLeafId?: string | null;
}

interface ContentBlock {
	type?: unknown;
	[key: string]: unknown;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	[key: string]: unknown;
}

function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { message: MessageLike } {
	return entry.type === "message" && typeof (entry as { message?: unknown }).message === "object";
}

/**
 * Ordered root-to-leaf list of entries on the active branch. The active leaf
 * is the last appended entry (Pi's leaf pointer) unless overridden. A missing
 * parentId terminates the walk, so orphaned chains still flatten instead of
 * crashing.
 */
export function walkActiveBranch(entries: SessionEntry[], activeLeafId?: string | null): SessionEntry[] {
	if (entries.length === 0) return [];
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (typeof entry.id === "string") byId.set(entry.id, entry);
	}
	let leaf: SessionEntry | undefined;
	if (typeof activeLeafId === "string") {
		leaf = byId.get(activeLeafId);
	} else {
		for (let i = entries.length - 1; i >= 0; i--) {
			if (typeof entries[i].id === "string") {
				leaf = entries[i];
				break;
			}
		}
	}
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	let guard = 0;
	while (current && guard <= entries.length) {
		path.push(current);
		const parentId = current.parentId;
		if (typeof parentId !== "string" || parentId === "") break;
		current = byId.get(parentId);
		guard++;
	}
	return path.reverse();
}

function blockText(blocks: ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.filter((text) => text.trim() !== "")
		.join("\n");
}

function imageMime(block: ContentBlock): string {
	return typeof block.mimeType === "string" ? block.mimeType : "unknown";
}

function contentImages(content: unknown): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => (block as ContentBlock)?.type === "image");
}

function asArgs(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function renderEditDiff(args: Record<string, unknown>): string {
	const edits = Array.isArray(args.edits) ? args.edits : [{ oldText: args.oldText, newText: args.newText }];
	const parts: string[] = [];
	for (const rawEdit of edits) {
		const edit = asArgs(rawEdit);
		const oldText = typeof edit.oldText === "string" ? edit.oldText : "";
		const newText = typeof edit.newText === "string" ? edit.newText : "";
		for (const line of oldText.split("\n")) parts.push(`- ${line}`);
		for (const line of newText.split("\n")) parts.push(`+ ${line}`);
	}
	return parts.join("\n");
}

function renderWriteContent(args: Record<string, unknown>): string {
	const content = typeof args.content === "string" ? args.content : "";
	return content
		.split("\n")
		.map((line) => `+ ${line}`)
		.join("\n");
}

/**
 * Map one tool call to its trace command line(s). bash/exec show the command;
 * edit/write/patch show the target plus a diff-shaped view of the change;
 * other tools show their name and compact arguments so every [Output] block
 * stays attributable to a call.
 */
function toolCallCommandBlocks(
	name: string,
	args: Record<string, unknown>,
): Array<{ kind: TraceBlockKind; text: string }> {
	if (name === "bash" || name === "exec") {
		const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
		return [{ kind: "command", text: `[Command] ${command.trimEnd()}` }];
	}
	if (name === "edit") {
		const path = typeof args.path === "string" ? args.path : "";
		const diff = renderEditDiff(args);
		return [{ kind: "command", text: `[Command] edit ${path}\n${diff}`.trimEnd() }];
	}
	if (name === "write") {
		const path = typeof args.path === "string" ? args.path : "";
		return [{ kind: "command", text: `[Command] write ${path}\n${renderWriteContent(args)}`.trimEnd() }];
	}
	if (name.includes("patch")) {
		const input = args.input ?? args.patch ?? "";
		return [{ kind: "command", text: `[Command] ${name}\n${typeof input === "string" ? input : ""}`.trimEnd() }];
	}
	let detail = "";
	try {
		detail = JSON.stringify(args);
	} catch {
		detail = "";
	}
	return [{ kind: "command", text: `[Command] ${name} ${detail}`.trimEnd() }];
}

function assistantBlocks(content: unknown): Array<{ kind: TraceBlockKind; text: string }> {
	const blocks: Array<{ kind: TraceBlockKind; text: string }> = [];
	if (!Array.isArray(content)) return blocks;
	for (const raw of content) {
		const block = raw as ContentBlock;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
			blocks.push({ kind: "text", text: block.text });
		} else if (block.type === "toolCall" && typeof block.name === "string") {
			blocks.push(...toolCallCommandBlocks(block.name, asArgs(block.arguments)));
		}
		// thinking blocks are dropped: the verifier scores visible work, not
		// private reasoning blobs.
	}
	return blocks;
}

function toolResultBlocks(message: MessageLike): Array<{ kind: TraceBlockKind; text: string }> {
	const blocks: Array<{ kind: TraceBlockKind; text: string }> = [];
	const content = message.content;
	if (Array.isArray(content)) {
		const text = blockText(content as ContentBlock[]);
		if (text) blocks.push({ kind: "output", text: `[Output]\n${text}` });
		for (const image of contentImages(content)) {
			blocks.push({ kind: "image", text: `[Image omitted: ${imageMime(image)}]` });
		}
	} else if (typeof content === "string" && content.trim() !== "") {
		blocks.push({ kind: "output", text: `[Output]\n${content}` });
	}
	return blocks;
}

function customMessageBlocks(entry: SessionEntry): Array<{ kind: TraceBlockKind; text: string }> {
	const blocks: Array<{ kind: TraceBlockKind; text: string }> = [];
	const content = (entry as { content?: unknown }).content;
	if (typeof content === "string") {
		if (content.trim() !== "") blocks.push({ kind: "text", text: content });
	} else if (Array.isArray(content)) {
		const parts = content as ContentBlock[];
		const text = blockText(parts);
		if (text) blocks.push({ kind: "text", text });
		for (const image of contentImages(parts)) {
			blocks.push({ kind: "image", text: `[Image omitted: ${imageMime(image)}]` });
		}
	}
	return blocks;
}

function entryBlocks(entry: SessionEntry): Array<{ kind: TraceBlockKind; text: string }> | null {
	if (isMessageEntry(entry)) {
		const message = entry.message;
		switch (message.role) {
			case "user": {
				const blocks: Array<{ kind: TraceBlockKind; text: string }> = [];
				const content = message.content;
				if (typeof content === "string") {
					if (content.trim() !== "") blocks.push({ kind: "text", text: `[User] ${content}` });
				} else if (Array.isArray(content)) {
					const parts = content as ContentBlock[];
					const text = blockText(parts);
					if (text) blocks.push({ kind: "text", text: `[User] ${text}` });
					for (const image of contentImages(parts)) {
						blocks.push({ kind: "image", text: `[Image omitted: ${imageMime(image)}]` });
					}
				}
				return blocks;
			}
			case "assistant":
				return assistantBlocks(message.content);
			case "toolResult":
				return toolResultBlocks(message);
			case "bashExecution": {
				const command = typeof message.command === "string" ? message.command.trimEnd() : "";
				const output = typeof message.output === "string" ? message.output : "";
				const blocks: Array<{ kind: TraceBlockKind; text: string }> = [
					{ kind: "command", text: `[Command] ${command}` },
				];
				if (output.trim() !== "") blocks.push({ kind: "output", text: `[Output]\n${output}` });
				return blocks;
			}
			default:
		}
		return null;
	}
	if (entry.type === "custom_message") return customMessageBlocks(entry);
	return null;
}

function capHeadTail(text: string, limit: number): { text: string; capped: boolean } {
	if (text.length <= limit) return { text, capped: false };
	const marker = `\n[... block truncated: ${text.length} chars reduced to head+tail ...]\n`;
	const usable = Math.max(0, limit - marker.length);
	const half = Math.floor(usable / 2);
	const head = text.slice(0, half);
	const tail = text.slice(text.length - half);
	return { text: `${head}${marker}${tail}`, capped: true };
}

function applyTotalBudget(text: string, budget: number): { text: string; cap: TraceBudgetCap | null } {
	if (text.length <= budget) return { text, cap: null };
	const marker = `\n[trace truncated: <omitted> chars omitted; total budget ${budget} chars applied]\n`;
	const usable = Math.max(0, budget - marker.length);
	const half = Math.floor(usable / 2);
	const head = text.slice(0, half);
	const tail = text.slice(text.length - half);
	const omitted = text.length - head.length - tail.length;
	const finalMarker = marker.replace("<omitted>", String(omitted));
	return {
		text: `${head}${finalMarker}${tail}`,
		cap: {
			totalBudget: budget,
			originalChars: text.length,
			finalChars: head.length + finalMarker.length + tail.length,
			omittedChars: omitted,
		},
	};
}

export function flattenEntriesToTrace(entries: SessionEntry[], options: FlattenTraceOptions = {}): FlattenedTrace {
	const blockLimit = options.blockLimit ?? DEFAULT_TRACE_BLOCK_LIMIT;
	const totalBudget = options.totalBudget ?? DEFAULT_TRACE_TOTAL_BUDGET;
	const path = walkActiveBranch(entries, options.activeLeafId);
	const blocks: TraceBlock[] = [];
	let droppedEntryCount = 0;
	for (const entry of path) {
		const mapped = entryBlocks(entry);
		if (mapped === null) {
			droppedEntryCount++;
			continue;
		}
		for (const block of mapped) {
			const capped = capHeadTail(block.text, blockLimit);
			blocks.push({
				kind: block.kind,
				text: capped.text,
				originalChars: block.text.length,
				capped: capped.capped,
			});
		}
	}
	const joined = blocks.length > 0 ? blocks.map((block) => block.text).join("\n") : EMPTY_TRACE_SENTINEL;
	const budgeted = applyTotalBudget(joined, totalBudget);
	return {
		text: budgeted.text,
		blocks,
		blockLimit,
		cappedBlockCount: blocks.filter((block) => block.capped).length,
		branchExcludedCount: entries.length - path.length,
		droppedEntryCount,
		budgetCap: budgeted.cap,
	};
}

export function flattenSessionTrace(sessionFile: string, options: FlattenTraceOptions = {}): FlattenedTrace {
	return flattenEntriesToTrace(getEntries(sessionFile), options);
}
