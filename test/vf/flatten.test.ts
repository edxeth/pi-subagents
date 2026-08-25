import { dirname } from "node:path";
import { assert, after, before, createTestDir, describe, it, join, rmSync, writeFileSync } from "../support/index.ts";
import {
	DEFAULT_TRACE_BLOCK_LIMIT,
	flattenSessionTrace,
	walkActiveBranch,
	type FlattenTraceOptions,
} from "../../src/vf/flatten.ts";
import { getEntries } from "../../src/session/session.ts";

type Entry = Record<string, unknown>;

interface SessionFixture {
	dir: string;
	file: string;
}

function entry(id: string, parentId: string | null, extra: Entry): Entry {
	return { id, parentId, timestamp: `2026-08-22T00:00:${id.length}00Z`, ...extra };
}

function userEntry(id: string, parentId: string | null, text: string): Entry {
	return entry(id, parentId, {
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function textEntry(id: string, parentId: string | null, text: string, thinking?: string): Entry {
	const content: Entry[] = [];
	if (thinking) content.push({ type: "thinking", thinking });
	content.push({ type: "text", text });
	return entry(id, parentId, { type: "message", message: { role: "assistant", content } });
}

function toolCallEntry(id: string, parentId: string | null, name: string, args: Entry): Entry {
	return entry(id, parentId, {
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: `tc-${id}`, name, arguments: args }] },
	});
}

function toolResultEntry(id: string, parentId: string | null, callId: string, name: string, content: Entry[]): Entry {
	return entry(id, parentId, {
		type: "message",
		message: { role: "toolResult", toolCallId: callId, toolName: name, content },
	});
}

function writeSession(dir: string, name: string, entries: Entry[]): SessionFixture {
	const file = join(dir, name);
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return { dir, file };
}

describe("flattenSessionTrace", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("walks the active leaf path and excludes abandoned branches", () => {
		const fixture = writeSession(dir, "branched.jsonl", [
			userEntry("user-1", null, "Fix the failing test"),
			textEntry("asst-1", "user-1", "I will inspect the test file."),
			userEntry("user-2a", "asst-1", "abandoned prompt about docs"),
			textEntry("asst-2a", "user-2a", "abandoned answer about docs"),
			userEntry("user-2b", "asst-1", "retry after the bad branch"),
			textEntry("asst-2b", "user-2b", "Final answer: the test needed a fixture reset."),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /retry after the bad branch/);
		assert.match(trace.text, /Final answer: the test needed a fixture reset\./);
		assert.doesNotMatch(trace.text, /abandoned/);
		assert.equal(trace.branchExcludedCount, 2);
	});

	it("maps bash calls to [Command] and tool results to [Output]", () => {
		const fixture = writeSession(dir, "bash.jsonl", [
			userEntry("user-1", null, "Find the foo references"),
			toolCallEntry("asst-1", "user-1", "bash", { command: "rg foo src/ \n" }),
			toolResultEntry("tool-1", "asst-1", "tc-asst-1", "bash", [{ type: "text", text: "src/a.ts:1:foo" }]),
			textEntry("asst-2", "tool-1", "Done, one reference."),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /\[Command\] rg foo src\//);
		assert.match(trace.text, /\[Output\]\nsrc\/a\.ts:1:foo/);
		assert.match(trace.text, /Done, one reference\./);
	});

	it("maps edit calls to a [Command] header plus diff-shaped old/new evidence", () => {
		const fixture = writeSession(dir, "edit.jsonl", [
			userEntry("user-1", null, "Rename alpha to beta"),
			toolCallEntry("asst-1", "user-1", "edit", {
				path: "src/a.ts",
				edits: [{ oldText: "const alpha = 1;", newText: "const beta = 2;" }],
			}),
			toolResultEntry("tool-1", "asst-1", "tc-asst-1", "edit", [{ type: "text", text: "Edited src/a.ts" }]),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /\[Command\] edit src\/a\.ts/);
		assert.match(trace.text, /- const alpha = 1;/);
		assert.match(trace.text, /\+ const beta = 2;/);
	});

	it("maps write calls to a [Command] header plus the new content", () => {
		const fixture = writeSession(dir, "write.jsonl", [
			userEntry("user-1", null, "Write the notes file"),
			toolCallEntry("asst-1", "user-1", "write", { path: "notes.md", content: "finding one\nfinding two" }),
			toolResultEntry("tool-1", "asst-1", "tc-asst-1", "write", [{ type: "text", text: "Wrote notes.md" }]),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /\[Command\] write notes\.md/);
		assert.match(trace.text, /\+ finding one/);
		assert.match(trace.text, /\+ finding two/);
	});

	it("marks image content with an omission marker instead of dropping it silently", () => {
		const fixture = writeSession(dir, "image.jsonl", [
			userEntry("user-1", null, "Check the screenshot"),
			toolResultEntry("tool-1", "user-1", "tc-x", "read", [
				{ type: "image", mimeType: "image/png", data: "aGk=" },
			]),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /\[Image omitted: image\/png\]/);
	});

	it("drops thinking blocks and bookkeeping entries, keeps visible assistant text", () => {
		const fixture = writeSession(dir, "drop.jsonl", [
			entry("sess", null, { type: "session", version: 3 }),
			entry("mc", "sess", { type: "model_change", provider: "anthropic", modelId: "opus" }),
			userEntry("user-1", "mc", "Do the work"),
			textEntry("asst-1", "user-1", "Visible plan", "secret deliberation should not leak"),
			entry("comp", "asst-1", { type: "compaction", summary: "compacted history", firstKeptEntryId: "user-1", tokensBefore: 10 }),
			entry("bs", "comp", { type: "branch_summary", fromId: "asst-1", summary: "summary of abandoned branch" }),
			entry("custom", "bs", { type: "custom", customType: "pi-subagents_launch_metadata", data: { name: "worker" } }),
			textEntry("asst-2", "custom", "Visible conclusion"),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /Visible plan/);
		assert.match(trace.text, /Visible conclusion/);
		assert.doesNotMatch(trace.text, /secret deliberation/);
		assert.doesNotMatch(trace.text, /compacted history/);
		assert.doesNotMatch(trace.text, /summary of abandoned branch/);
		assert.doesNotMatch(trace.text, /pi-subagents_launch_metadata/);
		assert.ok(trace.droppedEntryCount >= 4, "bookkeeping entries counted as dropped");
	});

	it("handles v3 custom_message and bashExecution entries", () => {
		const fixture = writeSession(dir, "v3.jsonl", [
			userEntry("user-1", null, "Run the checks"),
			entry("cm-1", "user-1", {
				type: "custom_message",
				customType: "subagent_boundary",
				content: "You are the worker agent. Task: run checks.",
				display: false,
			}),
			entry("bash-1", "cm-1", {
				type: "message",
				message: {
					role: "bashExecution",
					command: "npm test",
					output: "all tests passed",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					timestamp: 1771620579506,
				},
			}),
			textEntry("asst-1", "bash-1", "Checks green."),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.match(trace.text, /You are the worker agent\. Task: run checks\./);
		assert.match(trace.text, /\[Command\] npm test/);
		assert.match(trace.text, /\[Output\]\nall tests passed/);
		assert.match(trace.text, /Checks green\./);
	});

	it("head+tail samples each output block at the block limit", () => {
		const big = `${"h".repeat(5000)}MIDDLE${"t".repeat(5000)}`;
		const fixture = writeSession(dir, "big.jsonl", [
			userEntry("user-1", null, "Dump a huge output"),
			toolResultEntry("tool-1", "user-1", "tc-x", "bash", [{ type: "text", text: big }]),
		]);
		const trace = flattenSessionTrace(fixture.file);
		const block = trace.blocks.find((b) => b.kind === "output");
		assert.ok(block, "output block exists");
		assert.equal(block?.capped, true);
		assert.equal(block?.originalChars, big.length + "[Output]\n".length);
		assert.ok((block?.text.length ?? 0) <= DEFAULT_TRACE_BLOCK_LIMIT, "capped block fits the limit");
		assert.match(block?.text ?? "", /block truncated: \d+ chars reduced to head\+tail/);
		assert.match(trace.text, /h{50}/);
		assert.match(trace.text, /t{50}/);
		assert.doesNotMatch(trace.text, /MIDDLE/);
		assert.equal(trace.cappedBlockCount, 1);
	});

	it("enforces the total-trace budget deterministically and records the applied cap", () => {
		const entries = [userEntry("user-1", null, "Long task")];
		let parent = "user-1";
		for (let i = 0; i < 8; i++) {
			const call = toolCallEntry(`asst-${i}`, parent, "bash", { command: `echo step-${i}` });
			entries.push(call);
			const result = toolResultEntry(`tool-${i}`, `asst-${i}`, `tc-asst-${i}`, "bash", [
				{ type: "text", text: `output-${i}-${"x".repeat(300)}` },
			]);
			entries.push(result);
			parent = `tool-${i}`;
		}
		const fixture = writeSession(dir, "budget.jsonl", entries);
		const options: FlattenTraceOptions = { totalBudget: 900, blockLimit: 200 };
		const trace = flattenSessionTrace(fixture.file, options);
		assert.ok(trace.text.length <= 900, `trace fits budget (got ${trace.text.length})`);
		assert.ok(trace.budgetCap, "budget cap recorded");
		assert.ok((trace.budgetCap?.originalChars ?? 0) > (trace.budgetCap?.finalChars ?? 0));
		assert.match(trace.text, /trace truncated: \d+ chars omitted; total budget 900 chars applied/);
		const again = flattenSessionTrace(fixture.file, options);
		assert.equal(again.text, trace.text, "reduction is deterministic");
	});

	it("returns the empty sentinel for a session with no traceable entries", () => {
		const fixture = writeSession(dir, "empty.jsonl", [
			entry("sess", null, { type: "session", version: 3 }),
			entry("mc", "sess", { type: "model_change", provider: "zai", modelId: "glm" }),
		]);
		const trace = flattenSessionTrace(fixture.file);
		assert.equal(trace.text, "(no trajectory data)");
	});

	it("flattens from an explicit active leaf when provided", () => {
		const fixture = writeSession(dir, "leaf.jsonl", [
			userEntry("user-1", null, "First prompt"),
			textEntry("asst-1", "user-1", "First answer"),
			userEntry("user-2", "asst-1", "Second prompt"),
			textEntry("asst-2", "user-2", "Second answer"),
		]);
		const trace = flattenSessionTrace(fixture.file, { activeLeafId: "asst-1" });
		assert.match(trace.text, /First answer/);
		assert.doesNotMatch(trace.text, /Second/);
	});
});

describe("walkActiveBranch", () => {
	it("stops at an orphaned parentId instead of throwing", () => {
		const entries = getEntriesFrom([
			userEntry("user-1", null, "root"),
			textEntry("orphan", "missing-parent", "orphaned leaf"),
		]);
		const path = walkActiveBranch(entries);
		assert.equal(path.length, 1);
		assert.equal(path[0].id, "orphan");
	});

	it("returns the file order root to leaf", () => {
		const entries = getEntriesFrom([
			userEntry("user-1", null, "one"),
			textEntry("asst-1", "user-1", "two"),
			toolResultEntry("tool-1", "asst-1", "tc", "bash", [{ type: "text", text: "three" }]),
		]);
		const path = walkActiveBranch(entries);
		assert.deepEqual(
			path.map((e) => e.id),
			["user-1", "asst-1", "tool-1"],
		);
	});
});

function getEntriesFrom(entries: Entry[]) {
	const file = join(createTestDir(), "inline.jsonl");
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	const parsed = getEntries(file);
	rmSync(dirname(file), { recursive: true, force: true });
	return parsed;
}
