import { appendFileSync } from "node:fs";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import { stopRunningSubagent } from "../../src/runtime/running-registry.ts";
import { writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { readSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	beforeEach,
	createSessionFile,
	createTestDir,
	describe,
	it,
	rmSync,
	sleep,
} from "../support/index.ts";

const dirs: string[] = [];
let savedMux: string | undefined;

function settleWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`watcher did not settle within ${ms}ms: ${label}`)), ms);
			timer.unref?.();
		}),
	]);
}

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

	it("closes a blocked pane at the warning threshold and continues the same session for wrap-up", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile, {
			startTime: Date.now(),
			timeoutBudget: { timeoutSeconds: 2 },
			timeoutWarnThreshold: 50,
		});
		let generation = 0;
		let restarts = 0;
		let releaseFirstPoll: (() => void) | undefined;
		let firstSurfaceClosed = false;

		const result = await watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {
					firstSurfaceClosed = true;
					releaseFirstPoll?.();
				},
				async restartForTimeoutWrapUp(current: RunningSubagent) {
					restarts += 1;
					current.surface = "wrap-up-surface";
					const entries = [
						{
							type: "message",
							id: "wrap-up-final",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "Pane wrap-up report." }],
							},
						},
					];
					for (const entry of entries) appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
				},
				async pollForExit(
					_surface: string,
					_signal: AbortSignal,
					options: { onTick?: () => void },
				) {
					generation += 1;
					if (generation === 1) {
						await sleep(1050);
						if (!firstSurfaceClosed) {
							const closed = new Promise<void>((resolve) => {
								releaseFirstPoll = resolve;
							});
							options.onTick?.();
							await closed;
						}
						return { reason: "sentinel", exitCode: 0 };
					}
					return { reason: "done", exitCode: 0 };
				},
			} as never,
			new AbortController().signal,
		);

		assert.equal(restarts, 1);
		assert.deepEqual(result.timeoutWrapUp, { kind: "timeout", seconds: 2, threshold: 50 });
		assert.equal(result.timedOut, undefined);
		assert.match(result.summary, /Pane wrap-up report/);
		assert.ok(result.elapsed < 2, "the pane continuation must keep the original deadline");
	});

	it("honors a short pane soft deadline before the hard timeout", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile, {
			startTime: Date.now(),
			timeoutBudget: { timeoutSeconds: 1 },
			timeoutWarnThreshold: 50,
		});
		let generation = 0;
		let releaseFirstPoll: (() => void) | undefined;
		let firstSurfaceClosed = false;

		const result = await settleWithin(
			watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface() {
						firstSurfaceClosed = true;
						releaseFirstPoll?.();
					},
					async restartForTimeoutWrapUp(current: RunningSubagent) {
						current.surface = "short-wrap-up-surface";
						appendFileSync(
							sessionFile,
							`${JSON.stringify({
								type: "message",
								id: "short-pane-report",
								message: { role: "assistant", content: [{ type: "text", text: "Short pane report." }] },
							})}\n`,
						);
					},
					async pollForExit() {
						generation += 1;
						if (generation === 1) {
							if (!firstSurfaceClosed) {
								await new Promise<void>((resolve) => {
									releaseFirstPoll = resolve;
								});
							}
							return { reason: "sentinel", exitCode: 0 };
						}
						return { reason: "done", exitCode: 0 };
					},
				} as never,
				new AbortController().signal,
			),
			2500,
			"short interactive timeout wrap-up",
		);

		assert.equal(result.timedOut, undefined);
		assert.deepEqual(result.timeoutWrapUp, { kind: "timeout", seconds: 1, threshold: 50 });
	});

	it("does not let an old close retry target the replacement pane", async () => {
		const sessionFile = makeSession();
		const running = makeRunning(sessionFile, {
			startTime: Date.now(),
			timeoutBudget: { timeoutSeconds: 2 },
			timeoutWarnThreshold: 50,
			surface: "original-surface",
		});
		let generation = 0;
		let originalCloseCalls = 0;
		let releaseFirstPoll: (() => void) | undefined;
		let replacementFinished = false;
		let replacementClosedEarly = false;

		const result = await settleWithin(
			watchSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					async closeRunningSurface(current: RunningSubagent) {
						if (current.surface === "original-surface") {
							originalCloseCalls += 1;
							releaseFirstPoll?.();
							if (originalCloseCalls === 1) {
								throw new Error("transient close failure");
							}
							return;
						}
						if (current.surface === "replacement-surface" && !replacementFinished) {
							replacementClosedEarly = true;
						}
					},
					async restartForTimeoutWrapUp(current: RunningSubagent) {
						current.surface = "replacement-surface";
						appendFileSync(
							sessionFile,
							`${JSON.stringify({
								type: "message",
								id: "replacement-report",
								message: { role: "assistant", content: [{ type: "text", text: "Replacement report." }] },
							})}\n`,
						);
					},
					async pollForExit(_surface: string, _signal: AbortSignal, options: { onTick?: () => void }) {
						generation += 1;
						if (generation === 1) {
							await sleep(1050);
							const closed = new Promise<void>((resolve) => {
								releaseFirstPoll = resolve;
							});
							options.onTick?.();
							await closed;
							return { reason: "sentinel", exitCode: 0 };
						}
						await sleep(400);
						replacementFinished = true;
						return { reason: "done", exitCode: 0 };
					},
				} as never,
				new AbortController().signal,
			),
			4000,
			"replacement close retry",
		);

		assert.equal(result.timedOut, undefined);
		assert.equal(replacementClosedEarly, false, "an old retry must stay bound to the original pane");
	});

	it("cancels an interactive replacement created after manual stop during restart", async () => {
		const sessionFile = makeSession();
		const controller = new AbortController();
		const running = makeRunning(sessionFile, {
			startTime: Date.now(),
			timeoutBudget: { timeoutSeconds: 4 },
			timeoutWarnThreshold: 25,
			surface: "original-surface",
			abortController: controller,
		});
		let generation = 0;
		let releaseFirstPoll: (() => void) | undefined;
		let restartEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			restartEntered = resolve;
		});
		let replacementClosed = false;
		let originalClosed = false;
		const closeSurface = async (current: RunningSubagent) => {
			if (current.surface === "original-surface") {
				originalClosed = true;
				releaseFirstPoll?.();
			}
			if (current.surface === "replacement-surface") replacementClosed = true;
		};

		const resultPromise = watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				closeRunningSurface: closeSurface,
				async restartForTimeoutWrapUp(current: RunningSubagent) {
					restartEntered();
					await sleep(100);
					current.surface = "replacement-surface";
					appendFileSync(
						sessionFile,
						`${JSON.stringify({
							type: "message",
							id: "cancelled-pane-report",
							message: { role: "assistant", content: [{ type: "text", text: "Must not complete." }] },
						})}\n`,
					);
				},
				async pollForExit(_surface: string, _signal: AbortSignal, options: { onTick?: () => void }) {
					generation += 1;
					if (generation === 1) {
						await sleep(1050);
						if (!originalClosed) {
							const closed = new Promise<void>((resolve) => {
								releaseFirstPoll = resolve;
							});
							options.onTick?.();
							await closed;
						}
						return { reason: "sentinel", exitCode: 0 };
					}
					return { reason: "done", exitCode: 0 };
				},
			} as never,
			controller.signal,
		);

		await settleWithin(entered, 2500, "interactive restart entry");
		await stopRunningSubagent(running, closeSurface);
		const result = await settleWithin(resultPromise, 3000, "interactive manual stop during restart");

		assert.equal(result.error, "cancelled");
		assert.equal(replacementClosed, true, "a pane created after abort must be closed");
	});
});
