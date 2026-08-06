import {
	formatSubagentBatchLines,
	formatSubagentCompletionLines,
	formatTaskPreview,
	registerSubagentMessageRenderers,
} from "../../src/tools/message-renderers.ts";
import { assert, describe, it } from "../support/index.ts";

const theme = {
	fg(_tone: string, text: string) {
		return text;
	},
	bg(_tone: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

describe("subagent message renderers", () => {
	it("honors Pi output padding for custom result and ping messages", () => {
		const renderers = new Map<string, (...args: any[]) => any>();
		registerSubagentMessageRenderers(
			{
				registerMessageRenderer(name: string, renderer: (...args: any[]) => any) {
					renderers.set(name, renderer);
				},
			} as any,
			(seconds) => `${seconds}s`,
		);

		const messages = [
			{
				type: "subagent_result",
				message: {
					content: "done",
					details: { name: "child", status: "completed", exitCode: 0, elapsed: 1 },
				},
			},
			{
				type: "subagent_ping",
				message: { content: "help", details: { name: "child", message: "help", elapsed: 1 } },
			},
		];

		for (const { type, message } of messages) {
			const renderer = renderers.get(type)!;
			const unpadded = renderer(message, { expanded: true, outputPad: 0 }, theme).render(40);
			const padded = renderer(message, { expanded: true, outputPad: 1 }, theme).render(40);
			const unpaddedContent = unpadded.find((line: string) => line.trim().startsWith(type === "subagent_ping" ? "?" : "✓"));
			const paddedContent = padded.find((line: string) => line.trim().startsWith(type === "subagent_ping" ? "?" : "✓"));

			assert.ok(unpaddedContent);
			assert.ok(paddedContent);
			assert.equal(unpaddedContent.startsWith(" "), false);
			assert.equal(paddedContent.startsWith(" "), true);
		}
	});

	it("renders expandable task previews with the native tool expand hint", () => {
		const preview = formatTaskPreview(
			Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
			{ expanded: false },
			theme,
		);

		assert.match(preview, /line 1\nline 2/);
		assert.match(preview, /\.\.\. \(2 more lines,.*to expand\)/);
		assert.doesNotMatch(preview, /line 11/);
	});

	it("does not character-truncate long single-line tasks", () => {
		const task = `${"a".repeat(220)} final words`;
		const preview = formatTaskPreview(task, { expanded: false }, theme);

		assert.match(preview, /final words/);
		assert.doesNotMatch(preview, /more chars/);
	});

	it("renders multi-child subagent batches with response truncation", () => {
		const lines = formatSubagentBatchLines(
			{
				content: [{ type: "text", text: "ignored raw content" }],
				details: {
					status: "batch",
					children: [
						{
							name: "magician-anarcho-communism",
							agent: "magician",
							status: "completed",
							exitCode: 0,
							elapsed: 12,
							summary: Array.from({ length: 12 }, (_, index) => `result ${index + 1}`).join("\n"),
						},
					],
				},
			},
			{
				children: [
					{
						name: "magician-anarcho-communism",
						agent: "magician",
						task: Array.from({ length: 11 }, (_, index) => `task ${index + 1}`).join("\n"),
					},
				],
			},
			{ expanded: false },
			theme,
		);

		assert.equal(lines[0], "✓ magician-anarcho-communism (magician) — completed (12s)");
		assert.deepEqual(lines.slice(1, 11), [
			"result 1",
			"result 2",
			"result 3",
			"result 4",
			"result 5",
			"result 6",
			"result 7",
			"result 8",
			"result 9",
			"result 10",
		]);
		assert.match(lines[11], /\.\.\. \(2 more lines,.*to expand\)/);
		assert.doesNotMatch(lines.join("\n"), /Task:|Response:|task 1/);
	});

	it("renders completed subagent tool results with summary and expandable tail", () => {
		const lines = formatSubagentCompletionLines(
			{
				content: [
					{
						type: "text",
						text: 'Sub-agent "astronaut" completed (exit code 0).\n\nignored fallback',
					},
				],
				details: {
					name: "astronaut",
					agent: "astronaut",
					status: "completed",
					exitCode: 0,
					elapsed: 7,
					summary: ["result", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n"),
				},
			},
			{ expanded: false },
			theme,
		);

		assert.equal(lines[0], "✓ astronaut (astronaut) — completed (7s)");
		assert.deepEqual(lines.slice(1, 11), ["result", "a", "b", "c", "d", "e", "f", "g", "h", "i"]);
		assert.match(lines[11], /\.\.\. \(1 more lines,.*to expand\)/);
	});

	it("does not render no-session context metadata as child summary text", () => {
		const lines = formatSubagentCompletionLines(
			{
				content: [
					{
						type: "text",
						text:
							'Sub-agent "astronaut" completed (7s).\n\nresult\n\n' +
							"Sub-agent context: 145K/200K tokens (72%) used at finish.",
					},
				],
				details: {
					name: "astronaut",
					status: "completed",
					exitCode: 0,
					elapsed: 7,
				},
			},
			{ expanded: true },
			theme,
		);

		assert.deepEqual(lines, ["✓ astronaut — completed (7s)", "result"]);
	});
});
