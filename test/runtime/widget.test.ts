import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunningSubagent } from "../../src/types.ts";
import { SubagentWidgetManager } from "../../src/runtime/widget.ts";

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("widget manager direct module tests", () => {
	it("renders nothing when no subagents are running", () => {
		const widget = new SubagentWidgetManager(() => []);
		assert.deepEqual(widget.renderForTest(), []);
	});

	it("renders the updated agent summary layout", () => {
		const running: RunningSubagent = {
			id: "child-1",
			name: "Research",
			agent: "researcher",
			task: "Inspect the auth module for session handling and return a concise report.",
			title: "Auth session review",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			startTime: Date.now() - 1500,
			sessionFile: "/tmp/child-1.jsonl",
			messageCount: 3,
			toolUses: 1,
			pendingToolCount: 1,
			activity: "reading auth module",
			modelRef: "zai-messages/glm-5.1:high",
		};

		const widget = new SubagentWidgetManager(() => [running]);
		const lines = widget.renderForTest(120).join("\n");

		assert.match(lines, /^● Agents · 1 running · 1\.5s/m);
		assert.match(lines, /^└─ ◜ Research \[researcher\]/m);
		assert.doesNotMatch(lines, /└─ [-\\|/] Research \[researcher\]/);
		assert.match(lines, /1 tool use/);
		assert.doesNotMatch(lines, /3 messages/);
		assert.match(lines, /Auth session review · zai-messages\/glm-5\.1:high/);
		assert.doesNotMatch(lines, /return a concise report/);
		assert.match(lines, /reading auth module/);
		assert.doesNotMatch(lines, /\[detached\]/);
	});

	it("renders widget lines without exceeding the terminal width", () => {
		const running: RunningSubagent = {
			id: "child-1",
			name: "Research",
			agent: "researcher",
			task: "Inspect a module with a deliberately long description for truncation.",
			title:
				"A deliberately long title that should be truncated inside padded width",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-1.jsonl",
			activity:
				"reading a very long module path and summarizing relevant details",
		};

		const widget = new SubagentWidgetManager(() => [running]);
		const lines = widget.renderForTest(32);

		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => stripAnsi(line).length <= 32));
	});

	it("uses native totalTokens and caps ctx at 100%", () => {
		const dir = mkdtempSync(join(tmpdir(), "widget-test-"));
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "anthropic/test-model",
					usage: { totalTokens: 150, input: 120, output: 40 },
					content: [{ type: "text", text: "Done" }],
				},
			})}\n`,
		);

		const running: RunningSubagent = {
			id: "child-ctx",
			name: "Ctx",
			agent: "researcher",
			task: "Check usage",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile,
			modelContextWindow: 100,
		};

		const widget = new SubagentWidgetManager(() => [running]);
		(widget as any).refreshRunningSubagentState(running);

		assert.equal(running.contextLabel, "100.0%/100 ctx");
	});

	it("ignores inherited fork history before subagent launch metadata", () => {
		const dir = mkdtempSync(join(tmpdir(), "widget-fork-test-"));
		const sessionFile = join(dir, "forked-child.jsonl");
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai",
					model: "openai/parent",
					usage: { totalTokens: 1_000_000 },
					content: [
						{ type: "toolCall", id: "parent-call", name: "bash" },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "parent-call",
					content: [{ type: "text", text: "parent result" }],
				},
			},
			{
				type: "custom",
				customType: "pi-subagents_launch_metadata",
				data: { name: "forked-child" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "anthropic/child",
					usage: { totalTokens: 25 },
					content: [{ type: "text", text: "child work" }],
				},
			},
		];
		writeFileSync(
			sessionFile,
			entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
		);

		const running: RunningSubagent = {
			id: "forked-child",
			name: "Forked",
			agent: "reviewer",
			task: "Review fork stats",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile,
		};

		const widget = new SubagentWidgetManager(() => [running]);
		(widget as any).refreshRunningSubagentState(running);

		assert.equal(running.toolUses, 0);
		assert.equal(running.totalTokens, 25);
		assert.equal(running.lastAssistantText, "child work");
	});
});
