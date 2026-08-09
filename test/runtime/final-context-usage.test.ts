import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveFinalContextUsage } from "../../src/runtime/final-context-usage.ts";
import { SUBAGENT_COMPLETION_ENTRY } from "../../src/tools/context-reminders.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, createTestDir } from "../support/index.ts";

function writeChildSession(dir: string, entries: object[]): string {
	const file = join(dir, "child.jsonl");
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

function makeRunning(sessionFile: string): RunningSubagent {
	return {
		id: "child-final-usage",
		name: "Child",
		task: "Do the work",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		launchEntryCount: 0,
		modelContextWindow: 200_000,
	};
}

describe("final context usage", () => {
	it("reports that the child was warned before it finished", () => {
		const dir = createTestDir();
		try {
			const sessionFile = writeChildSession(dir, [
				{
					type: "custom",
					customType: SUBAGENT_COMPLETION_ENTRY,
					data: { reason: "context-pressure" },
				},
			]);
			const usage = resolveFinalContextUsage(makeRunning(sessionFile), {
				contextTokens: 182_000,
				contextWindow: 200_000,
			} as never);
			assert.equal(usage.contextWarned, true);
			assert.equal(usage.contextTokens, 182_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets a later clean completion release an earlier context-pressure exit", () => {
		const dir = createTestDir();
		try {
			const sessionFile = writeChildSession(dir, [
				{
					type: "custom",
					customType: SUBAGENT_COMPLETION_ENTRY,
					data: { reason: "context-pressure" },
				},
				{
					type: "custom",
					customType: SUBAGENT_COMPLETION_ENTRY,
					data: { reason: "normal" },
				},
			]);
			const usage = resolveFinalContextUsage(makeRunning(sessionFile), {
				contextTokens: 60_000,
				contextWindow: 200_000,
			} as never);
			assert.equal(usage.contextWarned, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not mark a child that only saw an early warning and finished", () => {
		const dir = createTestDir();
		try {
			// Reminder entries alone are not evidence of a context-driven exit.
			const sessionFile = writeChildSession(dir, [
				{
					type: "custom",
					customType: "pi-subagent-context-reminders",
					data: { sentThresholds: [80, 85, 90] },
				},
			]);
			const usage = resolveFinalContextUsage(makeRunning(sessionFile), {
				contextTokens: 182_000,
				contextWindow: 200_000,
			} as never);
			assert.equal(usage.contextWarned, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports no warning for a child that never crossed a threshold", () => {
		const dir = createTestDir();
		try {
			const sessionFile = writeChildSession(dir, [{ type: "message", message: { role: "user" } }]);
			const usage = resolveFinalContextUsage(makeRunning(sessionFile), {
				contextTokens: 40_000,
				contextWindow: 200_000,
			} as never);
			assert.equal(usage.contextWarned, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("trusts the exit sidecar when the child persisted nothing", () => {
		const dir = createTestDir();
		try {
			// Real no-session children run with --no-session, so nothing is ever
			// persisted; the exit sidecar is the only channel that survives.
			const sessionFile = writeChildSession(dir, [{ type: "message", message: { role: "user" } }]);
			const usage = resolveFinalContextUsage({ ...makeRunning(sessionFile), noSession: true }, {
				contextTokens: 3_000,
				contextWindow: 200_000,
				completionReason: "context-pressure",
			} as never);
			assert.equal(usage.contextWarned, true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("survives a truncated session file without claiming a warning", () => {
		const dir = createTestDir();
		try {
			const sessionFile = join(dir, "truncated.jsonl");
			writeFileSync(sessionFile, `{"type":"custom","customType":"pi-subagent-context-remin`);
			const usage = resolveFinalContextUsage(makeRunning(sessionFile), {
				contextTokens: 40_000,
				contextWindow: 200_000,
			} as never);
			assert.equal(usage.contextWarned, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports no warning when the session file is already gone", () => {
		const dir = createTestDir();
		try {
			const usage = resolveFinalContextUsage(makeRunning(join(dir, "missing.jsonl")), {
				contextTokens: 40_000,
				contextWindow: 200_000,
			} as never);
			assert.equal(usage.contextWarned, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

});
