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
	getSubagentToolDeniedNamesForTest,
	getSubagentToolLaunchArgsForTest,
	getSubagentToolsConfigErrorForTest,
	subagentDoneExtension,
	filterToolNames,
	getDeniedToolNames,
	installDeniedToolGuards,
	shouldRegisterSubagentDone,
	createTestDir,
	sleep,
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

		it("keeps subagent protocol tools available when built-in tools are narrowed", () => {
			assert.deepEqual(getSubagentToolAllowlistForTest("bash"), [
				"bash",
				"caller_ping",
				"subagent_done",
				"set_tab_title",
			]);
		});

		it("removes denied subagent protocol tools from the launch allowlist", () => {
			assert.deepEqual(
				getSubagentToolAllowlistForTest("bash,read", ["caller_ping"]),
				["bash", "read", "subagent_done", "set_tab_title"],
			);
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
		});

		it("maps tools none to no built-in tools while preserving extension tools", () => {
			assert.deepEqual(getSubagentToolAllowlistForTest("none"), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("none"), [
				"--no-builtin-tools",
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
			assert.deepEqual(getSubagentToolLaunchArgsForTest("bash", []), [
				"--tools",
				"bash,caller_ping,subagent_done,set_tab_title",
			]);
		});

		it("rejects unknown tools values instead of falling back to full access", () => {
			const error = getSubagentToolsConfigErrorForTest("bash,nope", "worker");
			assert.equal(error?.details.error, "invalid_tools");
			assert.deepEqual(error?.details.invalid, ["nope"]);
			assert.match(
				error?.content[0]?.text ?? "",
				/invalid tools value for agent "worker": nope/,
			);
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
});

