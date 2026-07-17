import {
	ASSISTANT_MSG,
	MODEL_CHANGE,
	SESSION_HEADER,
	USER_MSG,
	assert,
	createTestDir,
	describe,
	getEntries,
	it,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";
import { coordinateSubagentLaunch } from "../../src/launch/launch-coordinator.ts";

describe("launch coordinator", () => {
	it("prepares, seeds, persists, and returns common launch facts", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "scout.md"),
			[
				"---",
				"name: scout",
				"session-mode: fork",
				"mode: background",
				"auto-exit: true",
				"model: provider/model",
				"thinking: high",
				"tools: read,bash",
				"deny-tools: bash",
				"skills: none",
				"extensions: none",
				"trust-project: true",
				"---",
				"You scout the codebase.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent.jsonl");
		writeFileSync(
			parentSession,
			`${[SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const launch = await coordinateSubagentLaunch(
			{
				name: "code-scout",
				title: "Code scout",
				task: "Map launch code",
				agent: "scout",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{ mode: "background" },
		);

		assert.equal(launch.sessionMode, "fork");
		assert.equal(launch.noSession, false);
		assert.equal(launch.directTask, true);
		assert.equal(launch.seedMode, "fork");
		assert.equal(launch.boundarySystemPrompt, true);
		assert.equal(launch.launchMetadata.mode, "background");
		assert.equal(launch.launchMetadata.sessionMode, "fork");
		assert.equal(launch.launchMetadata.modelRef, "provider/model:high");
		assert.equal(launch.launchMetadata.trustProject, true);
		assert.equal(launch.envVars.PI_SUBAGENT_SESSION, launch.prepared.subagentSessionFile);
		assert.equal(launch.envVars.PI_SUBAGENT_AUTO_EXIT, "1");
		assert.deepEqual(launch.envVars.PI_DENY_TOOLS.split(",").sort(), [
			"bash",
			"subagent",
			"subagent_resume",
		]);

		const entries = getEntries(launch.prepared.subagentSessionFile) as Array<Record<string, unknown>>;
		assert.equal(entries[0].type, "session");
		assert.equal(entries.some((entry) => entry.customType === "subagent_boundary"), true);
		assert.equal(entries.some((entry) => entry.type === "model_change"), true);
		assert.equal(entries.some((entry) => entry.type === "thinking_level_change"), true);
		assert.equal(entries.some((entry) => entry.customType === "pi-subagents_launch_metadata"), true);
		assert.equal(launch.launchEntryCount, entries.length);
	});

	it("persists the operator Zellij placement policy and immediate parent group", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "scout.md"),
			"---\nname: scout\nmode: interactive\n---\nScout.",
		);
		const parentSession = join(cwd, "parent-zellij.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		process.env.ZELLIJ_PANE_ID = "7";
		process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT = "down-stack";

		const launch = await coordinateSubagentLaunch(
			{
				name: "zellij-scout",
				title: "Zellij scout",
				task: "Scout",
				agent: "scout",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ mode: "interactive" },
		);

		assert.equal(launch.launchMetadata.zellijPlacementPolicy, "down-stack");
		assert.equal(launch.launchMetadata.zellijPlacementGroupKey, parentSession);
	});

	it("uses an agent env Zellij placement policy for interactive launches", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "scout.md"),
			[
				"---",
				"name: scout",
				"mode: interactive",
				"env: PI_SUBAGENT_ZELLIJ_PLACEMENT=right-stack",
				"---",
				"Scout.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent-agent-zellij.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		process.env.ZELLIJ_PANE_ID = "7";
		delete process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT;

		const launch = await coordinateSubagentLaunch(
			{
				name: "agent-zellij-scout",
				title: "Agent Zellij scout",
				task: "Scout",
				agent: "scout",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ mode: "interactive" },
		);

		assert.equal(launch.launchMetadata.zellijPlacementPolicy, "right-stack");
	});

	it("lets an agent env Zellij placement policy override the parent default", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "reviewer.md"),
			[
				"---",
				"name: reviewer",
				"mode: interactive",
				"env: PI_SUBAGENT_ZELLIJ_PLACEMENT=down-stack",
				"---",
				"Review.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent-agent-zellij-override.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		process.env.ZELLIJ_PANE_ID = "7";
		process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT = "floating";

		const launch = await coordinateSubagentLaunch(
			{
				name: "agent-zellij-reviewer",
				title: "Agent Zellij reviewer",
				task: "Review",
				agent: "reviewer",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ mode: "interactive" },
		);

		assert.equal(launch.launchMetadata.zellijPlacementPolicy, "down-stack");
	});

	it("persists distinct policies with the same immediate parent group key", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "scout.md"),
			"---\nname: scout\nmode: interactive\nenv: PI_SUBAGENT_ZELLIJ_PLACEMENT=right-stack\n---\nScout.",
		);
		writeFileSync(
			join(cwd, ".pi", "agents", "reviewer.md"),
			"---\nname: reviewer\nmode: interactive\nenv: PI_SUBAGENT_ZELLIJ_PLACEMENT=down-stack\n---\nReview.",
		);
		const parentSession = join(cwd, "parent-mixed-zellij.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		process.env.ZELLIJ_PANE_ID = "7";
		const context = {
			cwd,
			sessionManager: {
				getSessionFile: () => parentSession,
				getSessionId: () => "parent-session-id",
				getLeafId: () => null,
			},
		};

		const scout = await coordinateSubagentLaunch(
			{
				name: "mixed-zellij-scout",
				title: "Mixed Zellij scout",
				task: "Scout",
				agent: "scout",
			},
			context,
			{ mode: "interactive" },
		);
		const reviewer = await coordinateSubagentLaunch(
			{
				name: "mixed-zellij-reviewer",
				title: "Mixed Zellij reviewer",
				task: "Review",
				agent: "reviewer",
			},
			context,
			{ mode: "interactive" },
		);

		assert.equal(scout.launchMetadata.zellijPlacementGroupKey, parentSession);
		assert.equal(reviewer.launchMetadata.zellijPlacementGroupKey, parentSession);
		assert.equal(scout.launchMetadata.zellijPlacementPolicy, "right-stack");
		assert.equal(reviewer.launchMetadata.zellijPlacementPolicy, "down-stack");
	});

	it("persists identity system prompt without changing the child session path", async () => {
		const cwd = createTestDir();
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "reviewer.md"),
			[
				"---",
				"name: reviewer",
				"system-prompt: append",
				"---",
				"You are the reviewer identity.",
			].join("\n"),
		);
		const parentSession = join(cwd, "parent-system-prompt.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);

		const launch = await coordinateSubagentLaunch(
			{
				name: "diff-reviewer",
				title: "Diff reviewer",
				task: "Review the diff",
				agent: "reviewer",
				systemPrompt: "Focus on material findings.",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ mode: "background" },
		);

		assert.equal(launch.systemPrompt?.flag, "--append-system-prompt");
		assert.match(launch.systemPrompt?.text ?? "", /You are the reviewer identity/);
		assert.match(launch.systemPrompt?.text ?? "", /Focus on material findings/);
		assert.equal(launch.launchMetadata.systemPrompt, launch.systemPrompt?.text);
		assert.equal(launch.envVars.PI_SUBAGENT_SESSION, launch.prepared.subagentSessionFile);

		const metadataEntries = (getEntries(launch.prepared.subagentSessionFile) as Array<Record<string, unknown>>)
			.filter((entry) => entry.customType === "pi-subagents_launch_metadata");
		assert.equal(metadataEntries.length, 1);
	});
});
