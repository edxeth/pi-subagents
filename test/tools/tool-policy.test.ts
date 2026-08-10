import {
	assert,
	describe,
	filterToolNames,
	getDeniedToolNames,
	getSubagentToolAllowlistForTest,
	getSubagentToolDeniedNamesForTest,
	getSubagentToolLaunchArgsForTest,
	getSubagentToolsWarningForTest,
	getExtensionLaunchArgsForTest,
	getSubagentsExtensionPathForTest,
	installDeniedToolGuards,
	it,
	isPreparedChildSpawningAllowedForTest,
	withToolWarningForTest,
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

describe("tool policy", () => {
	describe("deny-tools enforcement", () => {
		it("adds subagent_done to denied tools for auto-exit agents", () => {
			assert.deepEqual(getDeniedToolNames(true, "ask_user_question"), ["ask_user_question", "subagent_done"]);
		});

		it("filters denied tool names and de-duplicates survivors", () => {
			assert.deepEqual(filterToolNames(["read", "ask_user_question", "read", "bash"], ["ask_user_question"]), [
				"read",
				"bash",
			]);
		});

		it("keeps required subagent protocol tools available when built-in tools are narrowed", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("bash"), ["bash", "caller_ping", "subagent_done"]);
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
				assert.deepEqual(getSubagentToolLaunchArgsForTest("set_tab_title", ["caller_ping", "subagent_done"]), [
					"--no-tools",
					"--exclude-tools",
					"caller_ping,subagent_done",
				]);
			});
		});

		it("removes denied subagent protocol tools from the launch allowlist", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("bash,read", ["caller_ping"]), [
					"bash",
					"read",
					"subagent_done",
				]);
			});
		});

		it("keeps spawning tools available to a narrowed tools list when the agent has a spawn grant", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("exec_command", [], true), [
					"exec_command",
					"caller_ping",
					"subagent_done",
					"subagent",
					"subagent_resume",
					"subagent_kill",
				]);
			});
		});

		it("keeps spawning tools out of a narrowed tools list without a spawn grant", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("exec_command", ["subagent", "subagent_resume"], false), [
					"exec_command",
					"caller_ping",
					"subagent_done",
				]);
			});
		});

		it("lets deny-tools remove a granted spawning tool from the narrowed allowlist", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolAllowlistForTest("exec_command", ["subagent_resume"], true), [
					"exec_command",
					"caller_ping",
					"subagent_done",
					"subagent",
					"subagent_kill",
				]);
			});
		});

		it("passes granted spawning tools into narrowed --tools launch args", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.deepEqual(getSubagentToolLaunchArgsForTest("exec_command", [], true), [
					"--tools",
					"exec_command,caller_ping,subagent_done,subagent,subagent_resume,subagent_kill",
				]);
			});
		});

		it("keeps subagent_kill available so a spawning child can stop its own runs", () => {
			withSetTabTitleEnv(undefined, () => {
				assert.equal(getSubagentToolAllowlistForTest("exec_command", [], true).includes("subagent_kill"), true);
				assert.equal(getSubagentToolAllowlistForTest("exec_command", [], false).includes("subagent_kill"), false);
				assert.equal(
					getSubagentToolAllowlistForTest("exec_command", ["subagent_kill"], true).includes("subagent_kill"),
					false,
				);
			});
		});

		it("keeps non-requested built-ins out of narrowed child launch allowlists", () => {
			assert.deepEqual(getSubagentToolAllowlistForTest("bash").includes("edit"), false);
			assert.deepEqual(getSubagentToolAllowlistForTest("bash").includes("write"), false);
			assert.deepEqual(getSubagentToolAllowlistForTest(undefined), []);
		});

		it("maps omitted and all tools to default launch behavior", () => {
			assert.deepEqual(getSubagentToolLaunchArgsForTest(undefined), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("all"), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest(" all "), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("all", ["bash"]), ["--exclude-tools", "bash"]);
		});

		it("maps tools none to no built-in tools while preserving extension tools", () => {
			assert.deepEqual(getSubagentToolAllowlistForTest("none"), []);
			assert.deepEqual(getSubagentToolLaunchArgsForTest("none"), ["--no-builtin-tools"]);
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
				assert.deepEqual(getSubagentToolLaunchArgsForTest("bash", []), ["--tools", "bash,caller_ping,subagent_done"]);
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
				{
					content: [{ type: "text", text: "Sub-agent started." }],
					details: { status: "started" },
					terminate: true,
				},
				"Warning: edti may be a typo of edit.",
			);
			assert.equal((result as { terminate?: true }).terminate, true);
			assert.deepEqual((result as { details: unknown }).details, {
				status: "started",
			});
			const text = (result as { content: Array<{ type: string; text: string }> }).content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			assert.match(text, /Warning: edti may be a typo of edit\./);
			assert.match(text, /Sub-agent started\./);

			// No warning: result returned untouched, including terminate.
			const untouched = withToolWarningForTest(
				{
					content: [{ type: "text", text: "ok" }],
					details: {},
					terminate: true,
				},
				"",
			);
			assert.equal((untouched as { terminate?: true }).terminate, true);
		});

		it("preserves CLI-disabled built-ins while applying denied tool filters", () => {
			const allTools = [{ name: "read" }, { name: "bash" }, { name: "caller_ping" }];
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
			const allTools = [{ name: "read" }, { name: "bash" }, { name: "ask_user_question" }];
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
				const { applyDeniedTools } = installDeniedToolGuards(pi, false, (active, denied) => {
					changes.push({ active: [...active], denied: [...denied] });
				});

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

	describe("child spawn grant detection", () => {
		it("treats a positive child budget as a spawn grant", () => {
			assert.equal(isPreparedChildSpawningAllowedForTest(1), true);
		});

		it("treats a null budget or a missing spawn policy as no grant", () => {
			assert.equal(isPreparedChildSpawningAllowedForTest(null), false);
			assert.equal(isPreparedChildSpawningAllowedForTest(undefined), false);
		});
	});

	describe("spawning tool availability behind an extensions allowlist", () => {
		it("force-loads pi-subagents when an extensions list would drop it from a granted child", () => {
			assert.deepEqual(getExtensionLaunchArgsForTest(["npm:pi-fancy-footer"], "/tmp/subagent-done.ts", true), [
				"--no-extensions",
				"-e",
				"/tmp/subagent-done.ts",
				"-e",
				getSubagentsExtensionPathForTest(),
				"-e",
				"npm:pi-fancy-footer",
			]);
		});

		it("leaves the extension list alone for a child without a spawn grant", () => {
			assert.deepEqual(getExtensionLaunchArgsForTest(["npm:pi-fancy-footer"], "/tmp/subagent-done.ts", false), [
				"--no-extensions",
				"-e",
				"/tmp/subagent-done.ts",
				"-e",
				"npm:pi-fancy-footer",
			]);
		});

		it("does not force-load pi-subagents twice when the list already names it", () => {
			assert.deepEqual(getExtensionLaunchArgsForTest(["npm:pi-subagents"], "/tmp/subagent-done.ts", true), [
				"--no-extensions",
				"-e",
				"/tmp/subagent-done.ts",
				"-e",
				"npm:pi-subagents",
			]);
			assert.deepEqual(
				getExtensionLaunchArgsForTest(["/home/u/.pi/agent/extensions/pi-subagents/src/index.ts"], "/tmp/done.ts", true),
				["--no-extensions", "-e", "/tmp/done.ts", "-e", "/home/u/.pi/agent/extensions/pi-subagents/src/index.ts"],
			);
		});

		it("keeps inherited extensions untouched when the agent sets no extensions list", () => {
			assert.deepEqual(getExtensionLaunchArgsForTest(undefined, "/tmp/subagent-done.ts", true), [
				"-e",
				"/tmp/subagent-done.ts",
			]);
		});
	});
});
