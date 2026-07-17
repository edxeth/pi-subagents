import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	subagentsExtension,
	getAgentListEntriesForTest,
	getEffectiveAgentDefinitionsForTest,
	getExtensionLaunchArgsForTest,
	getAgentListSignatureForTest,
	renderAgentListReminderForTest,
	loadAgentDefaults,
	resetSubagentStateForTest,
	resolveDenyToolsForTest,
	resolveEffectiveSessionModeForTest,
	resolveSubagentExtensionsForTest,
	resolveTaskSessionModeForTest,
	createTestDir,
} from "../support/index.ts";

describe("agent definitions and catalog", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("reads extensions from extensions frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nextensions: ./extensions/caveman.ts, npm:@foo/bar, https://example.com/ext.ts\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(
			defs?.extensions,
			"./extensions/caveman.ts, npm:@foo/bar, https://example.com/ext.ts",
		);
		assert.deepEqual(resolveSubagentExtensionsForTest(defs), [
			join(configDir, "extensions", "caveman.ts"),
			"npm:@foo/bar",
			"https://example.com/ext.ts",
		]);
		assert.deepEqual(
			getExtensionLaunchArgsForTest(
				resolveSubagentExtensionsForTest(defs),
				"/tmp/subagent-done.ts",
			),
			[
				"--no-extensions",
				"-e",
				"/tmp/subagent-done.ts",
				"-e",
				join(configDir, "extensions", "caveman.ts"),
				"-e",
				"npm:@foo/bar",
				"-e",
				"https://example.com/ext.ts",
			],
		);
	});

	it("allows extensions none to launch child with only mandatory internal extension", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nextensions: none\nskills: research, exa\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.extensions, "none");
		assert.deepEqual(resolveSubagentExtensionsForTest(defs), []);
		assert.deepEqual(
			getExtensionLaunchArgsForTest(
				resolveSubagentExtensionsForTest(defs),
				"/tmp/subagent-done.ts",
			),
			["--no-extensions", "-e", "/tmp/subagent-done.ts"],
		);
	});

	it("treats extensions all as the default extension set", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nextensions: all\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.extensions, "all");
		assert.equal(resolveSubagentExtensionsForTest(defs), undefined);
		assert.deepEqual(
			getExtensionLaunchArgsForTest(
				resolveSubagentExtensionsForTest(defs),
				"/tmp/subagent-done.ts",
			),
			["-e", "/tmp/subagent-done.ts"],
		);
	});

	it("rejects legacy extensions disable aliases", () => {
		for (const value of ["false", "off", "[]"]) {
			assert.throws(
				() =>
					resolveSubagentExtensionsForTest({
						extensions: value,
					}),
				/Use "all", "none", or a comma-separated extension allowlist/,
			);
		}
	});

	it("reads skills and inject-skills from frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nskill: debugger\nskills: pua\ninject-skills: pua, torpathy\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.skills, "pua");
		assert.equal(defs?.injectSkills, "pua, torpathy");
	});

	it("parses session-mode frontmatter and lets fork override it per launch", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nsession-mode: lineage-only\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.sessionMode, "lineage-only");
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "tester" }, defs),
			"lineage-only",
		);
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "tester", fork: true }, defs),
			"lineage-only",
		);
		assert.equal(resolveTaskSessionModeForTest(defs), "lineage-only");

		writeFileSync(
			join(agentsDir, "compat.md"),
			`---\nname: compat\nfork: true\n---\n\nCompatibility body.`,
		);
		const compat = loadAgentDefaults("compat");
		assert.equal(compat?.sessionMode, "fork");
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "default" }, null),
			"lineage-only",
		);
		assert.equal(resolveTaskSessionModeForTest(null), "lineage-only");
		assert.equal(
			resolveTaskSessionModeForTest({
				sessionMode: "lineage-only",
				noSession: true,
			}),
			"fork",
		);
	});

	it("skips disabled agents and falls back to the next available definition", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\ndescription: Global tester\nmode: background\n---\n\nYou are the global tester.`,
		);
		writeFileSync(
			join(projectAgentsDir, "tester.md"),
			`---\nname: tester\nenabled: false\ndescription: Disabled local tester\nmode: interactive\n---\n\nYou are the disabled local tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester", null, dir);
		assert.equal(defs?.mode, "background");
		assert.equal(defs?.cwdBase, configDir);
	});

	it("discovers project-scoped agents only from .pi/agents in cwd", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const ignoredProjectConfigAgentsDir = join(dir, ".pi", "agent", "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(ignoredProjectConfigAgentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			join(ignoredProjectConfigAgentsDir, "ignored.md"),
			`---\nname: ignored\ndescription: Wrong project config path\nmode: background\n---\n\nYou are ignored.`,
		);
		writeFileSync(
			join(projectAgentsDir, "local.md"),
			`---\nname: local\ndescription: Project local\nmode: background\n---\n\nYou are local.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		assert.deepEqual(
			defs.map((entry) => entry.name),
			["local"],
		);
		assert.equal(defs[0].source, "project");
		assert.equal(defs[0].cwdBase, dir);
	});

	it("resolves the effective agent set deterministically after overrides", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "zeta.md"),
			`---\nname: zeta\ndescription: Global zeta\nmode: background\n---\n\nYou are zeta.`,
		);
		writeFileSync(
			join(agentsDir, "alpha.md"),
			`---\nname: alpha\ndescription: Global alpha\nmode: background\n---\n\nYou are alpha.`,
		);
		writeFileSync(
			join(projectAgentsDir, "middle.md"),
			`---\nname: middle\ndescription: Project middle\nmode: interactive\n---\n\nYou are middle.`,
		);
		writeFileSync(
			join(projectAgentsDir, "zeta.md"),
			`---\nname: zeta\ndescription: Project zeta\nmode: interactive\n---\n\nYou are project zeta.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		assert.deepEqual(
			defs.map((entry) => entry.name),
			["alpha", "middle", "zeta"],
		);
		assert.deepEqual(
			defs.map((entry) => entry.source),
			["global", "project", "project"],
		);
		assert.equal(defs.at(-1)?.description, "Project zeta");
		assert.equal(defs.at(-1)?.mode, "interactive");
	});

	it("uses descriptions for ambient catalog eligibility", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "global-agent.md"),
			`---\nname: global-agent\ndescription: Use the global route\nmode: background\nsession-mode: fork\n---\n\nGlobal body.`,
		);
		writeFileSync(
			join(agentsDir, "description-only.md"),
			`---\nname: description-only\ndescription: Fallback description\nmode: interactive\nsession-mode: lineage-only\n---\n\nDescription body.`,
		);
		writeFileSync(
			join(agentsDir, "disabled.md"),
			`---\nname: disabled\nenabled: false\ndescription: Should never appear\n---\n\nDisabled body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "project-agent.md"),
			`---\nname: project-agent\ndescription: Project description\nmode: interactive\n---\n\nProject body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "hidden-agent.md"),
			`---\nname: hidden-agent\nmode: background\n---\n\nHidden body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "lenient-enabled.md"),
			`---\nname: lenient-enabled\nenabled: maybe\ndescription: Lenient enabled fallback\n---\n\nLenient body.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		assert.equal(
			defs.find((entry) => entry.name === "project-agent")?.description,
			"Project description",
		);
		assert.equal(
			defs.find((entry) => entry.name === "global-agent")?.description,
			"Use the global route",
		);
		assert.equal(
			defs.some((entry) => entry.name === "disabled"),
			false,
		);
		assert.equal(
			defs.some((entry) => entry.name === "lenient-enabled"),
			true,
		);

		const ambient = getAgentListEntriesForTest(dir);
		assert.deepEqual(
			ambient.map((entry) => entry.name),
			["description-only", "global-agent", "lenient-enabled", "project-agent"],
		);
		assert.equal(
			ambient.find((entry) => entry.name === "project-agent")?.description,
			"Project description",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "description-only")?.description,
			"Fallback description",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "description-only")?.sessionMode,
			"lineage-only",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "global-agent")?.sessionMode,
			"fork",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "project-agent")?.sessionMode,
			"lineage-only",
		);
		assert.equal(
			ambient.some((entry) => entry.name === "hidden-agent"),
			false,
		);
	});

	it("renders compact allowed model choices in the ambient catalog", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes\nmode: background\nmodel: zai-messages/glm-5.1\nthinking: high\nallow-model-override: true\nallowed-models: openai-ws/gpt-5.5:low, nahcrof/glm-5.1:off\n---\n\nReviewer body.`,
		);
		writeFileSync(
			join(agentsDir, "scout.md"),
			`---\nname: scout\ndescription: Inspect files\nmode: background\n---\n\nScout body.`,
		);

		const defs = loadAgentDefaults("reviewer");
		assert.equal(defs?.allowedModels, "openai-ws/gpt-5.5:low, nahcrof/glm-5.1:off");

		const entries = getAgentListEntriesForTest(dir);
		const reminder = renderAgentListReminderForTest(entries);
		assert.match(reminder, /default_model: zai-messages\/glm-5\.1:high/);
		assert.match(reminder, /models: zai-messages\/glm-5\.1:high \| openai-ws\/gpt-5\.5:low \| nahcrof\/glm-5\.1:off/);
		assert.match(reminder, /- `scout`: Inspect files\n(?:  .+\n){4,5}  models: any model ref/);
		assert.match(reminder, /`models:` lists accepted overrides/);

		const firstSignature = getAgentListSignatureForTest(entries);
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes\nmode: background\nmodel: zai-messages/glm-5.1:high\nallow-model-override: true\nallowed-models: anthropic-kiro/claude-opus-4-8-thinking:xhigh\n---\n\nReviewer body.`,
		);
		assert.notEqual(firstSignature, getAgentListSignatureForTest(getAgentListEntriesForTest(dir)));
	});

	it("renders open model overrides when allow-model-override is true without allowed-models", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "debugger.md"),
			`---\nname: debugger\ndescription: Diagnose failures\nmodel: openai-cpa/gpt-5.6-sol\nthinking: max\nallow-model-override: true\n---\n\nDebugger body.`,
		);

		const reminder = renderAgentListReminderForTest(getAgentListEntriesForTest(dir));
		assert.match(reminder, /default_model: openai-cpa\/gpt-5\.6-sol:max/);
		assert.match(reminder, /models: any model ref/);
		assert.match(reminder, /`models: any model ref` accepts any available model/);
	});

	it("hides selectable models when allow-model-override is false", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes\nmode: background\nmodel: zai-messages/glm-5.1:high\nallow-model-override: false\nallowed-models: openai-ws/gpt-5.5:low\n---\n\nReviewer body.`,
		);

		const reminder = renderAgentListReminderForTest(getAgentListEntriesForTest(dir));
		assert.doesNotMatch(reminder, /\n  models:/);
		assert.match(reminder, /no `models:` line ignores model and thinking overrides/);
	});

	it("defaults spawning to false for named agent definitions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "worker.md"),
			`---\nname: worker\ndescription: Do focused work\n---\n\nWorker body.`,
		);
		writeFileSync(
			join(agentsDir, "coordinator.md"),
			`---\nname: coordinator\ndescription: Coordinate work\nspawning: true\n---\n\nCoordinator body.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		const worker = defs.find((entry) => entry.name === "worker");
		const coordinator = defs.find((entry) => entry.name === "coordinator");
		assert.equal(worker?.spawning, false);
		assert.equal(coordinator?.spawning, true);
		assert.deepEqual([...resolveDenyToolsForTest(worker ?? null)].sort(), [
			"subagent",
			"subagent_resume",
		]);
		assert.deepEqual([...resolveDenyToolsForTest(coordinator ?? null)], []);
	});

	it("keeps catalog signatures stable until the effective ambient catalog changes", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const first = getAgentListEntriesForTest(dir);
		const second = getAgentListEntriesForTest(dir);
		assert.equal(
			getAgentListSignatureForTest(first),
			getAgentListSignatureForTest(second),
		);

		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review critical changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const changed = getAgentListEntriesForTest(dir);
		assert.notEqual(
			getAgentListSignatureForTest(first),
			getAgentListSignatureForTest(changed),
		);
	});

	it("registers conservative delegation guidance on the subagent tool", () => {
		const tools = new Map<string, any>();

		subagentsExtension({
			on() {},
			registerCommand() {},
			registerMessageRenderer() {},
			sendMessage() {},
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
		} as any);

		const tool = tools.get("subagent");
		assert.ok(tool);
		assert.match(tool.description, /named helper agents from the subagent roster/);
		assert.match(
			tool.promptSnippet,
			/separate helper processes you can launch to do work outside this chat turn/,
		);
		assert.match(
			tool.promptSnippet,
			/Use exact agent names and behavior fields from the subagent roster when present; field meanings are defined in <subagent-rules>/,
		);
		assert.match(tool.promptSnippet, /make one subagent call with children/);
		assert.match(
			tool.promptSnippet,
			/include each named agent exactly once/,
		);
		assert.match(
			tool.promptSnippet,
			/Do not substitute one agent for another/,
		);
		assert.match(
			tool.promptSnippet,
			/Translate the user.s request into each helper.s task/,
		);
		assert.match(
			tool.promptSnippet,
			/do not change the work just because of the agent name/,
		);
		assert.match(
			tool.promptSnippet,
			/write readable Markdown with objective, scope, relevant files\/facts, constraints, and requested output/,
		);
		assert.match(
			tool.promptSnippet,
			/Do small direct work yourself: quick answers, simple file reads, and tiny one-shot edits/,
		);
		assert.match(
			tool.promptSnippet,
			/Do not redo delegated work/,
		);
		assert.match(
			tool.promptSnippet,
			/do not claim the helper's findings before its later message appears/,
		);
		assert.match(
			tool.promptSnippet,
			/For helpers with tool_return=later_message, the runtime may stop after this tool batch/,
		);
		assert.match(
			tool.promptSnippet,
			/Do not redo delegated work or claim results before the later report appears/,
		);
		assert.doesNotMatch(
			tool.promptSnippet,
			/PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN/,
		);
	});

	it("registers opt-out delegation guidance when coordinator-only turn stop is disabled", () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const tools = new Map<string, any>();

		subagentsExtension({
			on() {},
			registerCommand() {},
			registerMessageRenderer() {},
			sendMessage() {},
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
		} as any);

		const tool = tools.get("subagent");
		assert.ok(tool);
		assert.match(
			tool.promptSnippet,
			/You may continue with non-overlapping work after launching a tool_return=later_message helper/,
		);
		assert.match(tool.promptSnippet, /Do not redo delegated work/);
		assert.doesNotMatch(
			tool.promptSnippet,
			/For helpers with tool_return=later_message, the runtime may stop/,
		);
	});

});
