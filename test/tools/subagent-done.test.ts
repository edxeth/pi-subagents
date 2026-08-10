import { mock } from "node:test";
import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	rmSync,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
	shouldRegisterSubagentDone,
	sleep,
	subagentDoneExtension,
	writeFileSync,
} from "../support/index.ts";

describe("subagent-done.ts", () => {
	describe("shouldMarkUserTookOver", () => {
		it("ignores the initial injected task before the first agent run", () => {
			assert.equal(shouldMarkUserTookOver(false), false);
		});

		it("treats later input as manual takeover", () => {
			assert.equal(shouldMarkUserTookOver(true), true);
		});

		it("treats streaming steers and queued follow-ups as takeover", () => {
			assert.equal(shouldMarkUserTookOver(false, "steer"), true);
			assert.equal(shouldMarkUserTookOver(false, "followUp"), true);
		});
	});

	describe("shouldAutoExitOnAgentEnd", () => {
		it("auto-exits after normal completion", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(messages), true);
		});

		it("auto-exits after normal completion even when the user sent the prompt", () => {
			const messages = [{ role: "assistant", stopReason: "stop" }];
			assert.equal(shouldAutoExitOnAgentEnd(messages), true);
		});

		it("stays open after Escape aborts the run", () => {
			const messages = [{ role: "assistant", stopReason: "aborted" }];
			assert.equal(shouldAutoExitOnAgentEnd(messages), false);
		});

		it("auto-exits after provider error when there are no usable text messages", () => {
			const messages = [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "Provider overload",
				},
			];
			assert.equal(shouldAutoExitOnAgentEnd(messages), true);
		});

		it("defaults to auto-exit when there are no assistant messages", () => {
			const messages = [{ role: "user" }, { role: "toolResult" }];
			assert.equal(shouldAutoExitOnAgentEnd(messages), true);
		});

		it("defaults to auto-exit when messages are missing", () => {
			assert.equal(shouldAutoExitOnAgentEnd(undefined), true);
		});
	});

	describe("shouldRegisterSubagentDone", () => {
		it("hides subagent_done for auto-exit agents", () => {
			assert.equal(shouldRegisterSubagentDone(true, []), false);
		});

		it("respects explicit deny lists", () => {
			assert.equal(shouldRegisterSubagentDone(false, ["subagent_done"]), false);
		});

		it("keeps subagent_done for manual-close background agents", () => {
			assert.equal(shouldRegisterSubagentDone(false, []), true);
		});

		it("hides subagent_done for manual-close interactive agents", () => {
			assert.equal(shouldRegisterSubagentDone(false, [], true), false);
		});

		it("hides subagent_done for auto-exit interactive agents", () => {
			assert.equal(shouldRegisterSubagentDone(true, [], true), false);
		});
	});

	describe("session_start denied-tool enforcement", () => {
		it("ignores stale contexts in delayed enforcement callbacks", () => {
			mock.timers.enable({ apis: ["setTimeout"] });
			try {
				const handlers = new Map<string, any>();
				let stale = false;
				let activeTools = ["read"];

				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools() {
						if (stale) throw new Error("stale context");
						return activeTools;
					},
					setActiveTools(toolNames: string[]) {
						if (stale) throw new Error("stale context");
						activeTools = [...toolNames];
					},
					registerTool(definition: { name: string }) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand() {},
				} as any);

				handlers.get("session_start")?.(
					{},
					{
						ui: {
							setWidget() {},
						},
					},
				);
				stale = true;

				assert.doesNotThrow(() => mock.timers.tick(250));
			} finally {
				mock.timers.reset();
			}
		});
	});

	describe("caller_ping extension tools", () => {
		it("writes done sidecars on shutdown for all child lifecycle modes", () => {
			const cases = [
				{ name: "interactive auto-exit", autoExit: true, surface: "pane-1" },
				{ name: "interactive manual", autoExit: false, surface: "pane-1" },
				{ name: "background auto-exit", autoExit: true, surface: undefined },
				{ name: "background manual", autoExit: false, surface: undefined },
			];

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const originalSurface = process.env.PI_SUBAGENT_SURFACE;
			const dir = createTestDir();

			try {
				for (const testCase of cases) {
					const tools = new Map<string, any>();
					const handlers = new Map<string, any>();
					const sessionFile = join(dir, `${testCase.name.replace(/\s/g, "-")}.jsonl`);
					writeFileSync(sessionFile, "");

					process.env.PI_SUBAGENT_SESSION = sessionFile;
					if (testCase.autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
					else delete process.env.PI_SUBAGENT_AUTO_EXIT;
					if (testCase.surface) process.env.PI_SUBAGENT_SURFACE = testCase.surface;
					else delete process.env.PI_SUBAGENT_SURFACE;

					subagentDoneExtension({
						getAllTools: () => [],
						getActiveTools: () => [],
						setActiveTools() {},
						registerTool(definition: { name: string }) {
							tools.set(definition.name, definition);
							return definition;
						},
						on(event: string, handler: any) {
							handlers.set(event, handler);
						},
						registerShortcut() {},
						registerCommand() {},
					} as any);

					handlers.get("message_end")?.(
						{ message: { role: "assistant", usage: { output: 23 } } },
						{
							getContextUsage: () => ({
								tokens: 145_000,
								contextWindow: 200_000,
							}),
						},
					);
					handlers.get("session_shutdown")?.();

					assert.deepEqual(
						JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
						{
							type: "done",
							outputTokens: 23,
							contextTokens: 145_000,
							contextWindow: 200_000,
						},
						testCase.name,
					);
				}
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				if (originalSurface == null) delete process.env.PI_SUBAGENT_SURFACE;
				else process.env.PI_SUBAGENT_SURFACE = originalSurface;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("registers caller_ping and writes a ping exit sidecar", async () => {
			const tools = new Map<string, any>();
			const handlers = new Map<string, any>();
			subagentDoneExtension({
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools() {},
				registerTool(definition: { name: string }) {
					tools.set(definition.name, definition);
					return definition;
				},
				on(event: string, handler: any) {
					handlers.set(event, handler);
				},
				registerShortcut() {},
				registerCommand() {},
			} as any);

			const pingTool = tools.get("caller_ping");
			assert.ok(pingTool);

			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalName = process.env.PI_SUBAGENT_NAME;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				process.env.PI_SUBAGENT_NAME = "Ping Child";
				handlers.get("message_end")?.({
					message: { role: "assistant", usage: { output: 11 } },
				});
				let shutdowns = 0;
				await pingTool.execute("tool-1", { message: "Need help" }, undefined, undefined, {
					shutdown() {
						shutdowns += 1;
					},
				});
				await sleep(0);

				assert.equal(shutdowns, 1);
				assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
					type: "ping",
					name: "Ping Child",
					message: "Need help",
					outputTokens: 11,
				});
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalName == null) delete process.env.PI_SUBAGENT_NAME;
				else process.env.PI_SUBAGENT_NAME = originalName;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps auto-exit agents open for streaming follow-ups", async () => {
			const handlers = new Map<string, any>();
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				process.env.PI_SUBAGENT_AUTO_EXIT = "1";
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: { name: string }) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand() {},
				} as any);

				let shutdowns = 0;
				handlers.get("agent_start")?.({});
				handlers.get("input")?.({ streamingBehavior: "followUp" });
				// Simulate the real event sequence: after user input, a new agent_start
				// fires before agent_end processes the follow-up turn.
				handlers.get("agent_start")?.({});
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop" }] },
					{
						shutdown() {
							shutdowns += 1;
						},
					},
				);
				await sleep(0);

				assert.equal(shutdowns, 0);
				assert.throws(() => readFileSync(`${sessionFile}.exit`, "utf8"));
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps auto-exit agents open after Escape then steer", async () => {
			const handlers = new Map<string, any>();
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				process.env.PI_SUBAGENT_AUTO_EXIT = "1";
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: { name: string }) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand() {},
				} as any);

				let shutdowns = 0;
				// 1. Agent starts working
				handlers.get("agent_start")?.({});

				// 2. User presses Escape — agent turn aborted
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "aborted" }] },
					{
						shutdown() {
							shutdowns += 1;
						},
						ui: { setStatus() {}, notify() {} },
					},
				);
				assert.equal(shutdowns, 0, "aborted turn should not shutdown");

				// 3. User types a question
				handlers.get("input")?.({ streamingBehavior: "steer" });

				// 4. New turn starts to process the question
				handlers.get("agent_start")?.({});

				// 5. Agent answers the question — should NOT auto-exit
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop" }] },
					{
						shutdown() {
							shutdowns += 1;
						},
					},
				);
				await sleep(0);

				assert.equal(shutdowns, 0, "should not auto-exit after user interaction");
				assert.throws(() => readFileSync(`${sessionFile}.exit`, "utf8"));
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("keeps interactive auto-exit agents open after Escape alone", async () => {
			const handlers = new Map<string, any>();
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const originalSurface = process.env.PI_SUBAGENT_SURFACE;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				process.env.PI_SUBAGENT_AUTO_EXIT = "1";
				process.env.PI_SUBAGENT_SURFACE = "pane:test";
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: { name: string }) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand() {},
				} as any);

				let shutdowns = 0;
				// 1. Agent starts working on an interactive pane
				handlers.get("agent_start")?.({});

				// 2. User presses Escape — agent turn aborted
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "aborted" }] },
					{
						shutdown() {
							shutdowns += 1;
						},
						ui: { setStatus() {}, notify() {} },
					},
				);
				assert.equal(shutdowns, 0, "aborted turn should not shutdown");

				// 3. New autonomous turn starts (retry/nudge)
				handlers.get("agent_start")?.({});

				// 4. Agent completes normally — should NOT auto-exit because
				//    Escape permanently disabled auto-exit for interactive agents
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop" }] },
					{
						shutdown() {
							shutdowns += 1;
						},
						ui: { setStatus() {}, notify() {} },
					},
				);
				await sleep(0);

				assert.equal(shutdowns, 0, "should not auto-exit after Escape in interactive mode");
				assert.throws(() => readFileSync(`${sessionFile}.exit`, "utf8"));
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				if (originalSurface == null) delete process.env.PI_SUBAGENT_SURFACE;
				else process.env.PI_SUBAGENT_SURFACE = originalSurface;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("shows auto-exit disabled status after Escape on interactive pane", async () => {
			const handlers = new Map<string, any>();
			const commands = new Map<string, any>();
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const originalSurface = process.env.PI_SUBAGENT_SURFACE;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				process.env.PI_SUBAGENT_AUTO_EXIT = "1";
				process.env.PI_SUBAGENT_SURFACE = "pane:test";
				let statusKey: string | undefined;
				let statusMessage: string | undefined;
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: { name: string }) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand(name: string, def: any) {
						commands.set(name, def);
					},
				} as any);

				handlers.get("agent_start")?.({});
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "aborted" }] },
					{
						shutdown() {},
						ui: {
							setStatus(key: string, msg?: string) {
								statusKey = key;
								statusMessage = msg;
							},
							notify() {},
						},
					},
				);
				assert.equal(statusKey, "pi-subagent-auto-exit");
				assert.equal(statusMessage, "Auto-exit disabled \u2014 close manually or /auto-exit to re-enable");
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				if (originalSurface == null) delete process.env.PI_SUBAGENT_SURFACE;
				else process.env.PI_SUBAGENT_SURFACE = originalSurface;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("re-enables auto-exit via /auto-exit command", async () => {
			const handlers = new Map<string, any>();
			const commands = new Map<string, any>();
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
			const originalSurface = process.env.PI_SUBAGENT_SURFACE;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				process.env.PI_SUBAGENT_AUTO_EXIT = "1";
				process.env.PI_SUBAGENT_SURFACE = "pane:test";
				let statusKey: string | undefined;
				let statusMessage: string | undefined;
				let notifyMsg: string | undefined;
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: { name: string }) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand(name: string, def: any) {
						commands.set(name, def);
					},
				} as any);

				// Simulate user interaction that disables auto-exit
				let shutdowns = 0;
				handlers.get("agent_start")?.({});
				handlers.get("input")?.({ streamingBehavior: "steer" }, { ui: { setStatus: (k: string, m?: string) => { statusKey = k; statusMessage = m; }, notify: (m: string) => { notifyMsg = m; } } });

				// Verify /auto-exit command was registered
				const autoExitCmd = commands.get("auto-exit");
				assert.ok(autoExitCmd, "/auto-exit command should be registered");
				assert.equal(autoExitCmd.description, "Re-enable auto-exit after operator interaction");

				// Run the command handler
				await autoExitCmd.handler(
					{},
					{
						ui: {
							setStatus(key: string, msg?: string) {
								statusKey = key;
								statusMessage = msg;
							},
							notify(msg: string) {
								notifyMsg = msg;
							},
						},
					},
				);

				// Status should be cleared
				assert.equal(statusKey, "pi-subagent-auto-exit");
				assert.equal(statusMessage, undefined);
				// Should notify that auto-exit is re-enabled
				assert.ok(notifyMsg?.includes("re-enabled"), "should notify re-enabled");

				// Now simulate a new turn completing normally
				handlers.get("agent_start")?.({});
				// After /auto-exit, agent_end should auto-exit
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop" }] },
					{
						shutdown() {
							shutdowns += 1;
						},
					},
				);
				await sleep(0);

				assert.equal(shutdowns, 1, "should auto-exit after /auto-exit re-enables it");
				assert.doesNotThrow(() => readFileSync(`${sessionFile}.exit`, "utf8"));
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
				else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
				if (originalSurface == null) delete process.env.PI_SUBAGENT_SURFACE;
				else process.env.PI_SUBAGENT_SURFACE = originalSurface;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("writes a done exit sidecar when subagent_done runs", async () => {
			const tools = new Map<string, any>();
			const handlers = new Map<string, any>();
			subagentDoneExtension({
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools() {},
				registerTool(definition: { name: string }) {
					tools.set(definition.name, definition);
					return definition;
				},
				on(event: string, handler: any) {
					handlers.set(event, handler);
				},
				registerShortcut() {},
				registerCommand() {},
			} as any);

			const doneTool = tools.get("subagent_done");
			assert.ok(doneTool);

			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				handlers.get("message_end")?.(
					{ message: { role: "assistant", usage: { output: 17 } } },
					{
						getContextUsage: () => ({
							tokens: 145_000,
							contextWindow: 200_000,
						}),
					},
				);
				let shutdowns = 0;
				await doneTool.execute("tool-2", {}, undefined, undefined, {
					shutdown() {
						shutdowns += 1;
					},
				});
				await sleep(0);

				assert.equal(shutdowns, 1);
				assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
					type: "done",
					outputTokens: 17,
					contextTokens: 145_000,
					contextWindow: 200_000,
				});
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("APPEND_SYSTEM inheritance", () => {
		it("appends pi-subagents child prompt text after Pi performs native discovery", () => {
			const original = process.env.PI_SUBAGENT_APPEND_SYSTEM_PROMPT;
			process.env.PI_SUBAGENT_APPEND_SYSTEM_PROMPT = "Reviewer identity.\n\nChild boundary instructions.";
			try {
				const handlers = new Map<string, any>();
				subagentDoneExtension({
					getAllTools: () => [],
					getActiveTools: () => [],
					setActiveTools() {},
					registerTool(definition: unknown) {
						return definition;
					},
					on(event: string, handler: any) {
						handlers.set(event, handler);
					},
					registerShortcut() {},
					registerCommand() {},
				} as any);

				const result = handlers.get("before_agent_start")({
					type: "before_agent_start",
					prompt: "Review",
					systemPrompt: "Pi default.\n\nNative APPEND_SYSTEM.",
					systemPromptOptions: {
						cwd: process.cwd(),
						appendSystemPrompt: "Native APPEND_SYSTEM.",
					},
				});

				assert.equal(
					result?.systemPrompt,
					"Pi default.\n\nNative APPEND_SYSTEM.\n\nReviewer identity.\n\nChild boundary instructions.",
				);
			} finally {
				if (original == null) delete process.env.PI_SUBAGENT_APPEND_SYSTEM_PROMPT;
				else process.env.PI_SUBAGENT_APPEND_SYSTEM_PROMPT = original;
			}
		});
	});

	describe("set_tab_title registration", () => {
		function loadChildExtension() {
			const tools = new Map<string, any>();
			subagentDoneExtension({
				getAllTools: () => [],
				getActiveTools: () => [],
				setActiveTools() {},
				registerTool(definition: { name: string }) {
					tools.set(definition.name, definition);
					return definition;
				},
				on() {},
				registerShortcut() {},
				registerCommand() {},
			} as any);
			return tools;
		}

		it("registers set_tab_title when PI_SUBAGENT_ENABLE_SET_TAB_TITLE is enabled", () => {
			const original = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			const originalDeny = process.env.PI_DENY_TOOLS;
			process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
			delete process.env.PI_DENY_TOOLS;
			try {
				const tools = loadChildExtension();
				assert.ok(tools.has("set_tab_title"), "child extension should register set_tab_title");
				const tool = tools.get("set_tab_title");
				assert.equal(tool.label, "Set Tab Title");
			} finally {
				if (original == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
				else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = original;
				if (originalDeny == null) delete process.env.PI_DENY_TOOLS;
				else process.env.PI_DENY_TOOLS = originalDeny;
			}
		});

		it("does not register set_tab_title when the opt-in is disabled", () => {
			const original = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			const originalDeny = process.env.PI_DENY_TOOLS;
			delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			delete process.env.PI_DENY_TOOLS;
			try {
				const tools = loadChildExtension();
				assert.equal(tools.has("set_tab_title"), false);
			} finally {
				if (original == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
				else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = original;
				if (originalDeny == null) delete process.env.PI_DENY_TOOLS;
				else process.env.PI_DENY_TOOLS = originalDeny;
			}
		});

		it("does not register set_tab_title when the agent denies it", () => {
			const original = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
			const originalDeny = process.env.PI_DENY_TOOLS;
			process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
			process.env.PI_DENY_TOOLS = "set_tab_title";
			try {
				const tools = loadChildExtension();
				assert.equal(tools.has("set_tab_title"), false);
			} finally {
				if (original == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
				else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = original;
				if (originalDeny == null) delete process.env.PI_DENY_TOOLS;
				else process.env.PI_DENY_TOOLS = originalDeny;
			}
		});
	});
});
