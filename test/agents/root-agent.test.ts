import {
	assert,
	describe,
	it,
	buildRootSystemPrompt,
	getRootAgentDiagnostic,
	resolveRootAgentName,
	resolveRootModel,
	resolveRootToolNames,
	subagentsExtension,
	createTestDir,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";

describe("named root agent", () => {
	it("applies PI_MAIN_AGENT to the existing session without launching a child", async () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "root.md"),
			"---\nname: root\nspawning: false\nsystem-prompt: append\n---\n\nYou are the named root.",
		);
		process.env.PI_CODING_AGENT_DIR = configDir;
		process.env.PI_MAIN_AGENT = "root";

		const handlers = new Map<string, any>();
		let registeredFlag: { name: string; type: string } | undefined;
		let activeTools = ["read", "bash", "subagent", "subagent_resume"];
		const tools = activeTools.map((name) => ({ name }));
		subagentsExtension({
			registerFlag(name: string, options: { type: string }) { registeredFlag = { name, type: options.type }; },
			getFlag: () => "root",
			on(event: string, handler: any) { handlers.set(event, handler); },
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
			getAllTools: () => tools,
			getActiveTools: () => activeTools,
			setActiveTools: (next: string[]) => { activeTools = next; },
		} as any);

		const notifications: string[] = [];
		await handlers.get("session_start")(
			{ type: "session_start", reason: "startup" },
			{
				cwd: dir,
				hasUI: false,
				ui: { setWidget() {}, notify(message: string) { notifications.push(message); } },
				sessionManager: { getHeader: () => undefined },
				modelRegistry: { getAvailable: () => [] },
				model: undefined,
			},
		);

		assert.equal(process.env.PI_MAIN_AGENT, "root");
		assert.deepEqual(registeredFlag, { name: "agent", type: "string" });
		assert.deepEqual(notifications, []);
		const result = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "Pi base\n\nAPPEND_SYSTEM",
			systemPromptOptions: { appendSystemPrompt: "APPEND_SYSTEM" },
		});
		assert.equal(result.systemPrompt, "Pi base\n\nAPPEND_SYSTEM\n\nYou are the named root.");
		assert.deepEqual(activeTools, ["read", "bash"]);
		assert.deepEqual(notifications, []);
	});
	it("prefers --agent over PI_MAIN_AGENT and ignores blank values", () => {
		assert.equal(resolveRootAgentName("reviewer", "scout"), "reviewer");
		assert.equal(resolveRootAgentName("  reviewer  ", "scout"), "reviewer");
		assert.equal(resolveRootAgentName("", "scout"), "scout");
		assert.equal(resolveRootAgentName(undefined, "  scout  "), "scout");
		assert.equal(resolveRootAgentName(undefined, ""), undefined);
		assert.equal(resolveRootAgentName(false, ""), undefined);
	});

	it("applies an explicit root tool allowlist and deny-list deterministically", () => {
		const all = ["read", "bash", "write", "subagent", "subagent_resume", "custom"];
		assert.deepEqual(
			resolveRootToolNames(all, ["read", "bash", "subagent", "custom"], {
				spawning: false,
			}),
			["read", "bash", "custom"],
		);
		assert.deepEqual(
			resolveRootToolNames(all, ["read"], {
				spawning: true,
				denyTools: "bash, subagent_resume",
			}),
			["read", "subagent"],
		);
		assert.deepEqual(
			resolveRootToolNames(all, ["read", "bash"], {
				spawning: false,
				tools: "bash, custom, missing",
				denyTools: "custom",
			}),
			["bash"],
		);
		assert.deepEqual(
			resolveRootToolNames(all, ["read"], { spawning: true, tools: "none" }),
			[],
		);
		assert.deepEqual(
			resolveRootToolNames(all, ["read"], { spawning: false, tools: "all" }),
			["read", "bash", "write", "custom"],
		);
	});

	it("resolves a named model and thinking level through the available registry", () => {
		const model = { provider: "test", id: "model" } as any;
		const resolved = resolveRootModel(
			{ model: "test/model", thinking: "high" },
			{ getAvailable: () => [model] },
		);
		assert.equal(resolved?.model, model);
		assert.equal(resolved?.thinking, "high");
		assert.equal(resolved?.modelRef, "test/model:high");
	});

	it("keeps APPEND_SYSTEM content when replacing the root prompt", () => {
		const replaced = buildRootSystemPrompt(
			"Pi base prompt\n\nExisting append",
			"Existing append",
			{ body: "Named root identity", systemPromptMode: "replace" },
		);
		assert.equal(replaced, "Named root identity\n\nExisting append");

		const appended = buildRootSystemPrompt(
			"Pi base prompt\n\nExisting append",
			"Existing append",
			{ body: "Named root identity", systemPromptMode: "append" },
		);
		assert.equal(
			appended,
			"Pi base prompt\n\nExisting append\n\nNamed root identity",
		);
	});

	it("injects skill text without changing the prompt mode", () => {
		const prompt = buildRootSystemPrompt(
			"Base",
			undefined,
			{ body: "Identity", systemPromptMode: "replace" },
			"<skill name=\"review\">Instructions</skill>",
		);
		assert.equal(
			prompt,
			"Identity\n\n<skill name=\"review\">Instructions</skill>",
		);
	});

	it("documents safe fallback for an unknown root agent", () => {
		assert.match(
			getRootAgentDiagnostic("missing", "/tmp/agent/agents"),
			/Named root agent "missing" was not found.*normal Pi agent.*PI_MAIN_AGENT/,
		);
	});
});
