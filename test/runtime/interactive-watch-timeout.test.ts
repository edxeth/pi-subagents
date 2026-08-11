import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { readSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { afterEach, assert, beforeEach, createSessionFile, createTestDir, describe, it, rmSync } from "../support/index.ts";

const dirs: string[] = [];
let savedMux: string | undefined;

function makeSession(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return createSessionFile(dir, [
		{ type: "session", id: "sess", version: 3 },
		{
			type: "message",
			id: "a1",
			message: { role: "assistant", content: [{ type: "text", text: "Halfway through the sweep." }] },
		},
	]);
}

function makeRunning(sessionFile: string, overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "pane-child",
		name: "pane-child",
		task: "Sweep the repo",
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		surface: "pi-subagents-nonexistent-surface",
		...overrides,
	};
}

/**
 * What the parent is told once a pane child's budget is spent.
 *
 * Scope, stated plainly: a mux surface cannot be faked here, so every case
 * below drives the failed-poll path with an expiry already recorded. That is
 * the outcome-shaping half of the interactive timeout. The other half — the
 * poll tick that notices the expiry, closes the pane, and the try-branch that
 * shapes a result from a real PollResult — is covered by the live pane repro,
 * not by this file. Do not read a green run here as proof the pane dies.
 */
describe("interactive watcher timeout outcome", () => {
	beforeEach(() => {
		savedMux = process.env.PI_SUBAGENT_MUX;
		// Pin the backend away from zellij so the file-polling branch is not taken
		// on a machine that happens to have zellij installed.
		process.env.PI_SUBAGENT_MUX = "tmux";
	});

	afterEach(() => {
		if (savedMux == null) delete process.env.PI_SUBAGENT_MUX;
		else process.env.PI_SUBAGENT_MUX = savedMux;
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("reports the spent budget rather than a surface error", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile, {
			timeoutBudget: { timeoutSeconds: 1 },
			timeoutExpiry: { kind: "timeout", seconds: 1 },
		});
		let closed = 0;

		const result = await watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {
					closed += 1;
				},
			},
			new AbortController().signal,
		);

		assert.equal(result.timedOut, "timeout");
		assert.equal(result.timedOutAfter, 1);
		assert.ok(closed > 0, "the pane must be closed");
		assert.doesNotMatch(result.summary, /Failed to read subagent surface/);
		assert.match(result.summary, /Halfway through the sweep\./);
		assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
			kind: "timeout",
			blocksResume: false,
			budget: { timeoutSeconds: 1 },
		});
	});

	it("reports the spent idle budget and the agent's resume block", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile, {
			timeoutBudget: { idleTimeoutSeconds: 5 },
			timeoutExpiry: { kind: "idle-timeout", seconds: 5 },
			timeoutBlocksResume: true,
		});

		const result = await watchSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, async closeRunningSurface() {} },
			new AbortController().signal,
		);

		assert.equal(result.timedOut, "idle-timeout");
		assert.equal(result.timeoutBlocksResume, true);
		assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
			kind: "idle-timeout",
			blocksResume: true,
			budget: { idleTimeoutSeconds: 5 },
		});
	});

	it("reports the kill even though the closing pane publishes a done sidecar", async () => {
		const sessionFile = makeSession();
		// Closing the surface makes the child's Pi process shut down and record an
		// ordinary completion. That must not erase the timeout.
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const running = makeRunning(sessionFile, {
			timeoutBudget: { timeoutSeconds: 1 },
			timeoutExpiry: { kind: "timeout", seconds: 1 },
		});

		const result = await watchSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, async closeRunningSurface() {} },
			new AbortController().signal,
		);

		assert.equal(result.timedOut, "timeout");
		assert.notEqual(result.exitCode, 0);
		assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
			kind: "timeout",
			blocksResume: false,
			budget: { timeoutSeconds: 1 },
		});
	});

	it("lets a pane child that asked for help keep its ping", async () => {
		const sessionFile = makeSession();
		writeSubagentExitSidecar(sessionFile, { type: "ping", name: "pane-child", message: "stuck" });
		const running = makeRunning(sessionFile, {
			timeoutBudget: { timeoutSeconds: 1 },
			timeoutExpiry: { kind: "timeout", seconds: 1 },
		});

		const result = await watchSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, async closeRunningSurface() {} },
			new AbortController().signal,
		);

		assert.equal(result.timedOut, undefined);
		assert.equal(result.ping?.message, "stuck");
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
	});

	it("still reports a plain surface failure as an error when no budget was spent", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile);

		const result = await watchSubagent(
			running,
			{ cleanupNoSessionSessionFile() {}, async closeRunningSurface() {} },
			new AbortController().signal,
		);

		assert.equal(result.timedOut, undefined);
		assert.match(result.summary, /Subagent error/);
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
	});
});
