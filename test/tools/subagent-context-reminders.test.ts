import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	getContextReminderThresholds,
	installSubagentContextReminders,
	parseContextWarnStep,
	parseContextWarnThreshold,
	SUBAGENT_CONTEXT_REMINDER_ENTRY,
	selectContextReminder,
} from "../../src/tools/context-reminders.ts";
import { assert, createTestDir, sleep, subagentDoneExtension } from "../support/index.ts";

describe("subagent context reminders", () => {
	it("treats the configured percentage as the first of three reminders", () => {
		assert.deepEqual(getContextReminderThresholds(80, 5), [80, 85, 90]);
		assert.deepEqual(getContextReminderThresholds(80, 10), [80, 90, 99]);
		assert.deepEqual(getContextReminderThresholds(95, 10), [95, 99]);
		assert.equal(parseContextWarnThreshold("80%"), 80);
		assert.equal(parseContextWarnThreshold("80"), 80);
		assert.equal(parseContextWarnThreshold("91%"), 91);
		assert.equal(parseContextWarnThreshold("99%"), 99);
		assert.equal(parseContextWarnThreshold("80.9%"), 80);
		assert.equal(parseContextWarnThreshold("0.5%"), null);
		assert.equal(parseContextWarnThreshold("off"), null);
		assert.equal(parseContextWarnThreshold(undefined), null);
		assert.equal(parseContextWarnThreshold("100%"), null);
		assert.equal(parseContextWarnThreshold("bogus"), null);
		assert.equal(parseContextWarnStep("10%"), 10);
		assert.equal(parseContextWarnStep("5.9%"), 5);
		assert.equal(parseContextWarnStep("1.9%"), 1);
		assert.equal(parseContextWarnStep("0.5%"), 5);
		assert.equal(parseContextWarnStep(undefined), 5);
		assert.equal(parseContextWarnStep("bogus"), 5);
	});

	it("includes current and maximum tokens in each progressive reminder", () => {
		const first = selectContextReminder(80, 5, { tokens: 160_000, contextWindow: 200_000, percent: 80 }, new Set());
		assert.equal(first?.threshold, 80);
		assert.match(first?.message ?? "", /160K\/200K tokens \(80\.0%\)/);
		assert.match(first?.message ?? "", /Start wrapping up/);

		const second = selectContextReminder(
			80,
			5,
			{ tokens: 170_000, contextWindow: 200_000, percent: 85 },
			new Set(first?.sentThresholds),
		);
		assert.equal(second?.threshold, 85);
		assert.match(second?.message ?? "", /Wrap up now/);

		const third = selectContextReminder(
			80,
			5,
			{ tokens: 180_000, contextWindow: 200_000, percent: 90 },
			new Set(second?.sentThresholds),
		);
		assert.equal(third?.threshold, 90);
		assert.match(third?.message ?? "", /Finish immediately/);
		assert.equal(
			selectContextReminder(
				80,
				5,
				{ tokens: 190_000, contextWindow: 200_000, percent: 95 },
				new Set(third?.sentThresholds),
			),
			null,
		);
	});

	it("uses the most urgent warning when usage jumps across levels", () => {
		const reminder = selectContextReminder(80, 5, { tokens: 182_000, contextWindow: 200_000, percent: 91 }, new Set());
		assert.equal(reminder?.threshold, 90);
		assert.deepEqual(reminder?.sentThresholds, [80, 85, 90]);
		assert.match(reminder?.message ?? "", /Final context warning/);
	});

	it("queues one reminder from tool results while a long agent run is active", () => {
		const originalThreshold = process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD;
		process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD = "80%";
		try {
			const handlers = new Map<string, any[]>();
			const sent: string[] = [];
			installSubagentContextReminders({
				on(event: string, handler: any) {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				sendUserMessage(message: string) {
					sent.push(message);
				},
				appendEntry() {},
			} as any);
			const ctx = {
				getContextUsage: () => ({
					tokens: 160_000,
					contextWindow: 200_000,
					percent: 80,
				}),
			};

			for (const handler of handlers.get("tool_result") ?? []) {
				handler({}, ctx);
				handler({}, ctx);
			}

			assert.equal(sent.length, 1);
			assert.match(sent[0], /160K\/200K tokens \(80\.0%\)/);
		} finally {
			if (originalThreshold == null) delete process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD;
			else process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD = originalThreshold;
		}
	});

	it("steers the child, persists delivered reminders, and then auto-exits normally", async () => {
		const originalThreshold = process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD;
		const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, "");
		process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD = "80%";
		process.env.PI_SUBAGENT_AUTO_EXIT = "1";
		process.env.PI_SUBAGENT_SESSION = sessionFile;

		try {
			const handlers = new Map<string, any[]>();
			const emit = (event: string, ...args: unknown[]) => {
				for (const handler of handlers.get(event) ?? []) handler(...args);
			};
			const sent: Array<{ message: string; options: any }> = [];
			const entries: Array<Record<string, unknown>> = [];
			let shutdowns = 0;
			let hasPendingMessages = false;
			let usage = {
				tokens: 160_000,
				contextWindow: 200_000,
				percent: 80,
			};

			subagentDoneExtension({
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools() {},
				registerTool(definition: unknown) {
					return definition;
				},
				on(event: string, handler: any) {
					handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				},
				sendUserMessage(message: string, options: unknown) {
					hasPendingMessages = true;
					sent.push({ message, options });
				},
				appendEntry(customType: string, data: unknown) {
					entries.push({ type: "custom", customType, data });
				},
				registerShortcut() {},
			} as any);

			const ctx = {
				sessionManager: { getEntries: () => entries },
				getContextUsage: () => usage,
				hasPendingMessages: () => hasPendingMessages,
				ui: { setWidget() {}, setStatus() {} },
				shutdown() {
					shutdowns += 1;
				},
			};
			emit("session_start", {}, ctx);
			emit("agent_start", {}, ctx);
			emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);

			assert.equal(sent.length, 1);
			assert.match(sent[0].message, /160K\/200K tokens \(80\.0%\)/);
			assert.deepEqual(sent[0].options, {
				deliverAs: "steer",
			});
			assert.equal(entries.length, 0, "queueing alone must not mark delivery");
			const retryHandlers = new Map<string, any[]>();
			const retrySent: unknown[] = [];
			installSubagentContextReminders({
				on(event: string, handler: any) {
					retryHandlers.set(event, [...(retryHandlers.get(event) ?? []), handler]);
				},
				sendUserMessage(message: unknown) {
					retrySent.push(message);
				},
				appendEntry() {},
			} as any);
			for (const handler of retryHandlers.get("session_start") ?? []) {
				handler({}, ctx);
			}
			for (const handler of retryHandlers.get("agent_end") ?? []) {
				handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
			}
			assert.equal(retrySent.length, 1, "an undelivered queued reminder must be retried after resume");
			hasPendingMessages = false;
			emit("message_end", {
				message: {
					role: "user",
					content: [{ type: "text", text: sent[0].message }],
				},
			});
			assert.deepEqual(entries.at(-1), {
				type: "custom",
				customType: SUBAGENT_CONTEXT_REMINDER_ENTRY,
				data: { sentThresholds: [80] },
			});

			usage = { tokens: 170_000, contextWindow: 200_000, percent: 85 };
			emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
			assert.equal(sent.length, 2);
			assert.match(sent[1].message, /170K\/200K tokens \(85\.0%\)/);
			hasPendingMessages = false;
			emit("message_end", {
				message: {
					role: "user",
					content: [{ type: "text", text: sent[1].message }],
				},
			});

			const resumedHandlers = new Map<string, any[]>();
			const emitResumed = (event: string, ...args: unknown[]) => {
				for (const handler of resumedHandlers.get(event) ?? []) handler(...args);
			};
			const resumedSent: unknown[] = [];
			installSubagentContextReminders({
				on(event: string, handler: any) {
					resumedHandlers.set(event, [...(resumedHandlers.get(event) ?? []), handler]);
				},
				sendUserMessage(message: unknown) {
					resumedSent.push(message);
				},
				appendEntry() {},
			} as any);
			emitResumed("session_start", {}, ctx);
			emitResumed("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
			assert.equal(resumedSent.length, 0, "persisted levels must not repeat after resume or reload");

			emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
			await sleep(0);
			assert.equal(shutdowns, 1);
			assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done", outputTokens: 0 });
		} finally {
			if (originalThreshold == null) delete process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD;
			else process.env.PI_SUBAGENT_CONTEXT_WARN_THRESHOLD = originalThreshold;
			if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
			else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
