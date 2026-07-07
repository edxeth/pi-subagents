import { mock } from "node:test";
import {
	assert,
	readFileSync,
	rmSync,
	writeFileSync,
	join,
	describe,
	it,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
	getSubagentToolAllowlistForTest,
	getSubagentToolsWarningForTest,
	withToolWarningForTest,
	getSubagentToolDeniedNamesForTest,
	getSubagentToolLaunchArgsForTest,
	subagentDoneExtension,
	filterToolNames,
	getDeniedToolNames,
	installDeniedToolGuards,
	shouldRegisterSubagentDone,
	createTestDir,
	sleep,
} from "../support/index.ts";

function withSetTabTitleEnv<T>(value: string | undefined, run: () => T): T {
	const original = process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
	try {
		if (value === undefined) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = value;
		return run();
	} finally {
		if (original == null) delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;
		else process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = original;
	}
}

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
			const messages = [{ role: "assistant", stopReason: "error", errorMessage: "Provider overload" }];
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

	describe("deny-tools enforcement", () => {
		it("adds subagent_done to denied tools for auto-exit agents", () => {
			assert.deepEqual(getDeniedToolNames(true, "ask_user_question"), [
				"ask_user_question",
				"subagent_done",
			]);
		});

		it("filters denied tool names and de-duplicates survivors", () => {
			assert.deepEqual(
				filterToolNames(
					["read", "ask_user_question", "read", "bash"],
					["ask_user_question"],
				),
				["read", "bash"],
			);
		});

		it("keeps required subagent protocol tools available when built-in tools are narrowed", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("bash"), [
					"bash",
					"caller_ping",
					"subagent_done",
				]);
			});
		});

		it("adds set_tab_title to narrowed child launch allowlists only when opted in", () => {
			withSetTabTitleEnv("1", () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("bash"), [
					"bash",
					"caller_ping",
					"subagent_done",
					"set_tab_title",
				]);
			});
		});

		it("does not let disabled set_tab_title-only allowlists fall back to default tools", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolLaunchArgsForTest("set_tab_title", []), [
					"--tools",
					"caller_ping,subagent_done",
				]);
				assert.deepEqual(
					getSubagentToolLaunchArgsForTest("set_tab_title", [
						"caller_ping",
						"subagent_done",
					]),
					[
						"--no-tools",
						"--exclude-tools",
						"caller_ping,subagent_done",
					],
				);
			});
		});

		it("removes denied subagent protocol tools from the launch allowlist", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(
					getSubagentToolAllowlistForTest("bash,read", ["caller_ping"]),
					["bash", "read", "subagent_done"],
				);
			});
		});

		it("keeps non-requested built-ins out of narrowed child launch allowlists", () => {
			assert.deepEqual(
				getSubagentToolAllowlistForTest("bash").includes("edit"),
				false,
			);
			assert.deepEqual(
				getSubagentToolAllowlistForTest("bash").includes("write"),
				false,
			);
			assert.deepEqual(getSubagentToolAllowlistForTest(undefined), []);
		});

		it("maps omitted and all tools to default launch behavior", () => {
			assert.deepEqual(getSubagentToolLaunchArgsForTest(undefined), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("all"), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest(" all "), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("all", ["bash"]), [
				"--exclude-tools",
				"bash",
			]);
		});

		it("maps tools none to no built-in tools while preserving extension tools", () => {
			assert.deepEqual(getSubagentToolAllowlistForTest("none"), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("none"), [
				"--no-builtin-tools",
			]);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("none", ["read", "subagent"]), [
				"--no-builtin-tools",
				"--exclude-tools",
				"read,subagent",
			]);
			assert.deepEqual(getSubagentToolDeniedNamesForTest("none"), [
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
			]);
		});

		it("maps narrowed built-in tools to a tool allowlist with protocol tools", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolLaunchArgsForTest("bash", []), [
					"--tools",
					"bash,caller_ping,subagent_done",
				]);
			});
		});

		it("passes extension and custom tool names through narrowed child launch allowlists", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolLaunchArgsForTest("bash,mcp", []), [
					"--tools",
					"bash,mcp,caller_ping,subagent_done",
				]);
			});
		});

		it("keeps a denied custom tool in --exclude-tools even when it appears in the allowlist", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolLaunchArgsForTest("bash,mcp", ["mcp"]), [
					"--tools",
					"bash,mcp,caller_ping,subagent_done",
					"--exclude-tools",
					"mcp",
				]);
			});
		});

		it("warns (non-blocking) on a likely built-in typo instead of letting Pi silently drop it", () => {
			const transposition = getSubagentToolsWarningForTest("read,edti");
			assert.equal(transposition?.suggestion, "edit");
			assert.equal(transposition?.name, "edti");
			assert.match(transposition?.message ?? "", /may be a typo of built-in "edit"/);
			assert.match(transposition?.message ?? "", /Warning:/);

			assert.equal(getSubagentToolsWarningForTest("rerd")?.suggestion, "read");
			assert.equal(getSubagentToolsWarningForTest("wr1te")?.suggestion, "write");
		});

		it("does not flag legitimate custom/extension tool names as built-in typos", () => {
			assert.equal(getSubagentToolsWarningForTest("read,mcp"), null);
			assert.equal(getSubagentToolsWarningForTest("reader"), null);
			assert.equal(getSubagentToolsWarningForTest("caller_ping"), null);
			assert.equal(getSubagentToolsWarningForTest("all"), null);
			assert.equal(getSubagentToolsWarningForTest("none"), null);
			assert.equal(getSubagentToolsWarningForTest(undefined), null);
		});

		it("reports a warning for plausible near-builtin custom names instead of blocking them", () => {
			// exit≈edit, hash≈bash, reads≈read: these are plausible custom tools,
			// so the guard must only WARN (never block). It still surfaces the hint.
			assert.equal(getSubagentToolsWarningForTest("exit")?.suggestion, "edit");
			assert.equal(getSubagentToolsWarningForTest("hash")?.suggestion, "bash");
			assert.equal(getSubagentToolsWarningForTest("reads")?.suggestion, "read");
		});

		it("preserves terminate and details when prepending a warning to a result", () => {
			const result = withToolWarningForTest(
				{ content: [{ type: "text", text: "Sub-agent started." }], details: { status: "started" }, terminate: true },
				"Warning: edti may be a typo of edit.",
			);
			assert.equal((result as { terminate?: true }).terminate, true);
			assert.deepEqual((result as { details: unknown }).details, { status: "started" });
			const text = (result as { content: Array<{ type: string; text: string }> }).content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			assert.match(text, /Warning: edti may be a typo of edit\./);
			assert.match(text, /Sub-agent started\./);

			// No warning: result returned untouched, including terminate.
			const untouched = withToolWarningForTest(
				{ content: [{ type: "text", text: "ok" }], details: {}, terminate: true },
				"",
			);
			assert.equal((untouched as { terminate?: true }).terminate, true);
		});

		it("preserves CLI-disabled built-ins while applying denied tool filters", () => {
			const allTools = [
				{ name: "read" },
				{ name: "bash" },
				{ name: "caller_ping" },
			];
			let activeTools = ["caller_ping"];
			const pi = {
				getAllTools: () => allTools,
				getActiveTools: () => activeTools,
				setActiveTools: (toolNames: string[]) => {
					activeTools = [...toolNames];
				},
				registerTool(definition: { name: string }) {
					allTools.push({ name: definition.name });
					activeTools.push(definition.name);
				},
			} as any;

			const { applyDeniedTools } = installDeniedToolGuards(pi, false);
			assert.deepEqual(applyDeniedTools(), ["caller_ping"]);
			assert.deepEqual(activeTools, ["caller_ping"]);
		});

		it("keeps denied tools out of the active set after registration and later setActiveTools calls", () => {
			const allTools = [
				{ name: "read" },
				{ name: "bash" },
				{ name: "ask_user_question" },
			];
			let activeTools = allTools.map((tool) => tool.name);
			const changes: Array<{ active: string[]; denied: string[] }> = [];
			const pi = {
				getAllTools: () => allTools,
				getActiveTools: () => activeTools,
				setActiveTools: (toolNames: string[]) => {
					activeTools = [...toolNames];
				},
				registerTool: (definition: { name: string }) => {
					allTools.push({ name: definition.name });
				},
			} as any;

			const original = process.env.PI_DENY_TOOLS;
			process.env.PI_DENY_TOOLS = "ask_user_question";
			try {
				const { applyDeniedTools } = installDeniedToolGuards(
					pi,
					false,
					(active, denied) => {
						changes.push({ active: [...active], denied: [...denied] });
					},
				);

				assert.deepEqual(applyDeniedTools(), ["read", "bash"]);
				assert.deepEqual(activeTools, ["read", "bash"]);

				assert.deepEqual(activeTools, ["read", "bash"]);

				pi.setActiveTools(["read", "ask_user_question", "bash"]);
				assert.deepEqual(activeTools, ["read", "bash"]);
				assert.equal(changes.at(-1)?.denied.join(","), "ask_user_question");
			} finally {
				if (original == null) delete process.env.PI_DENY_TOOLS;
				else process.env.PI_DENY_TOOLS = original;
			}
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
					} as any);

					handlers.get("message_end")?.({
						message: { role: "assistant", usage: { output: 23 } },
					});
					handlers.get("session_shutdown")?.();

					assert.deepEqual(
						JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
						{ type: "done", outputTokens: 23 },
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
				await pingTool.execute(
					"tool-1",
					{ message: "Need help" },
					undefined,
					undefined,
					{
						shutdown() {
							shutdowns += 1;
						},
					},
				);
				await sleep(0);

				assert.equal(shutdowns, 1);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{
						type: "ping",
						name: "Ping Child",
						message: "Need help",
						outputTokens: 11,
					},
				);
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
				} as any);

				let shutdowns = 0;
				handlers.get("agent_start")?.({});
				handlers.get("input")?.({ streamingBehavior: "followUp" });
				handlers.get("agent_end")?.(
					{ messages: [{ role: "assistant", stopReason: "stop" }] },
					{ shutdown() { shutdowns += 1; } },
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
			} as any);

			const doneTool = tools.get("subagent_done");
			assert.ok(doneTool);

			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");

			const originalSession = process.env.PI_SUBAGENT_SESSION;
			try {
				process.env.PI_SUBAGENT_SESSION = sessionFile;
				handlers.get("message_end")?.({
					message: { role: "assistant", usage: { output: 17 } },
				});
				let shutdowns = 0;
				await doneTool.execute("tool-2", {}, undefined, undefined, {
					shutdown() {
						shutdowns += 1;
					},
				});
				await sleep(0);

				assert.equal(shutdowns, 1);
				assert.deepEqual(
					JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")),
					{ type: "done", outputTokens: 17 },
				);
			} finally {
				if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
				else process.env.PI_SUBAGENT_SESSION = originalSession;
				rmSync(dir, { recursive: true, force: true });
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

