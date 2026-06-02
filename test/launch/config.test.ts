import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	buildPersistedSubagentLaunchMetadataForTest,
	buildResumePiArgsForTest,
	buildShellChangeDirectoryPrefixForTest,
	buildSkillLaunchPlanForTest,
	getFlagsLaunchArgs,
	getSubagentToolLaunchArgsForTest,
	getBaseSubagentEnvVarsForTest,
	getNoSessionSeedModeForTest,
	getPiInvocationForTest,
	getPiShellPartsForTest,
	getPersistedSessionParityArgsForTest,
	getPreparedSessionLaunchArgsForTest,
	getResumeCwdForTest,
	getSubagentChildProcessEnvForTest,
	loadAgentDefaults,
	readSubagentLaunchMetadataForTest,
	resetSubagentStateForTest,
	resolveAvailableModelRefForTest,
	resolveResumeLaunchMetadataForInvocationForTest,
	resolveResumeLaunchMetadataForTest,
	resolveSubagentBlockingForTest,
	resolveSubagentNoContextFilesForTest,
	resolveSubagentNoSessionForTest,
	writeSubagentLaunchMetadataEntryForTest,
	writeSubagentModelStateEntriesForTest,
	getEntries,
	createTestDir,
	createSessionFile,
	enforceAgentFrontmatterForTest,
	getAgentConfigDirForTest,
	isInitialPromptInvocationForTest,
	isOneShotPromptInvocationForTest,
	shouldForceSynchronousLaunchForTest,
} from "../support/index.ts";

describe("agent launch configuration", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("uses PI_CODING_AGENT_DIR for the global agent config root", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent-root";
		assert.equal(getAgentConfigDirForTest(), "/tmp/custom-agent-root");
	});

	it("parses allow-model-override frontmatter", () => {
		const dir = createTestDir();
		mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "agents", "reviewer.md"),
			"---\nname: reviewer\nmodel: provider/default\nallow-model-override: true\n---\nReview things.",
		);

		const defs = loadAgentDefaults("reviewer", undefined, dir);
		assert.equal(defs?.allowModelOverride, true);
	});

	it("allows launch model override unless agent opts out", () => {
		const params = {
			name: "code-review",
			task: "review",
			title: "Code review",
			agent: "reviewer",
			model: "provider/requested:high",
		};

		assert.equal(
			enforceAgentFrontmatterForTest(params, { model: "provider/default" }).model,
			"provider/requested:high",
		);
		assert.equal(
			enforceAgentFrontmatterForTest(params, {
				model: "provider/default",
				allowModelOverride: false,
			}).model,
			undefined,
		);
	});

	it("persists effective launch model override metadata", () => {
		const metadata = buildPersistedSubagentLaunchMetadataForTest(
			{
				agentDefs: {},
				effectiveModel: "provider/requested",
				effectiveThinking: "high",
				effectiveModelRef: "provider/requested:high",
				runtimePaths: { effectiveAgentConfigDir: "/tmp", targetCwdForSession: "/tmp" },
				denySet: new Set(),
				identity: "reviewer",
				identityInSystemPrompt: false,
			} as never,
			{
				name: "code-review",
				task: "review",
				title: "Code review",
				agent: "reviewer",
				model: "provider/requested:high",
			},
			"background",
			"lineage-only",
			true,
		);

		assert.equal(metadata.allowModelOverride, true);
		assert.equal(metadata.modelSource, "launch-override");
		assert.equal(metadata.requestedModelOverride, "provider/requested:high");
		assert.equal(metadata.modelRef, "provider/requested:high");
	});

	it("writes native model and thinking state entries for effective subagent model", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);

		writeSubagentModelStateEntriesForTest(sessionFile, {
			model: "zai-messages/glm-5-turbo",
			thinking: "off",
		});

		const entries = getEntries(sessionFile) as Array<Record<string, unknown>>;
		assert.equal(entries.at(-2)?.type, "model_change");
		assert.equal(entries.at(-2)?.provider, "zai-messages");
		assert.equal(entries.at(-2)?.modelId, "glm-5-turbo");
		assert.equal(entries.at(-1)?.type, "thinking_level_change");
		assert.equal(entries.at(-1)?.thinkingLevel, "off");
		assert.equal(entries.at(-1)?.parentId, entries.at(-2)?.id);
	});

	it("resolves resume model override unless launch metadata opts out", async () => {
		const base = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "code-review",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "continue" as const,
			async: true,
			model: "provider/default",
			thinking: "low",
			modelRef: "provider/default:low",
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};

		const ignored = resolveResumeLaunchMetadataForInvocationForTest(
			{ ...base, allowModelOverride: false },
			"provider/requested:high",
		);
		assert.equal(ignored?.modelRef, "provider/default:low");
		assert.equal(ignored?.ignoredModelOverride, "provider/requested:high");

		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			base,
			"provider/requested:high",
		);
		assert.equal(overridden?.modelRef, "provider/requested:high");
		assert.equal(overridden?.modelSource, "resume-override");

		assert.deepEqual(await getPersistedSessionParityArgsForTest(overridden), [
			"--model",
			"provider/requested:high",
		]);
	});

	it("clears stale thinking when resume override drops unsupported inherited thinking", async () => {
		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "scout",
				mode: "background",
				sessionMode: "fork",
				parentClosePolicy: "terminate",
				async: true,
				model: "zai-messages/glm-5.1",
				thinking: "high",
				modelRef: "zai-messages/glm-5.1",
				allowModelOverride: true,
				modelSource: "resume-override",
				requestedModelOverride: "zai-messages/glm-5.1",
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5-turbo",
			{
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5.1", thinkingLevelMap: { high: "high" } },
					{ provider: "zai-messages", id: "glm-5-turbo", thinkingLevelMap: { high: null } },
				],
			},
		);

		assert.equal(overridden?.model, "zai-messages/glm-5-turbo");
		assert.equal(overridden?.thinking, undefined);
		assert.equal(overridden?.modelRef, "zai-messages/glm-5-turbo");
		assert.deepEqual(await getPersistedSessionParityArgsForTest(overridden), [
			"--model",
			"zai-messages/glm-5-turbo",
		]);
	});

	it("applies explicit resume thinking override when model string omits thinking", async () => {
		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "scout",
				mode: "background",
				sessionMode: "fork",
				parentClosePolicy: "terminate",
				async: true,
				model: "openai-rift/gpt-5.4-mini",
				thinking: "high",
				modelRef: "openai-rift/gpt-5.4-mini:high",
				allowModelOverride: true,
				modelSource: "agent",
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5-turbo",
			{
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5-turbo", thinkingLevelMap: { medium: "medium" } },
				],
			},
			"off",
		);

		assert.equal(overridden?.modelRef, "zai-messages/glm-5-turbo:off");
		assert.equal(overridden?.thinking, "off");
		assert.equal(overridden?.requestedThinkingOverride, "off");
		assert.deepEqual(await getPersistedSessionParityArgsForTest(overridden), [
			"--model",
			"zai-messages/glm-5-turbo:off",
		]);
	});

	it("records ignored model and thinking overrides separately", () => {
		const metadata = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "scout",
				mode: "background",
				sessionMode: "lineage-only",
				parentClosePolicy: "terminate",
				async: true,
				model: "zai-messages/glm-5.1",
				modelRef: "zai-messages/glm-5.1",
				allowModelOverride: false,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5-turbo",
			undefined,
			"off",
		);

		assert.equal(metadata?.modelRef, "zai-messages/glm-5.1");
		assert.equal(metadata?.ignoredModelOverride, "zai-messages/glm-5-turbo");
		assert.equal(metadata?.ignoredThinkingOverride, "off");
	});

	it("rejects thinking-only resume overrides without a persisted model", () => {
		assert.throws(
			() => resolveResumeLaunchMetadataForInvocationForTest(
				{
					version: 1,
					timestamp: "2026-05-08T00:00:00.000Z",
					name: "legacy",
					mode: "background",
					sessionMode: "lineage-only",
					parentClosePolicy: "terminate",
					async: true,
					allowModelOverride: true,
					denyTools: [],
					noContextFiles: false,
					noSession: false,
					agentConfigDir: "/tmp",
					cwd: "/tmp",
					boundarySystemPrompt: true,
				},
				undefined,
				undefined,
				"off",
			),
			/Cannot apply thinking override without a persisted model/,
		);
	});

	it("validates model override names and drops unsupported inherited thinking", () => {
		assert.deepEqual(
			resolveAvailableModelRefForTest("glm-5.1", "low", false, "zai-messages/glm-5-turbo"),
			{ model: "zai-messages/glm-5.1", thinking: "low" },
		);

		assert.throws(
			() => resolveAvailableModelRefForTest("zai-messages/glm-5-turbo", "high", true),
			/does not support thinking level 'high'/,
		);
		assert.throws(
			() => resolveAvailableModelRefForTest("missing-model", undefined, false),
			/Unknown model override 'missing-model'/,
		);
	});

	it("forces synchronous child launches for one-shot and startup-prompt parent invocations", () => {
		const printArgv = ["node", "pi", "-p", "task"];
		const startupPromptArgv = ["node", "pi", "--model", "deepseek", "task"];
		assert.equal(isOneShotPromptInvocationForTest(printArgv), true);
		assert.equal(isOneShotPromptInvocationForTest(["node", "pi", "--print", "task"]), true);
		assert.equal(isOneShotPromptInvocationForTest(["node", "pi", "--mode", "json", "task"]), true);
		assert.equal(isOneShotPromptInvocationForTest(startupPromptArgv), false);
		assert.equal(isInitialPromptInvocationForTest(startupPromptArgv), true);
		assert.equal(isInitialPromptInvocationForTest(["node", "pi"]), false);
		assert.equal(shouldForceSynchronousLaunchForTest(true, printArgv), true);
		assert.equal(shouldForceSynchronousLaunchForTest(true, startupPromptArgv), true);
		assert.equal(shouldForceSynchronousLaunchForTest(false, ["node", "pi", "task"]), true);
	});

	it("parses getFlagsLaunchArgs from a flags string", () => {
		assert.deepEqual(getFlagsLaunchArgs("--plan"), ["--plan"]);
		assert.deepEqual(getFlagsLaunchArgs("--plan --foo bar"), [
			"--plan",
			"--foo",
			"bar",
		]);
	});

	it("returns empty array for undefined, empty, or whitespace-only flags", () => {
		assert.deepEqual(getFlagsLaunchArgs(undefined), []);
		assert.deepEqual(getFlagsLaunchArgs(""), []);
		assert.deepEqual(getFlagsLaunchArgs("   "), []);
	});

	it("handles quoted flag values via parseCommandWords", () => {
		assert.deepEqual(getFlagsLaunchArgs("--plan 'arg with spaces'"), [
			"--plan",
			"arg with spaces",
		]);
	});

	it("builds no skill launch args when skills are all", async () => {
		const dir = createTestDir();
		assert.deepEqual((await buildSkillLaunchPlanForTest("all", undefined, dir)).launchArgs, []);
		assert.deepEqual((await buildSkillLaunchPlanForTest(undefined, undefined, dir)).launchArgs, []);
	});

	it("builds --no-skills when skills are none", async () => {
		const dir = createTestDir();
		assert.deepEqual((await buildSkillLaunchPlanForTest("none", undefined, dir)).launchArgs, [
			"--no-skills",
		]);
	});

	it("resolves multiple skill names to explicit skill paths", async () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const projectSkillDir = join(dir, ".pi", "skills", "pua");
		const globalSkillDir = join(configDir, "skills", "torpathy");
		mkdirSync(projectSkillDir, { recursive: true });
		mkdirSync(globalSkillDir, { recursive: true });
		writeFileSync(
			join(projectSkillDir, "SKILL.md"),
			"---\nname: pua\ndescription: Debug stubborn failures.\n---\n\n# PUA",
		);
		writeFileSync(
			join(globalSkillDir, "SKILL.md"),
			"---\nname: torpathy\ndescription: Decide where fixes belong.\n---\n\n# Torpathy",
		);

		const plan = await buildSkillLaunchPlanForTest(
			"pua, torpathy",
			"pua, torpathy",
			dir,
			configDir,
		);

		assert.deepEqual(plan.injectNames, ["pua", "torpathy"]);
		assert.deepEqual(plan.launchArgs, [
			"--no-skills",
			"--skill",
			join(projectSkillDir, "SKILL.md"),
			"--skill",
			join(globalSkillDir, "SKILL.md"),
		]);
	});

	it("resolves extension-package skills by name", async () => {
		const dir = createTestDir();
		const packageDir = join(dir, "skill-package");
		const extensionDir = join(packageDir, "extensions");
		const skillDir = join(packageDir, "skills", "pkg-skill");
		mkdirSync(extensionDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "skill-package",
				pi: { extensions: ["./extensions"], skills: ["./skills"] },
			}),
		);
		writeFileSync(join(extensionDir, "index.ts"), "export default function extension() {}\n");
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: pkg-skill\ndescription: Packaged skill.\n---\n\n# Packaged Skill",
		);

		const plan = await buildSkillLaunchPlanForTest(
			"pkg-skill",
			"pkg-skill",
			dir,
			undefined,
			[packageDir],
		);

		assert.deepEqual(plan.injectNames, ["pkg-skill"]);
		assert.deepEqual(plan.launchArgs, [
			"--no-skills",
			"--skill",
			join(skillDir, "SKILL.md"),
		]);
	});

	it("resolves project .agents skills by name", async () => {
		const dir = createTestDir();
		const skillDir = join(dir, ".agents", "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: review\ndescription: Review changes.\n---\n\n# Review",
		);

		const plan = await buildSkillLaunchPlanForTest("review", undefined, dir);

		assert.deepEqual(plan.launchArgs, [
			"--no-skills",
			"--skill",
			join(skillDir, "SKILL.md"),
		]);
	});

	it("rejects injecting a skill outside the availability list", async () => {
		const dir = createTestDir();
		const skillDir = join(dir, ".pi", "skills", "pua");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: pua\ndescription: Debug stubborn failures.\n---\n\n# PUA",
		);

		await assert.rejects(
			() => buildSkillLaunchPlanForTest("pua", "torpathy", dir),
			/Cannot inject unavailable skill: torpathy/,
		);
	});

	it("passes flags through getPiInvocation for background children", () => {
		const args = ["-p", "--session", "/tmp/test.jsonl", "--flags-injected"];
		const invocation = getPiInvocationForTest(args);
		assert.ok(
			invocation.args.includes("--flags-injected"),
			"flags should appear in pi invocation args",
		);
	});

	it("shell-escapes flags in getPiShellParts for interactive children", () => {
		const parts = getPiShellPartsForTest([
			"--session",
			"/tmp/s.jsonl",
			"--custom-flag",
		]);
		assert.ok(
			parts.join(" ").includes("--custom-flag"),
			"custom flag should be in shell parts",
		);
	});

	it("preserves the default launcher when no subagent command override is set", () => {
		delete process.env.PI_SUBAGENT_PI_COMMAND;
		delete process.env.PI_PACKAGE_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		const invocation = getPiInvocationForTest([
			"--session",
			"/tmp/session.jsonl",
		]);
		assert.equal(invocation.command, process.execPath);
		assert.deepEqual(invocation.args.slice(-2), [
			"--session",
			"/tmp/session.jsonl",
		]);
	});

	it("uses PI_SUBAGENT_PI_COMMAND as an opt-in wrapper for child pi launches", () => {
		process.env.PI_SUBAGENT_PI_COMMAND = "wrapper pi";
		assert.deepEqual(
			getPiInvocationForTest(["--session", "/tmp/session.jsonl"]),
			{
				command: "wrapper",
				args: ["pi", "--session", "/tmp/session.jsonl"],
			},
		);
		assert.deepEqual(
			getPiShellPartsForTest(["--session", "/tmp/with space.jsonl"]),
			["'wrapper'", "'pi'", "'--session'", "'/tmp/with space.jsonl'"],
		);
	});

	it("parses quoted PI_SUBAGENT_PI_COMMAND values", () => {
		process.env.PI_SUBAGENT_PI_COMMAND = "'/opt/wrapper bin/pi-wrapper' pi";
		assert.deepEqual(
			getPiInvocationForTest(["--session", "/tmp/session.jsonl"]),
			{
				command: "/opt/wrapper bin/pi-wrapper",
				args: ["pi", "--session", "/tmp/session.jsonl"],
			},
		);
	});

	it("preserves child process environment while applying launch vars", () => {
		process.env.PI_PACKAGE_DIR = "/tmp/pi-package";
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
		const env = getSubagentChildProcessEnvForTest(
			{ command: "pi", args: [] },
			{ PI_SUBAGENT_NAME: "x" },
		);
		assert.equal(env.PI_PACKAGE_DIR, "/tmp/pi-package");
		assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/pi-agent");
		assert.equal(env.PI_SUBAGENT_NAME, "x");
	});

	it("lets explicit child config override inherited config", () => {
		process.env.PI_PACKAGE_DIR = "/tmp/pi-package";
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
		const env = getSubagentChildProcessEnvForTest(
			{ command: "pi", args: [] },
			{ PI_CODING_AGENT_DIR: "/tmp/project/.pi/agent", PI_SUBAGENT_NAME: "x" },
		);
		assert.equal(env.PI_PACKAGE_DIR, "/tmp/pi-package");
		assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/project/.pi/agent");
		assert.equal(env.PI_SUBAGENT_NAME, "x");
	});

	it("clears inherited package-dir override for child launches", () => {
		process.env.PI_PACKAGE_DIR = "/tmp/pi-package";
		const env = getBaseSubagentEnvVarsForTest(null);

		assert.equal(env.PI_PACKAGE_DIR, "");
	});

	it("loads global agent defaults from PI_CODING_AGENT_DIR and records cwd base", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nsystem-prompt: append\ncwd: ./roles/tester\nmode: background\nasync: false\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.systemPromptMode, "append");
		assert.equal(defs?.cwd, "./roles/tester");
		assert.equal(defs?.cwdBase, configDir);
		assert.equal(defs?.mode, "background");
		assert.equal(defs?.async, false);
		assert.equal(resolveSubagentBlockingForTest({}, defs), true);
	});

	it("defaults context-file injection to on and can disable it in agent frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nno-context-files: true\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.noContextFiles, true);
		assert.equal(resolveSubagentNoContextFilesForTest(defs), true);
		assert.equal(resolveSubagentNoContextFilesForTest(null), false);

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\n---\n\nYou are the tester.`,
		);

		const defaults = loadAgentDefaults("tester");
		assert.equal(defaults?.noContextFiles, undefined);
		assert.equal(resolveSubagentNoContextFilesForTest(defaults), false);
	});

	it("defaults session storage on and can disable it in agent frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nno-session: true\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.noSession, true);
		assert.equal(resolveSubagentNoSessionForTest(defs), true);
		assert.equal(resolveSubagentNoSessionForTest(null), false);
		assert.deepEqual(getPreparedSessionLaunchArgsForTest(defs), [
			"--session",
			"child.jsonl",
			"--no-session",
		]);

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\n---\n\nYou are the tester.`,
		);

		const defaults = loadAgentDefaults("tester");
		assert.equal(defaults?.noSession, undefined);
		assert.equal(resolveSubagentNoSessionForTest(defaults), false);
		assert.deepEqual(getPreparedSessionLaunchArgsForTest(defaults), [
			"--session",
			"child.jsonl",
		]);
	});

	it("adds native session names for prepared child launches", () => {
		assert.deepEqual(getPreparedSessionLaunchArgsForTest({
			subagentSessionFile: "child.jsonl",
			sessionTitle: "[reviewer agent] Code review",
			agentDefs: {},
		}), [
			"--session",
			"child.jsonl",
			"--name",
			"[reviewer agent] Code review",
		]);
		assert.deepEqual(getPreparedSessionLaunchArgsForTest({
			subagentSessionFile: "child.jsonl",
			sessionTitle: "[reviewer agent] Disposable review",
			agentDefs: { noSession: true },
		}), [
			"--session",
			"child.jsonl",
			"--no-session",
			"--name",
			"[reviewer agent] Disposable review",
		]);
	});

	it("adds native exclude-tools for the resolved deny set", async () => {
		assert.deepEqual(getSubagentToolLaunchArgsForTest("all", ["subagent", "bash"]), [
			"--exclude-tools",
			"subagent,bash",
		]);
		assert.deepEqual(getSubagentToolLaunchArgsForTest("none", ["read", "bash", "subagent"]), [
			"--no-builtin-tools",
			"--exclude-tools",
			"read,bash,subagent",
		]);
		assert.deepEqual(getSubagentToolLaunchArgsForTest("read,grep", ["grep", "subagent"]), [
			"--tools",
			"read,grep,caller_ping,subagent_done,set_tab_title",
			"--exclude-tools",
			"grep,subagent",
		]);
		assert.deepEqual(getSubagentToolLaunchArgsForTest("bash", ["bash"]), [
			"--tools",
			"bash,caller_ping,subagent_done,set_tab_title",
			"--exclude-tools",
			"bash",
		]);
	});

	it("parses flags frontmatter and makes it available on AgentDefaults", () => {
		const dir = createTestDir();
		const agentsDir = join(dir, ".pi", "agents");
		const configDir = join(dir, "config");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "tester.md"),
			`---\nname: tester\nflags: --plan --foo bar\n---\n\nTester body.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.flags, "--plan --foo bar");

		// Clean up
		process.env.PI_CODING_AGENT_DIR = "/tmp";
	});

	it("returns undefined for agents without flags", () => {
		const dir = createTestDir();
		const configDir = join(dir, "config");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "tester.md"),
			`---\nname: tester\nauto-exit: true\n---\n\nTester body.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.flags, undefined);

		process.env.PI_CODING_AGENT_DIR = "/tmp";
	});

	it("launches no-session children through an ephemeral session path", () => {
		assert.deepEqual(
			getPreparedSessionLaunchArgsForTest({
				noSession: true,
				sessionMode: "fork",
			}),
			["--session", "child.jsonl", "--no-session"],
		);
		assert.deepEqual(
			getPreparedSessionLaunchArgsForTest({
				noSession: true,
				sessionMode: "lineage-only",
			}),
			["--session", "child.jsonl", "--no-session"],
		);
		assert.equal(getNoSessionSeedModeForTest("standalone"), null);
		assert.equal(getNoSessionSeedModeForTest("fork"), "fork");
		assert.equal(getNoSessionSeedModeForTest("lineage-only"), "fork");
	});

	it("restores persisted resume cwd without putting task text in CLI argv", () => {
		const weirdTask =
			"--help @not-a-file ' \" ` ; | && $(echo bad) $HOME\nこんにちは 🚀";
		assert.deepEqual(buildResumePiArgsForTest("child.jsonl", "background"), [
			"-p",
			"--session",
			"child.jsonl",
		]);
		assert.deepEqual(buildResumePiArgsForTest("child.jsonl", "interactive"), [
			"--session",
			"child.jsonl",
		]);
		assert.equal(
			buildResumePiArgsForTest("child.jsonl", "background").includes(weirdTask),
			false,
		);
		assert.equal(
			buildResumePiArgsForTest("child.jsonl", "interactive").includes(
				weirdTask,
			),
			false,
		);

		const metadata = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "resumed-child",
			mode: "background" as const,
			sessionMode: "fork" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp/agent",
			cwd: "/tmp/child cwd/with spaces",
			boundarySystemPrompt: true,
		};
		assert.equal(getResumeCwdForTest(metadata), "/tmp/child cwd/with spaces");
		assert.equal(
			buildShellChangeDirectoryPrefixForTest(metadata.cwd),
			"cd '/tmp/child cwd/with spaces' && ",
		);
	});

	it("infers resume mode from parent launch metadata", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(
			parent,
			`${[
				JSON.stringify({
					type: "session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "subagent_started",
					details: {
						id: "child-1",
						name: "Worker",
						agent: "bg-mode",
						mode: "background",
						sessionFile: child,
						parentClosePolicy: "continue",
						autoExit: true,
					},
				}),
			].join("\n")}\n`,
		);
		writeFileSync(
			child,
			`${JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: dir, parentSession: parent })}\n`,
		);

		assert.deepEqual(resolveResumeLaunchMetadataForTest(child), {
			mode: "background",
			modeSource: "metadata",
			agent: "bg-mode",
			name: "Worker",
			autoExit: true,
			parentClosePolicy: "continue",
			blocking: undefined,
			async: undefined,
		});
		assert.deepEqual(resolveResumeLaunchMetadataForTest(child, "interactive"), {
			mode: "interactive",
			modeSource: "explicit",
		});
	});

	it("falls back to interactive resume mode when metadata is unavailable", () => {
		const dir = createTestDir();
		const child = createSessionFile(dir, [
			{ type: "session", timestamp: new Date().toISOString(), cwd: dir },
		]);
		assert.deepEqual(resolveResumeLaunchMetadataForTest(child), {
			mode: "interactive",
			modeSource: "fallback",
		});
	});

	it("prefers direct launch metadata when inferring resume mode", async () => {
		const dir = createTestDir();
		const child = join(dir, "direct-metadata-child.jsonl");
		await writeSubagentLaunchMetadataEntryForTest(child, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "direct-child",
			mode: "background",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: true,
		});

		assert.deepEqual(resolveResumeLaunchMetadataForTest(child), {
			mode: "background",
			modeSource: "metadata",
			agent: undefined,
			name: "direct-child",
			autoExit: true,
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
		});
	});

	it("persists launch metadata as non-message JSONL custom state even for missing session files", async () => {
		const dir = createTestDir();
		const child = join(dir, "standalone-child.jsonl");
		await writeSubagentLaunchMetadataEntryForTest(child, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "standalone-child",
			mode: "background",
			sessionMode: "standalone",
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
			modelRef: "nahcrof/kimi-k2.6-precision",
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			systemPromptMode: "replace",
			systemPrompt: "STANDALONE_CHILD_PROMPT_TOKEN",
			boundarySystemPrompt: false,
		});

		const entries = getEntries(child) as any[];
		assert.equal(entries[0].type, "session");
		assert.equal(entries[1].type, "custom");
		assert.equal(entries[1].customType, "pi-subagents_launch_metadata");
		assert.equal(JSON.stringify(entries).includes("custom_message"), false);
		assert.equal(
			readSubagentLaunchMetadataForTest(child)?.systemPrompt,
			"STANDALONE_CHILD_PROMPT_TOKEN",
		);
	});

});
