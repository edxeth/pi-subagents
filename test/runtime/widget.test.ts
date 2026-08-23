import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SubagentWidgetManager } from "../../src/runtime/widget.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { writeVerifiedRunManifest, type VerifiedRunManifest } from "../../src/vf/run/types.ts";

function stripAnsi(text: string): string {
	return text.replace(new RegExp("\\x1b\\[[0-9;]*m", "g"), "");
}

function makeRunningSubagent(index: number): RunningSubagent {
	return {
		id: `child-${index}`,
		name: `Child ${index}`,
		agent: "scout",
		task: `Inspect area ${index}`,
		title: `Area ${index} review`,
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		blocking: false,
		async: true,
		startTime: Date.now(),
		sessionFile: `/tmp/child-${index}.jsonl`,
		activity: "reading",
	};
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
			title: "A deliberately long title that should be truncated inside padded width",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-1.jsonl",
			activity: "reading a very long module path and summarizing relevant details",
		};

		const widget = new SubagentWidgetManager(() => [running]);
		const lines = widget.renderForTest(32);

		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => stripAnsi(line).length <= 32));
	});

	it("shows a singular overflow hint with the subagent TUI shortcut", () => {
		const agents = Array.from({ length: 3 }, (_, index) => makeRunningSubagent(index + 1));
		const widget = new SubagentWidgetManager(() => agents);
		const lines = widget.renderForTest();

		assert.ok(lines.length <= 10);
		assert.equal(lines.at(-1), "... (+1 more subagent — Alt+S to show all)");
	});

	it("shows a plural overflow hint with the hidden subagent count", () => {
		const agents = Array.from({ length: 7 }, (_, index) => makeRunningSubagent(index + 1));
		const widget = new SubagentWidgetManager(() => agents);
		const lines = widget.renderForTest();

		assert.ok(lines.length <= 10);
		assert.equal(lines.at(-1), "... (+5 more subagents — Alt+S to show all)");
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

		assert.equal(running.contextLabel, "150/100 ctx (100.0%)");
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
					content: [{ type: "toolCall", id: "parent-call", name: "bash" }],
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
		writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

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

describe("verified fan-out widget rows", () => {
	function writeCandidateSession(file: string, usage?: { totalTokens: number }): void {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "openai-cpa",
					model: "openai-cpa/gpt-5.6-luna",
					...(usage ? { usage } : {}),
					content: [{ type: "text", text: "working on the fix" }],
				},
			},
		];
		writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	}

	function buildVerifiedRun(options: {
		state: VerifiedRunManifest["state"];
		candidates: Array<{ settled?: boolean; exitCode?: number | null; usage?: { totalTokens: number } }>;
	}): { runDir: string } {
		const parent = mkdtempSync(join(tmpdir(), "widget-vf-"));
		const runId = `vf-test-${Math.random().toString(16).slice(2, 8)}`;
		const runDir = join(parent, runId);
		mkdirSync(runDir, { recursive: true });
		const sessions = options.candidates.map((candidate, index) => {
			const file = join(runDir, `w${index + 1}.jsonl`);
			writeCandidateSession(file, candidate.usage);
			return file;
		});
		const now = new Date().toISOString();
		writeVerifiedRunManifest(runDir, {
			version: 2,
			runId,
			createdAt: now,
			updatedAt: now,
			state: options.state,
			leaseId: "lease",
			lease: null,
			request: {
				kind: "verified-fanout",
				name: "vf-run",
				title: "VF run",
				piCommand: "pi",
				piCommandArgs: [],
				taskArtifact: join(runDir, "task.md"),
				taskPrompt: "do the thing",
				sourceRepo: parent,
				baseCommit: "deadbeef",
				agent: "vf-worker",
				candidateCount: options.candidates.length,
				candidates: options.candidates.map((_, index) => ({
					index: index + 1,
					sessionFile: sessions[index]!,
					worktree: join(parent, `w${index + 1}`),
					internalBranch: `vf/${runId}/w${index + 1}`,
					args: [],
					env: {},
					launchEntryCount: 0,
				})),
				verifier: { model: "deepseek-v4-flash", thinking: null, env: {}, criteriaPath: "/tmp/c.md" },
				env: {},
				parentSessionId: null,
				createdAt: now,
			},
			candidates: options.candidates.map((candidate, index) => ({
				index: index + 1,
				pid: 1000 + index,
				pgid: 1000 + index,
				startedAt: now,
				exitCode: candidate.settled ? (candidate.exitCode ?? 0) : null,
				exitSignal: null,
				settled: candidate.settled ?? false,
			})),
			result: null,
		});
		return { runDir };
	}

	function verifiedAgent(runDir: string): RunningSubagent {
		return {
			id: "vf-1",
			name: "vf-demo",
			agent: "vf-worker",
			task: "Fix the stats tests",
			title: "Fix stats tests",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
			startTime: Date.now() - 1000,
			sessionFile: join(runDir, "w1.jsonl"),
			modelContextWindow: 372_000,
			verifiedRunDir: runDir,
			verifiedRunId: "vf-test",
		};
	}

	it("renders one enumerated row per candidate with per-candidate stats", () => {
		const { runDir } = buildVerifiedRun({
			state: "running",
			candidates: [
				{ settled: true, exitCode: 0, usage: { totalTokens: 7400 } },
				{ usage: { totalTokens: 5100 } },
			],
		});
		const widget = new SubagentWidgetManager(() => [verifiedAgent(runDir)]);
		const lines = widget.renderForTest().map(stripAnsi).join("\n");

		assert.match(lines, /vf-demo \[vf-worker\] · 2 candidates · running/);
		assert.match(lines, /candidate 1 · done/);
		assert.match(lines, /candidate 2 ·/);
		assert.match(lines, /7\.4K\/372K ctx/);
		assert.match(lines, /working on the fix/);
	});

	it("shows the verifier row while traces are ranked", () => {
		const { runDir } = buildVerifiedRun({
			state: "verifying",
			candidates: [{ settled: true }, { settled: true }, { settled: true }],
		});
		const widget = new SubagentWidgetManager(() => [verifiedAgent(runDir)]);
		const lines = widget.renderForTest().map(stripAnsi).join("\n");

		assert.match(lines, /3 candidates · verifying/);
		assert.match(lines, /verifier · ranking 3 traces/);
		assert.match(lines, /candidate 3 · done/);
	});

	it("truncates candidate rows within the widget budget with an overflow hint", () => {
		const { runDir } = buildVerifiedRun({
			state: "running",
			candidates: Array.from({ length: 12 }, () => ({})),
		});
		const widget = new SubagentWidgetManager(() => [verifiedAgent(runDir)]);
		const lines = widget.renderForTest().map(stripAnsi);

		assert.ok(lines.length <= 10, `widget must stay within budget: ${lines.length}`);
		assert.match(lines.at(-1) ?? "", /\(\+\d+ more candidates — Alt\+S to show all\)/);
		assert.match(lines.join("\n"), /candidate 1 ·/);
	});

	it("renders a verified group next to an ordinary agent", () => {
		const { runDir } = buildVerifiedRun({ state: "running", candidates: [{}, {}] });
		const ordinary = makeRunningSubagent(9);
		const widget = new SubagentWidgetManager(() => [ordinary, verifiedAgent(runDir)]);
		const lines = widget.renderForTest().map(stripAnsi).join("\n");

		assert.match(lines, /Child 9 \[scout\]/);
		assert.match(lines, /2 candidates · running/);
		assert.match(lines, /candidate 2 ·/);
	});
});
