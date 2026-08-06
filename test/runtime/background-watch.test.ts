import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";

const dirs: string[] = [];

function makeRunning(sessionFile: string, childProcess: ChildProcess): RunningSubagent {
	return {
		id: "background-context",
		name: "Background context",
		task: "Report context",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		modelContextWindow: 200_000,
		modelRef: "zai/glm-5v-turbo:off",
		childProcess,
	};
}

function makeSession(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return createSessionFile(dir, [
		{
			type: "message",
			id: "assistant-final",
			message: {
				role: "assistant",
				provider: "zai",
				model: "glm-5v-turbo",
				content: [{ type: "text", text: "Finished the delegated work." }],
				usage: { totalTokens: 145_000 },
			},
		},
	]);
}

describe("background watcher final context usage", () => {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("uses the exact context snapshot from the exit sidecar", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, {
			type: "done",
			contextTokens: 146_000,
			contextWindow: 210_000,
		});
		const resultPromise = watchBackgroundSubagent(
			makeRunning(sessionFile, child),
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, 146_000);
		assert.equal(result.contextWindow, 210_000);
	});

	it("falls back to the child session when the sidecar has no context snapshot", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const resultPromise = watchBackgroundSubagent(
			makeRunning(sessionFile, child),
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, 145_000);
		assert.equal(result.contextWindow, 200_000);
	});

	it("does not reuse assistant usage from before the current launch", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const running = makeRunning(sessionFile, child);
		running.launchEntryCount = 1;
		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, undefined);
		assert.equal(result.contextWindow, undefined);
	});

	it("omits fallback usage after a model switch", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const running = makeRunning(sessionFile, child);
		running.modelRef = "openai/gpt-5.6:off";
		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);

		child.emit("exit", 0);
		const result = await resultPromise;

		assert.equal(result.contextTokens, undefined);
		assert.equal(result.contextWindow, undefined);
	});
});
