import {
	assert,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	getSessionArtifactDir,
	subagentsExtension,
	buildSubagentSessionTitleForTest,
	getSubagentAgentOverrideErrorForTest,
	getSubagentAgentRequirementErrorForTest,
	getSubagentDisplayTitleForTest,
	getSubagentNameErrorForTest,
	getTerminalAssistantSummaryForTest,
	resetSubagentStateForTest,
	resolveEffectiveSessionModeForTest,
	resolveSubagentBlockingForTest,
	resolveSubagentConfigDir,
	resolveSubagentRuntimePathsForTest,
	seedSubagentSessionFileForTest,
	shouldReapStableTerminalSummaryForTest,
	writeSystemPromptArtifactForTest,
	createTestDir,
	resolveSubagentCwdForTest,
	SESSION_HEADER,
	MODEL_CHANGE,
} from "../support/index.ts";

describe("ambient agents and runtime paths", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("skips startup catalog injection for child or denied-spawning sessions", () => {
		const dir = createTestDir();
		const prevDenied = process.env.PI_DENY_TOOLS;
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\n---\n\nReviewer body.`,
		);

		const start = () => {
			const handlers = new Map<string, any>();
			const sent: any[] = [];
			subagentsExtension({
				on(event: string, handler: any) {
					handlers.set(event, handler);
				},
				registerCommand() {},
				registerMessageRenderer() {},
				registerTool() {},
				sendMessage(message: any) {
					sent.push(message);
				},
				getThinkingLevel: () => "low" as const,
			} as any);
			return { handlers, sent };
		};

		try {
			const child = start();
			child.handlers.get("session_start")(
				{ type: "session_start", reason: "startup" },
				{
					cwd: dir,
					hasUI: false,
					ui: { setWidget() {} },
					sessionManager: {
						getHeader: () => ({
							id: "child",
							type: "session",
							timestamp: "",
							cwd: dir,
							parentSession: "/tmp/root.jsonl",
						}),
					},
				},
			);
			assert.equal(child.sent.length, 0);

			process.env.PI_DENY_TOOLS = "subagent";
			const denied = start();
			denied.handlers.get("session_start")(
				{ type: "session_start", reason: "startup" },
				{
					cwd: dir,
					hasUI: false,
					ui: { setWidget() {} },
					sessionManager: {
						getHeader: () => ({
							id: "root",
							type: "session",
							timestamp: "",
							cwd: dir,
						}),
					},
				},
			);
			assert.equal(denied.sent.length, 0);
		} finally {
			if (prevDenied == null) delete process.env.PI_DENY_TOOLS;
			else process.env.PI_DENY_TOOLS = prevDenied;
		}
	});

	it("applies child session titles to pre-seeded session headers", () => {
		const previousTitle = process.env.PI_SUBAGENT_SESSION_TITLE;
		const previousDisabled = process.env.PI_SUBAGENT_DISABLE_SESSION_TITLES;
		const handlers = new Map<string, any>();
		const header: { name?: string } = {};
		let sessionName: string | undefined;
		try {
			process.env.PI_SUBAGENT_SESSION_TITLE = "[smoke agent] Fork title smoke";
			delete process.env.PI_SUBAGENT_DISABLE_SESSION_TITLES;
			subagentsExtension({
				on(event: string, handler: any) {
					handlers.set(event, handler);
				},
				registerCommand() {},
				registerMessageRenderer() {},
				registerTool() {},
				sendMessage() {},
				setSessionName(name: string) {
					sessionName = name;
				},
				getThinkingLevel: () => "low" as const,
			} as any);

			handlers.get("session_start")(
				{ type: "session_start", reason: "startup" },
				{
					cwd: process.cwd(),
					hasUI: false,
					ui: { setWidget() {} },
					sessionManager: {
						getHeader: () => header,
						getSessionName: () => undefined,
					},
				},
			);

			assert.equal(header.name, "[smoke agent] Fork title smoke");
			assert.equal(sessionName, "[smoke agent] Fork title smoke");
		} finally {
			if (previousTitle == null) delete process.env.PI_SUBAGENT_SESSION_TITLE;
			else process.env.PI_SUBAGENT_SESSION_TITLE = previousTitle;
			if (previousDisabled == null) delete process.env.PI_SUBAGENT_DISABLE_SESSION_TITLES;
			else process.env.PI_SUBAGENT_DISABLE_SESSION_TITLES = previousDisabled;
		}
	});

	it("rejects missing or unknown named agents", () => {
		const missing = getSubagentAgentRequirementErrorForTest(
			{ name: "No agent", task: "Work" },
			null,
		);
		assert.equal(missing?.details.error, "agent_required");

		const unknown = getSubagentAgentRequirementErrorForTest(
			{ name: "Unknown", task: "Work", agent: "does-not-exist" },
			null,
		);
		assert.equal(unknown?.details.error, "agent_not_found");
		assert.equal(unknown?.details.agent, "does-not-exist");
	});

	it("ignores frontmatter-governed call-time duplicates for named agents", () => {
		const defs = {
			path: "/tmp/reviewer.md",
			mode: "interactive" as const,
			blocking: false,
			cwd: "./agents/reviewer",
		};

		const override = getSubagentAgentOverrideErrorForTest(
			{
				agent: "reviewer",
				background: true,
				blocking: true,
				model: "gpt-x",
				systemPrompt: "override",
				skills: "debugger",
				tools: "bash",
				cwd: "packages/worker",
			},
			defs,
		);

		assert.equal(override, null);
	});

	it("allows redundant launch-time execution values that match named-agent frontmatter", () => {
		const defs = {
			path: "/tmp/reviewer.md",
			mode: "background" as const,
			blocking: false,
		};

		assert.equal(
			getSubagentAgentOverrideErrorForTest(
				{ agent: "reviewer", background: true, blocking: false },
				defs,
			),
			null,
		);
	});

	it("ignores launch-time fork overrides; only agent frontmatter controls session mode", () => {
		const defs = {
			path: "/tmp/reviewer.md",
			mode: "interactive" as const,
			blocking: false,
			sessionMode: "lineage-only" as const,
		};

		assert.equal(
			getSubagentAgentOverrideErrorForTest(
				{ agent: "reviewer", fork: true },
				defs,
			),
			null,
		);
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "reviewer" }, defs),
			"lineage-only",
		);
		assert.equal(
			resolveEffectiveSessionModeForTest(
				{ agent: "reviewer", fork: true },
				defs,
			),
			"lineage-only",
		);
	});

	it("ignores launch-time async/blocking; only agent frontmatter controls sync policy", () => {
		assert.equal(
			resolveSubagentBlockingForTest({ async: false }, { async: true }),
			false,
		);
		assert.equal(
			resolveSubagentBlockingForTest({ async: true }, { async: false }),
			true,
		);
		assert.equal(resolveSubagentBlockingForTest({ async: false }, null), false);
		assert.equal(resolveSubagentBlockingForTest({}, { async: false }), true);
		assert.equal(resolveSubagentBlockingForTest({}, { async: true }), false);
		assert.equal(resolveSubagentBlockingForTest({}, null), false);
		assert.equal(
			resolveSubagentBlockingForTest({ blocking: true }, { blocking: false }),
			false,
		);
		assert.equal(
			resolveSubagentBlockingForTest({ blocking: false }, { blocking: true }),
			true,
		);
		assert.equal(
			resolveSubagentBlockingForTest({ async: true }, { blocking: true }),
			true,
		);

		const blockingOverride = getSubagentAgentOverrideErrorForTest(
			{ agent: "reviewer", async: false },
			{ path: "/tmp/reviewer.md", mode: "interactive" },
		);
		assert.equal(blockingOverride, null);

		const harmlessAsync = getSubagentAgentOverrideErrorForTest(
			{ agent: "reviewer", async: true },
			{ path: "/tmp/reviewer.md", mode: "interactive", async: true },
		);
		assert.equal(harmlessAsync, null);
	});

	it("ignores named-agent duplicate fields before session checks", async () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\nmode: interactive\nblocking: false\n---\n\nReviewer body.`,
		);

		const tools = new Map<string, any>();
		const prevCwd = process.cwd();
		try {
			process.chdir(dir);
			subagentsExtension({
				on() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
				getThinkingLevel: () => "low" as const,
			} as any);

			const tool = tools.get("subagent");
			assert.ok(tool);
			await assert.rejects(
				() =>
					tool.execute(
						"call-1",
						{
							name: "worker-reviewer",
							task: "check",
							title: "Review worker package",
							agent: "reviewer",
							background: true,
							cwd: "packages/worker",
						},
						undefined,
						undefined,
						{
							cwd: dir,
							hasUI: false,
							ui: { setWidget() {} },
							sessionManager: { getSessionFile: () => null },
						},
					),
				{
					message:
						"Cannot launch lineage-only subagent: no parent session file. " +
						"Use session-mode: standalone in the agent frontmatter, " +
						"or start pi with a persistent session (--session or --session-dir).",
				},
			);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it("resolves relative cwd values against the provided base", () => {
		assert.equal(
			resolveSubagentCwdForTest("roles/tester", "/tmp/custom-agent-root"),
			"/tmp/custom-agent-root/roles/tester",
		);
		assert.equal(
			resolveSubagentCwdForTest("/tmp/already-absolute", "/tmp/base"),
			"/tmp/already-absolute",
		);
	});

	it("prefers a target project's .pi/agent dir for subagent config isolation", () => {
		const dir = createTestDir();
		const target = join(dir, "target");
		const localAgentDir = join(target, ".pi", "agent");
		mkdirSync(localAgentDir, { recursive: true });

		assert.equal(resolveSubagentConfigDir("target", dir), localAgentDir);
		assert.equal(resolveSubagentConfigDir("missing", dir), null);
		assert.equal(resolveSubagentConfigDir(null, target), localAgentDir);
	});

	it("stores child sessions under the child agent dir when cwd has its own .pi/agent", () => {
		const dir = createTestDir();
		const target = join(dir, "packages", "worker");
		const localAgentDir = join(target, ".pi", "agent");
		mkdirSync(localAgentDir, { recursive: true });

		const parentSessionDir = join(dir, "parent-sessions");
		const paths = resolveSubagentRuntimePathsForTest(
			{ cwd: "packages/worker" },
			null,
			dir,
			parentSessionDir,
		);
		assert.equal(paths.effectiveCwd, target);
		assert.equal(paths.localAgentConfigDir, localAgentDir);
		assert.equal(paths.effectiveAgentConfigDir, localAgentDir);
		assert.equal(paths.targetCwdForSession, target);
		assert.equal(
			paths.sessionDir,
			join(
				localAgentDir,
				"sessions",
				`--${target.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
			),
		);
	});

	it("falls back to the global agent dir for child sessions when no local config exists", () => {
		const dir = createTestDir();
		const globalAgentDir = join(dir, "global-agent");
		mkdirSync(globalAgentDir, { recursive: true });
		const original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = globalAgentDir;

		try {
			const parentSessionDir = join(dir, "parent-sessions");
			const paths = resolveSubagentRuntimePathsForTest(
				{ cwd: "missing-child" },
				null,
				dir,
				parentSessionDir,
			);
			assert.equal(paths.localAgentConfigDir, null);
			assert.equal(paths.effectiveAgentConfigDir, globalAgentDir);
			assert.equal(paths.targetCwdForSession, join(dir, "missing-child"));
			assert.equal(paths.sessionDir, parentSessionDir);
		} finally {
			if (original == null) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = original;
		}
	});

	it("writes system prompts to artifact files for CLI-safe routing", () => {
		const dir = createTestDir();
		const sessionId = "session-123";
		const systemPrompt = `You are a specialist.\n\nQuotes: ' " $HOME`;
		const artifactPath = writeSystemPromptArtifactForTest(
			"Spec Agent",
			systemPrompt,
			{
				cwd: dir,
				sessionManager: { getSessionId: () => sessionId },
			},
		);

		assert.equal(readFileSync(artifactPath, "utf8"), systemPrompt);
		assert.ok(
			artifactPath.startsWith(
				join(
					getSessionArtifactDir(dir, sessionId),
					"context",
					"spec-agent-sysprompt-",
				),
			),
		);
		assert.match(artifactPath, /\.md$/);
	});

	it("detects terminal assistant summaries only after final non-tool-use output", () => {
		assert.equal(
			getTerminalAssistantSummaryForTest([
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "DONE" }],
					},
				},
			] as any[]),
			"DONE",
		);

		assert.equal(
			getTerminalAssistantSummaryForTest([
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "toolUse",
						content: [{ type: "text", text: "Not final" }],
					},
				},
			] as any[]),
			null,
		);

		assert.equal(
			getTerminalAssistantSummaryForTest([
				{
					type: "message",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Done" }],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						content: [{ type: "text", text: "later" }],
					},
				},
			] as any[]),
			null,
		);
	});

	it("only reaps stable terminal summaries for auto-exit background agents", () => {
		assert.equal(
			shouldReapStableTerminalSummaryForTest({ autoExit: true }),
			true,
		);
		assert.equal(
			shouldReapStableTerminalSummaryForTest({ autoExit: false }),
			false,
		);
		assert.equal(shouldReapStableTerminalSummaryForTest({}), false);
	});

	it("validates lower-kebab scope-role subagent names", () => {
		for (const name of ["auth-scout", "diff-reviewer", "session-resume-tester", "api-v2-fixer"]) {
			assert.equal(getSubagentNameErrorForTest(name), null);
		}

		for (const name of [
			undefined,
			"Auth Scout",
			"react_components_ui",
			"react-components-ui-extra-long-tail",
			"this-name-is-way-too-long-for-a-subagent-handle",
			" scout-auth",
		]) {
			assert.match(getSubagentNameErrorForTest(name) ?? "", /Error: subagent name|Error: name is required/);
		}
	});

	it("builds deterministic child session titles", () => {
		assert.equal(
			buildSubagentSessionTitleForTest({
				name: "Auth Scout",
				agent: "scout",
				title: "Auth flow reconnaissance",
				task: "Explore web app's auth\nReturn a concise report.",
			}),
			"[scout agent] Auth flow reconnaissance",
		);

		assert.equal(
			buildSubagentSessionTitleForTest({
				name: "Reviewer",
				title: "Local diff bug review",
				task: "Objective: Review the local diff for high-confidence bugs and summarize findings in detail",
			}),
			"[Reviewer agent] Local diff bug review",
		);

		assert.equal(
			getSubagentDisplayTitleForTest({
				title: "Fix Login Button On Mobile!!!",
				task: "Task: respond with ok",
			}),
			"Fix login button on mobile",
		);
	});

	it("pre-creates lineage-only child session file with header", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(parent, `${JSON.stringify(SESSION_HEADER)}\n`);

		seedSubagentSessionFileForTest("lineage-only", parent, child, dir);

		assert.equal(existsSync(child), true);
		const entries = JSON.parse(readFileSync(child, "utf8").split("\n")[0]);
		assert.equal(entries.type, "session");
		assert.equal(entries.parentSession, parent);
	});

	it("writes generated child session titles when seeding session headers", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(parent, `${JSON.stringify(SESSION_HEADER)}\n`);

		seedSubagentSessionFileForTest("lineage-only", parent, child, dir, {
			sessionName: "[reviewer agent] Review sync resume blocking fix",
		});

		const header = JSON.parse(readFileSync(child, "utf8").split("\n")[0]);
		assert.equal(header.name, "[reviewer agent] Review sync resume blocking fix");
		assert.equal(header.parentSession, parent);
	});

	it("writes generated child session titles into forked session headers", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(
			parent,
			`${[SESSION_HEADER, MODEL_CHANGE].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);

		seedSubagentSessionFileForTest("fork", parent, child, dir, {
			sessionName: "[reviewer agent] Gilfoyle-level review of all changes",
		});

		const header = JSON.parse(readFileSync(child, "utf8").split("\n")[0]);
		assert.equal(header.name, "[reviewer agent] Gilfoyle-level review of all changes");
		assert.equal(header.parentSession, parent);
	});

	it("seeds a fork session even when child context window is unknown", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(
			parent,
			`${[SESSION_HEADER, MODEL_CHANGE].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);

		// No context window provided — should succeed and produce a valid child session.
		seedSubagentSessionFileForTest("fork", parent, child, dir);
		const header = JSON.parse(readFileSync(child, "utf8").split("\n")[0]);
		assert.equal(header.parentSession, parent);
	});

});