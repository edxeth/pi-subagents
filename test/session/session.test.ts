import {
	assert,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	join,
	after,
	before,
	describe,
	it,
	appendBranchSummary,
	copySessionFile,
	findLastAssistantMessage,
	findLastSubagentOutput,
	getEntries,
	getEntryCount,
	getLeafId,
	getNewEntries,
	mergeNewEntries,
	createTestDir,
	createSessionFile,
	SESSION_HEADER,
	MODEL_CHANGE,
	USER_MSG,
	ASSISTANT_MSG,
	ASSISTANT_MSG_2,
	TOOL_RESULT,
} from "../support/index.ts";

describe("session.ts", () => {
	let dir: string;

	before(() => {
		dir = createTestDir();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("getEntries", () => {
		it("throws with file path and line number for invalid json", () => {
			const file = join(dir, "invalid-session.jsonl");
			writeFileSync(file, '{"type":"session","id":"ok"}\nnot-json\n');

			assert.throws(
				() => getEntries(file),
				/Invalid session JSONL at .*invalid-session\.jsonl:2:/,
			);
		});
	});

	describe("getLeafId", () => {
		it("returns last entry id", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			assert.equal(getLeafId(file), "asst-001");
		});

		it("returns null for empty file", () => {
			const file = join(dir, "empty.jsonl");
			writeFileSync(file, "");
			assert.equal(getLeafId(file), null);
		});
	});

	describe("getEntryCount", () => {
		it("counts non-empty lines", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
			]);
			assert.equal(getEntryCount(file), 3);
		});

		it("returns 0 for empty file", () => {
			const file = join(dir, "empty2.jsonl");
			writeFileSync(file, "\n\n");
			assert.equal(getEntryCount(file), 0);
		});
	});

	describe("getNewEntries", () => {
		it("returns entries after a given line", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				MODEL_CHANGE,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 2);
			assert.equal(entries[0].id, "user-001");
			assert.equal(entries[1].id, "asst-001");
		});

		it("returns empty array when no new entries", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
			const entries = getNewEntries(file, 2);
			assert.equal(entries.length, 0);
		});

		it("reports the correct original line number for invalid new entries", () => {
			const file = join(dir, "invalid-new-entries.jsonl");
			writeFileSync(
				file,
				`${[JSON.stringify(SESSION_HEADER), JSON.stringify(MODEL_CHANGE), "not-json"].join("\n")}\n`,
			);

			assert.throws(
				() => getNewEntries(file, 2),
				/Invalid session JSONL at .*invalid-new-entries\.jsonl:3:/,
			);
		});
	});

	describe("findLastAssistantMessage", () => {
		it("finds last assistant text", () => {
			const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated outline with details.");
		});

		it("joins multiple text blocks with newlines", () => {
			const entries = [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "First line" },
							{ type: "text", text: "Second line" },
						],
					},
				},
			] as any[];

			assert.equal(
				findLastAssistantMessage(entries),
				"First line\nSecond line",
			);
		});

		it("skips thinking blocks, gets text only", () => {
			const entries = [ASSISTANT_MSG_2] as any[];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Updated outline with details.");
		});

		it("skips tool results", () => {
			const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
			const text = findLastAssistantMessage(entries);
			assert.equal(text, "Here is my outline...");
		});

		it("returns null when no assistant messages", () => {
			const entries = [USER_MSG] as any[];
			assert.equal(findLastAssistantMessage(entries), null);
		});

		it("returns null for empty array", () => {
			assert.equal(findLastAssistantMessage([]), null);
		});

		it("skips empty assistant messages and returns real content above", () => {
			const realMsg = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Real summary content." }],
				},
			};
			const emptyMsg = {
				type: "message",
				message: {
					role: "assistant",
					content: [],
				},
			};
			const entries = [realMsg, emptyMsg] as any[];
			assert.equal(findLastAssistantMessage(entries), "Real summary content.");
		});

		it("surfaces errorMessage when last assistant has stopReason=error and no text", () => {
			const earlierGood = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Investigating the bug..." }],
				},
			};
			const overloadError = {
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Anthropic 529 Overloaded after 3 retries",
				},
			};
			const entries = [earlierGood, overloadError] as any[];
			assert.equal(
				findLastAssistantMessage(entries),
				"Subagent error: Anthropic 529 Overloaded after 3 retries",
			);
		});

		it("prefers text content even when error stopReason is set", () => {
			const msg = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Here is partial output." }],
					stopReason: "error",
					errorMessage: "stream interrupted",
				},
			};
			assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
		});

		it("surfaces a generic error when stop=error has no errorMessage", () => {
			const earlierStatus = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Investigating the bug..." }],
				},
			};
			const msg = {
				type: "message",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
				},
			};
			assert.equal(
				findLastAssistantMessage([earlierStatus, msg] as any[]),
				"Subagent error",
			);
		});

		it("does not scan past a final assistant length stop with no text", () => {
			const earlierStatus = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "I'll review the diff now." }],
				},
			};
			const finalLengthStop = {
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "still reviewing" }],
					stopReason: "length",
				},
			};

			assert.equal(
				findLastAssistantMessage([earlierStatus, finalLengthStop] as any[]),
				"Subagent stopped before producing a result (stopReason: length)",
			);
		});
	});

	describe("findLastSubagentOutput", () => {
		it("prefers final assistant text", () => {
			const entries = [
				TOOL_RESULT,
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Final assistant summary." }],
					},
				},
			] as any[];

			assert.equal(findLastSubagentOutput(entries), "Final assistant summary.");
		});

		it("does not fall back to stale output after a terminal length stop", () => {
			const entries = [
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "I'll review the diff now." }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "bash",
						content: [{ type: "text", text: "intermediate command output" }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "thinking", thinking: "still reviewing" }],
						stopReason: "length",
					},
				},
			] as any[];

			assert.equal(
				findLastSubagentOutput(entries),
				"Subagent stopped before producing a result (stopReason: length)",
			);
		});

		it("falls back to the last meaningful tool result when assistant only calls subagent_done", () => {
			const entries = [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "bash",
						content: [{ type: "text", text: "Actual child output." }],
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", name: "subagent_done", arguments: {} },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "subagent_done",
						content: [{ type: "text", text: "Shutting down subagent session." }],
					},
				},
			] as any[];

			assert.equal(findLastSubagentOutput(entries), "Actual child output.");
		});
	});

	describe("appendBranchSummary", () => {
		it("appends valid branch_summary entry", () => {
			const file = createSessionFile(dir, [
				SESSION_HEADER,
				USER_MSG,
				ASSISTANT_MSG,
			]);
			const id = appendBranchSummary(
				file,
				"user-001",
				"asst-001",
				"The outline was created.",
			);

			assert.ok(id, "should return an id");
			assert.equal(typeof id, "string");

			const lines = readFileSync(file, "utf8").trim().split("\n");
			assert.equal(lines.length, 4);

			const summary = JSON.parse(lines[3]);
			assert.equal(summary.type, "branch_summary");
			assert.equal(summary.id, id);
			assert.equal(summary.parentId, "user-001");
			assert.equal(summary.fromId, "asst-001");
			assert.equal(summary.summary, "The outline was created.");
			assert.ok(summary.timestamp);
		});

		it("uses branchPointId as fromId fallback", () => {
			const file = createSessionFile(dir, [SESSION_HEADER]);
			appendBranchSummary(file, "branch-pt", null, "summary");

			const lines = readFileSync(file, "utf8").trim().split("\n");
			const summary = JSON.parse(lines[1]);
			assert.equal(summary.fromId, "branch-pt");
		});
	});

	describe("copySessionFile", () => {
		it("creates a copy with different path", () => {
			const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const copyDir = join(dir, "copies");
			mkdirSync(copyDir, { recursive: true });
			const copy = copySessionFile(file, copyDir);

			assert.notEqual(copy, file);
			assert.ok(copy.endsWith(".jsonl"));
			assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
		});
	});

	describe("mergeNewEntries", () => {
		it("appends new entries from source to target", () => {
			const sourceFile = join(dir, "merge-source.jsonl");
			const targetFile = join(dir, "merge-target.jsonl");
			writeFileSync(
				sourceFile,
				`${[SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n")}\n`,
			);
			writeFileSync(
				targetFile,
				`${[SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n")}\n`,
			);

			const merged = mergeNewEntries(sourceFile, targetFile, 2);
			assert.equal(merged.length, 1);
			assert.equal(merged[0].id, "asst-001");

			const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
			assert.equal(targetLines.length, 3);
		});

		it("returns an empty array when there is nothing to merge", () => {
			const sourceFile = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
			const targetFile = join(dir, "merge-empty-target.jsonl");
			writeFileSync(targetFile, readFileSync(sourceFile, "utf8"));

			assert.deepEqual(mergeNewEntries(sourceFile, targetFile, 2), []);
			assert.equal(
				readFileSync(targetFile, "utf8"),
				readFileSync(sourceFile, "utf8"),
			);
		});
	});
});

