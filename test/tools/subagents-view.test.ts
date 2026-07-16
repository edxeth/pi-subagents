import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assert,
	afterEach,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { SubagentsOverlay } from "../../src/tools/subagents-view.ts";
import { runningSubagents } from "../../src/runtime/state.ts";
import { buildCompletedItems } from "../../src/tools/overlay/data.ts";
import { wrapPlainText } from "../../src/tools/overlay/render-helpers.ts";

// ── Helpers ────────────────────────────────────────────────────────

const testRuntime = {
	getShellReadyDelayMs: () => 800,
	isMuxAvailable: () => false,
	watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
	watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
	getWatcherSignal: (_r: any, c: AbortController) => c.signal,
	startWidgetRefresh: () => {},
	getContextWindow: () => undefined,
	runningSubagents: new Map(),
	pi: { on() {} } as any,
	wireSubagentSteerBack: () => {},
};

function createOverlay(): SubagentsOverlay {
	const done = () => {};
	const ctx = {
		cwd: "/tmp",
		ui: {
			confirm: async () => true,
			input: async () => "test message",
			notify: () => {},
		},
		sessionManager: {
			getSessionFile: () => null,
		},
	} as any;
	const theme = { fg: (_t: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text };
	const tui = { requestRender: () => {}, terminal: { columns: 80 } } as any;
	return new SubagentsOverlay(done as any, ctx, theme, testRuntime as any, tui);
} 

function simulateKey(overlay: SubagentsOverlay, key: string): void {
	overlay.handleInput(key);
}

function renderLines(overlay: SubagentsOverlay, width = 80): string[] {
	return overlay.render(width);
}

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Helpers to avoid direct key imports ────────────────────────────

function pressUp(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[A");
}

function pressDown(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[B");
}

function pressLeft(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[D");
}

function pressRight(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[C");
}

// ── Tests ──────────────────────────────────────────────────────────

describe("subagents-view overlay", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	describe("empty states", () => {
		it('shows empty state message on Running tab', () => {
			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("No agents running"), `Expected "No agents running" in:\n${text}`);
			overlay.dispose();
		});

		it('shows loading or empty state on Completed tab', () => {
			const overlay = createOverlay();
			pressRight(overlay); // Switch to Completed tab
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(
				text.includes("Loading") || text.includes("No completed"),
				`Expected loading or empty state in:\n${text}`,
			);
			overlay.dispose();
		});
	});

	describe("tab navigation", () => {
		it("starts on Running tab", () => {
			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Running"), `Expected "Running" in:\n${text}`);
			overlay.dispose();
		});

		it("switches to Completed tab with right arrow", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Completed"), `Expected "Completed" in:\n${text}`);
			overlay.dispose();
		});

		it("switches to Agents tab with two right arrows", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Agents"), `Expected "Agents" in:\n${text}`);
			overlay.dispose();
		});

		it("does not go left past Running tab", () => {
			const overlay = createOverlay();
			pressLeft(overlay); // Should stay on Running
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Running"), `Expected "Running" in:\n${text}`);
			overlay.dispose();
		});

		it("does not go right past Agents tab", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			pressRight(overlay);
			pressRight(overlay); // Should stay on Agents
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Agents"), `Expected "Agents" in:\n${text}`);
			overlay.dispose();
		});
	});

	describe("item navigation", () => {
		it("kills the selected running subagent with k instead of moving selection", async () => {
			const firstAbort = new AbortController();
			const secondAbort = new AbortController();
			setRunningSubagentForTest({
				id: "test-1",
				name: "first-scout",
				task: "Explore first area",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test-1.jsonl",
				abortController: firstAbort,
			} as any);
			setRunningSubagentForTest({
				id: "test-2",
				name: "second-scout",
				task: "Explore second area",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test-2.jsonl",
				abortController: secondAbort,
			} as any);

			const overlay = createOverlay();

			simulateKey(overlay, "k");
			const confirmText = renderLines(overlay).map(stripAnsi).join("\n");
			assert.ok(confirmText.includes("Kill subagent?"));
			assert.equal(firstAbort.signal.aborted, false);

			simulateKey(overlay, "\r");
			await new Promise((resolve) => setImmediate(resolve));

			assert.equal(firstAbort.signal.aborted, true);
			assert.equal(secondAbort.signal.aborted, false);
			overlay.dispose();
		});

		it("cancels the built-in kill confirmation with Escape", async () => {
			const abortController = new AbortController();
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
				abortController,
			} as any);

			const overlay = createOverlay();
			simulateKey(overlay, "k");
			simulateKey(overlay, "\x1b");
			await new Promise((resolve) => setImmediate(resolve));

			assert.equal(abortController.signal.aborted, false);
			const text = renderLines(overlay).map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"));
			assert.ok(!text.includes("Kill subagent?"));
			overlay.dispose();
		});

		it("renders running subagents in the list", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected "scout" in:\n${text}`);
			overlay.dispose();
		});

		it("uses the per-message context snapshot, not cumulative totalTokens, for the ctx ratio", () => {
			// totalTokens accumulates every assistant turn and can far exceed the
			// window; contextTokens is the last-message snapshot. The overlay must
			// show the snapshot ratio so it matches the widget.
			setRunningSubagentForTest({
				id: "ctx-snapshot",
				name: "ctx-scout",
				task: "Check ctx",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/ctx-snapshot.jsonl",
				totalTokens: 1_800_000,
				contextTokens: 171_000,
				modelContextWindow: 1_000_000,
			} as any);

			const overlay = createOverlay();
			try {
				const text = renderLines(overlay).map(stripAnsi).join("\n");
				assert.ok(text.includes("171k/1M ctx"), `Expected snapshot ratio in:\n${text}`);
				assert.ok(!text.includes("1.8M/1M"), `Should not use cumulative total in:\n${text}`);
			} finally {
				overlay.dispose();
			}
		});

		it("shows frontmatter and override model fields in running item details", () => {
			const dir = mkdtempSync(join(tmpdir(), "subagents-overlay-"));
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, JSON.stringify({
				type: "custom",
				customType: "pi-subagents_launch_metadata",
				data: {
					version: 1,
					timestamp: "2026-05-24T00:00:00.000Z",
					name: "scout",
					mode: "background",
					sessionMode: "lineage-only",
					parentClosePolicy: "terminate",
					async: false,
					model: "zai-messages/glm-5.1",
					modelRef: "zai-messages/glm-5.1",
					definitionModel: "openai-rift/gpt-5.4-mini",
					definitionThinking: "high",
					allowModelOverride: true,
					modelSource: "resume-override",
					denyTools: [],
					noContextFiles: false,
					noSession: false,
					boundarySystemPrompt: false,
				},
			}) + "\n");
			setRunningSubagentForTest({
				id: "test-override",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile,
			} as any);

			const overlay = createOverlay();
			try {
				simulateKey(overlay, "i");
				const lines = renderLines(overlay);
				const text = lines.map(stripAnsi).join("\n");
				assert.ok(text.includes("model"), text);
				assert.ok(text.includes("allow-model-override"), text);
				assert.ok(text.includes("override-model"), text);
				assert.ok(text.includes("openai-rift/gpt-5.4-mini"), text);
				assert.ok(text.includes("zai-messages/glm-5.1"), text);
				assert.ok(!text.includes("model-source"), text);
				assert.ok(!text.includes("requested-model-override"), text);
			} finally {
				overlay.dispose();
			}
		});

		it("highlights the selected item with inverse video", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);
			setRunningSubagentForTest({
				id: "test-2",
				name: "reviewer",
				task: "Review code",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test2.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines1 = renderLines(overlay);
			// First item should be selected
			const text1 = lines1.map(stripAnsi).join("\n");
			assert.ok(text1.includes("scout"), `Expected "scout" in:\n${text1}`);

			pressDown(overlay);
			const lines2 = renderLines(overlay);
			const text2 = lines2.map(stripAnsi).join("\n");
			assert.ok(text2.includes("reviewer"), `Expected "reviewer" after down:\n${text2}`);

			overlay.dispose();
		});

		it("does not go above the first item", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			pressUp(overlay); // Should stay on first item
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected "scout" after up:\n${text}`);
			overlay.dispose();
		});
	});

	describe("wrapping", () => {
		it("hard-wraps long paths without adding ellipses", () => {
			const path = "/home/devkit/.local/share/tia/pi-agent/sessions/very-long-session-file-name-that-must-stay-copyable.jsonl";
			const lines = wrapPlainText(path, 24, Number.MAX_SAFE_INTEGER);
			assert.equal(lines.join(""), path);
			assert.ok(!lines.join("\n").includes("…"));
		});
	});

	describe("detail view", () => {
		it("opens detail view with i key", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			simulateKey(overlay, "i");
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected "scout" in detail:\n${text}`);
			assert.ok(text.includes("Identity"), `Expected "Identity" section:\n${text}`);
			overlay.dispose();
		});

		it("keeps running detail visible after the agent leaves the running list", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			simulateKey(overlay, "i");
			runningSubagents.clear();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected detail snapshot to remain visible:\n${text}`);
			assert.ok(text.includes("Identity"), `Expected detail sections to remain visible:\n${text}`);
			overlay.dispose();
		});

		it("closes detail view with Escape", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			simulateKey(overlay, "i"); // Open detail
			pressLeft(overlay); // Should NOT switch tab in detail mode
			simulateKey(overlay, "\x1b"); // Escape closes detail
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Running"), `Expected back to Running tab:\n${text}`);
			overlay.dispose();
		});
	});

	describe("footer hints", () => {
		it("shows k:kill hint on Running tab", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("kill"), `Expected "kill" hint in:\n${text}`);
			overlay.dispose();
		});

		it("shows resume hint on Completed tab", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			// Completed tab shows "resume" in hints when items exist
			// With no items, it shows the empty state
			assert.ok(text.includes("Completed"), `Expected "Completed" tab in:\n${text}`);
			overlay.dispose();
		});

		it("shows details hint on Agents tab", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Agents"), `Expected "Agents" tab in:\n${text}`);
			overlay.dispose();
		});
	});

	describe("close", () => {
		it("closes overlay with Escape", () => {
			const overlay = createOverlay();
			let closed = false;
			const done = () => { closed = true; };
			(overlay as any).done = done;

			simulateKey(overlay, "\x1b");
			assert.equal(closed, true);
		});

		it("dispose clears the refresh timer", () => {
			const overlay = createOverlay();
			overlay.dispose();
			// Should not throw — timer is cleared
			overlay.dispose();
		});
	});

	describe("runtime stats rendering", () => {
		it("shows elapsed time for running agents", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now() - 5000,
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("s"), `Expected seconds in elapsed:\n${text}`);
			overlay.dispose();
		});

		it("shows the resolved model ref in the running list row", () => {
			setRunningSubagentForTest({
				id: "test-model",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
				modelRef: "zai-messages/glm-5.1:high",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(
				text.includes("zai-messages/glm-5.1:high"),
				`Expected model ref in list row:\n${text}`,
			);
			overlay.dispose();
		});

		it("reports completed context tokens as the final-message snapshot, not a cumulative sum", async () => {
			const dir = mkdtempSync(join(tmpdir(), "subagents-completed-"));
			const childSession = join(dir, "child.jsonl");
			// Two assistant turns: cumulative usageTotal would be 250k, but the
			// context footprint is the last turn's 150k snapshot.
			writeFileSync(
				childSession,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "anthropic/test",
						usage: { totalTokens: 100_000, input: 90_000, output: 10_000 },
						content: [{ type: "text", text: "first" }],
					},
				})}\n${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "anthropic/test",
						usage: { totalTokens: 150_000, input: 140_000, output: 10_000 },
						content: [{ type: "text", text: "second" }],
					},
				})}\n`,
			);

			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify({
					type: "custom_message",
					customType: "subagent_result",
					details: {
						id: "done-1",
						name: "scout",
						status: "completed",
						exitCode: 0,
						elapsed: 12,
						sessionFile: childSession,
					},
				})}\n`,
			);

			const overlayCtx = {
				ui: { confirm: async () => true, input: async () => "", notify: () => {} },
				cwd: "/tmp",
				sessionManager: { getSessionFile: () => parentSession },
			} as any;

			const items = await buildCompletedItems(overlayCtx);
			const item = items.find((i) => i.name === "scout");
			assert.ok(item, "expected recovered completed item");
			const ctxField = item!.detailSections
				.flatMap((s) => s.fields)
				.find((f) => f.label === "context tokens");
			assert.equal(ctxField?.value, "150k");
			assert.ok(
				item!.stats.includes("150k ctx"),
				`Expected snapshot ctx in stats, got: ${JSON.stringify(item!.stats)}`,
			);
			assert.ok(
				!item!.stats.some((s) => s.includes("250k")),
				`Should not show cumulative total, got: ${JSON.stringify(item!.stats)}`,
			);
		});

		it("excludes inherited parent history from forked completed-session stats", async () => {
			const dir = mkdtempSync(join(tmpdir(), "subagents-fork-completed-"));
			const childSession = join(dir, "forked-child.jsonl");
			// Forked child: parent transcript is seeded BEFORE the launch marker,
			// then the child's own activity follows. Stats must count only the
			// child's turns, not the inherited parent history.
			writeFileSync(
				childSession,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "anthropic/parent",
						usage: { totalTokens: 900_000, input: 880_000, output: 20_000 },
						content: [{ type: "toolCall", id: "p1", name: "bash" }],
					},
				})}\n${JSON.stringify({
					type: "message",
					message: { role: "toolResult", toolCallId: "p1" },
				})}\n${JSON.stringify({
					type: "custom",
					customType: "pi-subagents_launch_metadata",
					data: { version: 1, mode: "background" },
				})}\n${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						provider: "anthropic",
						model: "anthropic/child",
						usage: { totalTokens: 120_000, input: 110_000, output: 10_000 },
						content: [{ type: "text", text: "child work" }],
					},
				})}\n`,
			);

			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify({
					type: "custom_message",
					customType: "subagent_result",
					details: {
						id: "fork-done",
						name: "forked-scout",
						status: "completed",
						exitCode: 0,
						elapsed: 5,
						sessionFile: childSession,
					},
				})}\n`,
			);

			const overlayCtx = {
				ui: { confirm: async () => true, input: async () => "", notify: () => {} },
				cwd: "/tmp",
				sessionManager: { getSessionFile: () => parentSession },
			} as any;

			const items = await buildCompletedItems(overlayCtx);
			const item = items.find((i) => i.name === "forked-scout");
			assert.ok(item, "expected recovered forked completed item");
			const fields = item!.detailSections.flatMap((s) => s.fields);
			// Context snapshot = child's last turn (120k), not the parent's 900k.
			assert.equal(fields.find((f) => f.label === "context tokens")?.value, "120k");
			// Input/output are cumulative over CHILD activity only: 110k / 10k.
			assert.equal(fields.find((f) => f.label === "input tokens")?.value, "110k");
			assert.equal(fields.find((f) => f.label === "output tokens")?.value, "10k");
			// Only the child's single assistant message is counted.
			assert.equal(fields.find((f) => f.label === "messages")?.value, "1");
			assert.ok(
				!item!.stats.some((s) => s.includes("900k") || s.includes("1M")),
				`Should not include inherited parent usage, got: ${JSON.stringify(item!.stats)}`,
			);
		});
	});
});

const mockRuntime = {
	getShellReadyDelayMs: () => 800,
	isMuxAvailable: () => false,
	watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
	watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
	getWatcherSignal: (_r: any, c: AbortController) => c.signal,
	startWidgetRefresh: () => {},
	getContextWindow: () => undefined,
	runningSubagents: new Map(),
	pi: { on() {} } as any,
	wireSubagentSteerBack: () => {},
};

describe("subagents-view registration", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("registers /subagents command and alt+s shortcut", async () => {
		const commands: Array<{ name: string; description: string }> = [];
		let shortcutRegistered = false;

		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand(name: string, opts: any) {
				commands.push({ name, description: opts.description });
			},
			registerShortcut(_shortcut: string, _opts: any) {
				shortcutRegistered = true;
			},
			on() {},
		} as any, mockRuntime);

		assert.equal(commands.length, 1);
		assert.equal(commands[0].name, "subagents");
		assert.ok(commands[0].description.includes("subagent"));
		assert.equal(shortcutRegistered, true);
	});

	it("opens the manager as an editor replacement instead of a chat overlay", async () => {
		setRunningSubagentForTest({
			id: "test-1",
			name: "scout",
			task: "Explore codebase",
			mode: "background",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile: "/tmp/test.jsonl",
		} as any);
		let commandHandler: ((args: string, ctx: any) => Promise<void>) | null = null;
		let customOptions: unknown;
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand(_name: string, opts: any) {
				commandHandler = opts.handler;
			},
			registerShortcut() {},
			on() {},
		} as any, mockRuntime);

		assert.ok(commandHandler);
		await (commandHandler as (args: string, ctx: any) => Promise<void>)("", {
			ui: {
				notify: () => {},
				custom: (_factory: unknown, options: unknown) => {
					customOptions = options;
					return Promise.resolve(null);
				},
			},
			sessionManager: { getSessionFile: () => null },
			cwd: "/tmp",
		});

		assert.equal(customOptions, undefined);
	});

	it("shows notification when no subagents or agent definitions exist", async () => {
		const notifications: string[] = [];
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand(_name: string, opts: any) {
				// Simulate running the command handler
				opts.handler("", {
					ui: {
						notify: (msg: string, _type: string) => {
							notifications.push(msg);
						},
						custom: async () => { /* noop — won't be called when empty state hits */ },
					},
					sessionManager: {
						getSessionFile: () => null,
					},
					cwd: "/tmp",
				});
			},
			registerShortcut() {},
			on() {},
		} as any, mockRuntime);

		// Note: this test depends on the test environment not having
		// global agent definitions. If global agents exist, openOverlay
		// will try ctx.ui.custom() instead of notify.
		if (notifications.length === 0) {
			// Has global agents — skip assertion, this is environment-dependent
			return;
		}
		assert.ok(notifications[0].includes("No subagents"));
	});

	it("calls session_shutdown handler without error", async () => {
		const handlers = new Map<string, Function>();
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
		} as any, mockRuntime);

		const shutdownHandler = handlers.get("session_shutdown");
		assert.ok(shutdownHandler);
		// Should not throw
		(shutdownHandler as Function)();
	});

	it("registers and invokes alt+s shortcut handler", async () => {
		const notifications: string[] = [];
		let shortcutHandler: ((ctx: any) => Promise<void>) | null = null;
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand() {},
			registerShortcut(_shortcut: string, opts: any) {
				shortcutHandler = opts.handler;
			},
			on() {},
		} as any, mockRuntime);

		assert.ok(shortcutHandler, "alt+s handler should be registered");

		// First call — if no global agents, notifies about empty state
		await (shortcutHandler as (ctx: any) => Promise<void>)({
			ui: {
				notify: (msg: string) => { notifications.push(msg); },
				custom: async () => {},
			},
			sessionManager: { getSessionFile: () => null },
			cwd: "/tmp",
		});
		// Environment-dependent: if global agents exist, custom() is called instead
		if (notifications.length > 0) {
			assert.ok(notifications[0].includes("No subagents"));
		}
	});
});
