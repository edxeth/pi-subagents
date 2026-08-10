import { mock } from "node:test";
import {
	assert,
	clearPublishedRunningSubagentCountForTest,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	resetSubagentStateForTest,
	rmSync,
	publishRunningSubagentCountForTest,
	sleep,
	subagentDoneExtension,
	writeFileSync,
} from "../support/index.ts";

describe("subagent-done.ts", () => {
	describe("provider-error recovery wiring (integration)", () => {
		// These drive the REAL subagent-done extension with a realistic flaky-provider
		// message sequence. The original infinite-nudge bug lived in this wiring
		// (message_end resetting the failure chain), not in the isolated controller,
		// so controller-only tests could not catch it. These can.
		function loadRecoveryChild(options: { interactive?: boolean } = {}) {
			const handlers = new Map<string, any>();
			const commands = new Map<string, any>();
			const sentMessages: string[] = [];
			const sentMessageOptions: unknown[] = [];
			const statusUpdates: Array<{ key: string; text: string | undefined }> = [];
			let shutdowns = 0;
			let stale = false;
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			process.env.PI_SUBAGENT_SESSION = sessionFile;
			process.env.PI_SUBAGENT_AUTO_EXIT = "1";
			if (options.interactive ?? true) process.env.PI_SUBAGENT_SURFACE = "fake-pane";
			else delete process.env.PI_SUBAGENT_SURFACE;
			process.env.PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS = "10,20,30";

			subagentDoneExtension({
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools() {},
				registerTool(definition: { name: string }) {
					return definition;
				},
				registerCommand(name: string, definition: unknown) {
					commands.set(name, definition);
				},
				on(event: string, handler: any) {
					handlers.set(event, handler);
				},
				sendUserMessage(message: string, options?: unknown) {
					sentMessages.push(message);
					sentMessageOptions.push(options);
				},
				registerShortcut() {},
			} as any);

			const ctx = {
				isIdle: () => {
					if (stale) throw new Error("stale context");
					return true;
				},
				ui: {
					setStatus: (key: string, text: string | undefined) => {
						if (stale) throw new Error("stale context");
						statusUpdates.push({ key, text });
					},
					notify() {},
				},
				shutdown() {
					shutdowns += 1;
				},
			};
			return {
				handlers,
				sentMessages,
				sentMessageOptions,
				statusUpdates,
				commands,
				sessionFile,
				ctx,
				dir,
				get shutdowns() {
					return shutdowns;
				},
				makeContextStale() {
					stale = true;
				},
			};
		}

		function cleanup(dir: string) {
			clearPublishedRunningSubagentCountForTest();
			resetSubagentStateForTest();
			delete process.env.PI_SUBAGENT_SESSION;
			delete process.env.PI_SUBAGENT_AUTO_EXIT;
			delete process.env.PI_SUBAGENT_SURFACE;
			delete process.env.PI_SUBAGENT_PROVIDER_RECOVERY_DELAYS_MS;
			rmSync(dir, { recursive: true, force: true });
		}

		const contextOverflowMessage = "Your input exceeds the context window of this model";
		function emitContextOverflow(h: ReturnType<typeof loadRecoveryChild>) {
			h.handlers.get("agent_end")?.(
				{
					messages: [
						{
							role: "assistant",
							provider: "openai",
							model: "gpt-test",
							stopReason: "error",
							errorMessage: contextOverflowMessage,
						},
					],
				},
				h.ctx,
			);
		}
		function beginOverflowCompaction(h: ReturnType<typeof loadRecoveryChild>, signal = new AbortController().signal) {
			h.handlers.get("session_before_compact")?.({
				type: "session_before_compact",
				reason: "overflow",
				willRetry: true,
				signal,
			});
		}
		function readExit(h: ReturnType<typeof loadRecoveryChild>) {
			return JSON.parse(readFileSync(`${h.sessionFile}.exit`, "utf8"));
		}
		function assertNoExit(h: ReturnType<typeof loadRecoveryChild>) {
			assert.throws(() => readFileSync(`${h.sessionFile}.exit`, "utf8"));
		}

		it("does not loop when the agent makes intermittent progress before each error", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				// Failed run 1: a successful tool call, THEN the connection error.
				h.handlers.get("message_end")?.({
					message: {
						role: "assistant",
						stopReason: "toolUse",
						usage: { output: 3 },
					},
				});
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "Connection error.",
							},
						],
					},
					h.ctx,
				);
				mock.timers.tick(10_000);
				assert.deepEqual(h.sentMessages, ["continue"]);

				// Failed run 2: again a successful tool call, then error. Pre-fix this
				// reset the chain and looped forever; it must now escalate.
				h.handlers.get("message_end")?.({
					message: {
						role: "assistant",
						stopReason: "toolUse",
						usage: { output: 3 },
					},
				});
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "Connection error.",
							},
						],
					},
					h.ctx,
				);
				mock.timers.tick(10_000);
				assert.deepEqual(h.sentMessages, ["continue", "continue"]);

				// Failed run 3 -> kill (no third nudge, error sidecar written).
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "Connection error.",
							},
						],
					},
					h.ctx,
				);
				mock.timers.tick(10_000);

				assert.equal(h.sentMessages.length, 2, "must nudge exactly twice, never loop");
				const exit = JSON.parse(readFileSync(`${h.sessionFile}.exit`, "utf8"));
				assert.equal(exit.type, "error");
				assert.match(exit.errorMessage, /exhausted after 3/);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("resets and exits cleanly when a nudge leads to a successful completion", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				// Failed run -> nudge.
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "Connection error.",
							},
						],
					},
					h.ctx,
				);
				mock.timers.tick(10_000);
				assert.deepEqual(h.sentMessages, ["continue"]);

				// Recovered run completes normally -> reset + done sidecar, no further nudge.
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "done" }],
							},
						],
					},
					h.ctx,
				);
				const exit = JSON.parse(readFileSync(`${h.sessionFile}.exit`, "utf8"));
				assert.equal(exit.type, "done");
				assert.equal(h.sentMessages.length, 1);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("nudges after an unfamiliar HTTP 400 provider failure", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage:
									'400: {"type":"invalid_request_error","message":"Upstream request failed: Invalid request: text content is empty"}',
							},
						],
					},
					h.ctx,
				);

				mock.timers.tick(10_000);

				assert.deepEqual(h.sentMessages, ["continue"]);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("nudges an auto-exit child that ends at a tool-use boundary", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "tooluse" }] }, h.ctx);

				assert.deepEqual(h.sentMessages, ["continue"]);
				assert.deepEqual(h.sentMessageOptions, [{ deliverAs: "steer" }]);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);

				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "done" }],
							},
						],
					},
					h.ctx,
				);

				assert.equal(readExit(h).type, "done");
				assert.equal(h.sentMessages.length, 1);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("preserves an intentional tool-result termination", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "intentional-stop",
					toolName: "detached_launch",
					result: {
						content: [{ type: "text", text: "started" }],
						terminate: true,
					},
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
				mock.timers.tick(0);

				assert.deepEqual(h.sentMessages, []);
				assert.equal(readExit(h).type, "done");
				assert.equal(h.shutdowns, 1);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("keeps an auto-exit coordinator alive after an async nested launch stops its turn", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "nested-launch",
					toolName: "subagent",
					result: {
						content: [{ type: "text", text: "started" }],
						terminate: true,
					},
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
				mock.timers.tick(0);

				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("keeps an auto-exit coordinator alive after an async nested resume stops its turn", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "nested-resume",
					toolName: "subagent_resume",
					result: { content: [{ type: "text", text: "resumed" }], terminate: true },
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
				mock.timers.tick(0);

				assert.equal(h.shutdowns, 0);
				assertNoExit(h);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("auto-exits normally after the nested child result produces a final response", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "nested-launch",
					toolName: "subagent",
					result: { content: [{ type: "text", text: "started" }], terminate: true },
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);

				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 });
				h.handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final" }] }] },
					h.ctx,
				);
				mock.timers.tick(0);

				assert.equal(h.shutdowns, 1);
				assert.equal(readExit(h).type, "done");
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("does not carry a nested launch stop into the next turn", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "nested-launch",
					toolName: "subagent",
					result: { content: [{ type: "text", text: "started" }], terminate: true },
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);

				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "ordinary-stop",
					toolName: "detached_launch",
					result: { content: [{ type: "text", text: "done" }], terminate: true },
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
				mock.timers.tick(0);

				assert.equal(h.shutdowns, 1);
				assert.equal(readExit(h).type, "done");
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("uses tool-boundary recovery when a nested launch did not stop the whole batch", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0 });
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "nested-launch",
					toolName: "subagent",
					result: { content: [{ type: "text", text: "started" }], terminate: true },
					isError: false,
				});
				h.handlers.get("tool_execution_end")?.({
					type: "tool_execution_end",
					toolCallId: "sibling-work",
					toolName: "exec_command",
					result: { content: [{ type: "text", text: "done" }] },
					isError: false,
				});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);

				assert.deepEqual(h.sentMessages, ["continue"]);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("stays alive after an intermediate child result while a sibling is still running", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				publishRunningSubagentCountForTest(() => 1);

				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 });
				h.handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first result" }] }] },
					h.ctx,
				);
				mock.timers.tick(0);

				assert.equal(h.shutdowns, 0);
				assertNoExit(h);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("honors /auto-exit re-arm across multiple extension-delivered child results", async () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				publishRunningSubagentCountForTest(() => 1);

				h.handlers.get("agent_start")?.({ type: "agent_start" });
				h.handlers.get("input")?.({ source: "interactive", streamingBehavior: "steer" }, h.ctx);
				await h.commands.get("auto-exit")?.handler({}, h.ctx);

				h.handlers.get("input")?.({ source: "extension", streamingBehavior: "steer" }, h.ctx);
				h.handlers.get("agent_start")?.({ type: "agent_start" });
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1 });
				h.handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first child" }] }] },
					h.ctx,
				);
				mock.timers.tick(0);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);

				publishRunningSubagentCountForTest(() => 0);
				h.handlers.get("input")?.({ source: "extension", streamingBehavior: "steer" }, h.ctx);
				h.handlers.get("agent_start")?.({ type: "agent_start" });
				h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 2 });
				h.handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "last child" }] }] },
					h.ctx,
				);
				mock.timers.tick(0);

				assert.equal(h.shutdowns, 1);
				assert.equal(readExit(h).type, "done");
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("fails instead of looping after repeated tool-use boundary endings", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				for (let attempt = 0; attempt < 3; attempt++) {
					h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
				}
				mock.timers.tick(0);

				assert.deepEqual(h.sentMessages, ["continue", "continue"]);
				assert.equal(h.shutdowns, 1);
				const exit = readExit(h);
				assert.equal(exit.type, "error");
				assert.equal(exit.stopReason, "toolUse");
				assert.match(exit.errorMessage, /3 consecutive tool-use boundary/i);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("bounds recovery when provider errors alternate with tool-use endings", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
					h.handlers.get("agent_end")?.(
						{
							messages: [
								{
									role: "assistant",
									stopReason: "error",
									errorMessage: "Connection error.",
								},
							],
						},
						h.ctx,
					);
					mock.timers.tick(10_000);
				}

				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "toolUse" }] }, h.ctx);
				mock.timers.tick(0);

				assert.equal(h.shutdowns, 1);
				assert.equal(readExit(h).type, "error");
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("reports permanent provider errors on shutdown without recovery nudges", async () => {
			const h = loadRecoveryChild();
			try {
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "insufficient_quota",
							},
						],
					},
					h.ctx,
				);
				await sleep(20);
				h.handlers.get("session_shutdown")?.();

				const exit = JSON.parse(readFileSync(`${h.sessionFile}.exit`, "utf8"));
				assert.equal(exit.type, "error");
				assert.equal(exit.errorMessage, "insufficient_quota");
				assert.equal(h.sentMessages.length, 0);
				assert.equal(h.shutdowns, 1);
			} finally {
				cleanup(h.dir);
			}
		});

		it("cancels an armed recovery timer when a later permanent error requests shutdown", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "Connection error.",
							},
						],
					},
					h.ctx,
				);
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "insufficient_quota",
							},
						],
					},
					h.ctx,
				);

				mock.timers.tick(10_000);
				h.handlers.get("session_shutdown")?.();
				const exit = JSON.parse(readFileSync(`${h.sessionFile}.exit`, "utf8"));
				assert.equal(exit.type, "error");
				assert.equal(exit.errorMessage, "insufficient_quota");
				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 1);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("defers context-overflow errors to active Pi compaction without extension nudges", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				emitContextOverflow(h);
				beginOverflowCompaction(h);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);

				mock.timers.tick(30_000);
				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);

				h.handlers.get("session_compact")?.({
					type: "session_compact",
					reason: "overflow",
					willRetry: true,
				});
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "stop",
								content: [{ type: "text", text: "done" }],
							},
						],
					},
					h.ctx,
				);
				assert.equal(readExit(h).type, "done");
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("fails context-overflow errors when Pi compaction does not start", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			try {
				emitContextOverflow(h);

				mock.timers.tick(179_999);
				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);

				mock.timers.tick(1);
				mock.timers.tick(0);
				const exit = readExit(h);
				assert.equal(exit.type, "error");
				assert.equal(exit.errorMessage, contextOverflowMessage);
				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 1);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("fails context-overflow errors when active Pi compaction aborts", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			const abortController = new AbortController();
			try {
				emitContextOverflow(h);
				beginOverflowCompaction(h, abortController.signal);

				abortController.abort();
				mock.timers.tick(0);

				const exit = readExit(h);
				assert.equal(exit.type, "error");
				assert.equal(exit.errorMessage, contextOverflowMessage);
				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 1);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("ignores stale compaction aborts after Pi recovery is superseded", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild();
			const oldAbort = new AbortController();
			try {
				emitContextOverflow(h);
				beginOverflowCompaction(h, oldAbort.signal);
				h.handlers.get("session_compact")?.({
					type: "session_compact",
					reason: "overflow",
					willRetry: true,
				});

				emitContextOverflow(h);
				beginOverflowCompaction(h);
				oldAbort.abort();
				mock.timers.tick(0);

				assert.deepEqual(h.sentMessages, []);
				assert.equal(h.shutdowns, 0);
				assertNoExit(h);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});

		it("writes background provider errors on shutdown and cancels pending retry timers", () => {
			mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
			const h = loadRecoveryChild({ interactive: false });
			try {
				h.handlers.get("agent_end")?.(
					{
						messages: [
							{
								role: "assistant",
								stopReason: "error",
								errorMessage: "Connection error.",
							},
						],
					},
					h.ctx,
				);
				h.handlers.get("session_shutdown")?.({
					type: "session_shutdown",
					reason: "quit",
				});
				h.makeContextStale();
				mock.timers.tick(10_000);

				const exit = JSON.parse(readFileSync(`${h.sessionFile}.exit`, "utf8"));
				assert.deepEqual(exit, {
					type: "error",
					errorMessage: "Connection error.",
					stopReason: "error",
					outputTokens: 0,
				});
				assert.equal(h.sentMessages.length, 0);
			} finally {
				cleanup(h.dir);
				mock.timers.reset();
			}
		});
	});
});
