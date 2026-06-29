import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
	ASSISTANT_MSG,
	MODEL_CHANGE,
	SESSION_HEADER,
	USER_MSG,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	mkdirSync,
	readFileSync,
	enforceAgentFrontmatterForTest,
	loadAgentDefaults,
	readSubagentLaunchMetadataForTest,
	sleep,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";
import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";

function clearMuxRuntimeEnv(): void {
	delete process.env.CMUX_SOCKET_PATH;
	delete process.env.CMUX_SURFACE_ID;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.WEZTERM_PANE;
	delete process.env.WEZTERM_UNIX_SOCKET;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_SESSION_NAME;
	delete process.env.HERDR_PANE_ID;
	delete process.env.HERDR_TAB_ID;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_SUBAGENT_MUX;
	delete process.env.PI_SUBAGENT_PI_COMMAND;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_SESSION;
}

function writeFakeHerdr(dir: string): string {
	const logFile = join(dir, "herdr.log");
	writeFileSync(logFile, "");
	writeExecutable(
		dir,
		"herdr",
		`#!/bin/sh
printf '%s\n' "$*" >> "${logFile}"

if [ "$*" = "status server --json" ]; then
  printf '%s\n' '{"status":"running","running":true,"compatible":true,"protocol":14,"version":"0.7.0"}'
  exit 0
fi

if [ "$*" = "pane current --current" ]; then
  printf '%s\n' '{"id":"cli:pane:current","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":"/parent","foreground_cwd":"/parent","focused":true}}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "create" ]; then
  printf '%s\n' '{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1},"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":"/child","focused":false}}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "list" ]; then
  printf '%s\n' '{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"Parent","focused":true,"pane_count":1},{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1}]}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "rename" ]; then
  printf '%s\n' '{"id":"cli:tab:rename","result":{"type":"tab_renamed"}}'
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "run" ]; then
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "send-text" ]; then
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "send-keys" ]; then
  exit 0
fi

printf '%s\n' '{"error":{"code":"unknown_command","message":"unsupported fake herdr command"}}'
exit 1
`,
	);
	return logFile;
}

function useFakeHerdr(): { dir: string; logFile: string } {
	const dir = createTestDir();
	const logFile = writeFakeHerdr(dir);
	clearMuxRuntimeEnv();
	process.env.PATH = dir;
	return { dir, logFile };
}

function writeParentSession(dir: string): string {
	return createSessionFile(dir, [
		SESSION_HEADER,
		MODEL_CHANGE,
		USER_MSG,
		ASSISTANT_MSG,
	]);
}

async function readEventually(
	path: string,
	isReady: (text: string) => boolean = (text) => text.trim().length > 0,
): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (isReady(lastText)) return lastText;
		}
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

function extractTaskArtifactPath(commandText: string): string {
	const match = commandText.match(/'@([^']+)'/);
	if (!match?.[1]) throw new Error("Expected Herdr launch command to include a task artifact argument");
	return match[1];
}

function extractHerdrRunScriptPath(log: string): string {
	const match = log.match(/pane run w1:p2 '([^']+)'/);
	if (!match?.[1]) throw new Error("Expected Herdr launch command to run a staged shell script");
	return match[1];
}

function readHerdrRunScript(log: string): string {
	return readFileSync(extractHerdrRunScriptPath(log), "utf8");
}

describe("Herdr interactive launch parity", () => {
	it("records child exit status through a direct sentinel before staged Herdr scripts exit", async () => {
		const originalPath = process.env.PATH;
		const { dir, logFile } = useFakeHerdr();
		const originalPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		const originalShell = process.env.SHELL;
		process.env.PATH = `${dir}:${originalPath ?? ""}`;
		process.env.SHELL = "/bin/sh";
		try {
			const cwd = createTestDir();
			process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
			mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
			writeFileSync(
				join(cwd, ".pi", "agents", "sentinel-child.md"),
				[
					"---",
					"name: sentinel-child",
					"auto-exit: true",
					"---",
					"Exit immediately for sentinel verification.",
				].join("\n"),
			);
			const fakePi = writeExecutable(dir, "fake-pi", "#!/bin/sh\nexit 42\n");
			process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
			const parentSession = writeParentSession(cwd);

			const running = await launchInteractiveSubagent(
				{
					name: "sentinel-launch-child",
					title: "Sentinel launch child",
					task: "Check staged sentinel status.",
					agent: "sentinel-child",
				},
				{
					cwd,
					sessionManager: {
						getSessionFile: () => parentSession,
						getSessionId: () => "parent-session-id",
						getLeafId: () => "asst-001",
					},
				},
				{
					getContextWindow: () => undefined,
					getShellReadyDelayMs: () => 0,
					waitForInteractivePrompt: async () => {},
				},
			);

			const log = readFileSync(logFile, "utf8");
			const launchScriptPath = extractHerdrRunScriptPath(log);
			const launchScript = readFileSync(launchScriptPath, "utf8");
			const command = launchScript.split("\n").slice(1).join("\n").trim();

			const shell = spawn("/bin/sh", [], { stdio: ["pipe", "ignore", "ignore"] });
			try {
				shell.stdin.write(`${command}\n`);
				const sentinel = await readEventually(
					running.doneSentinelFile!,
					(text) => /__SUBAGENT_DONE_42__/.test(text),
				);
				assert.match(sentinel, /__SUBAGENT_DONE_42__/);
			} finally {
				shell.stdin.end("exit\n");
			}

			rmSync(running.doneSentinelFile!, { force: true });
			const result = spawnSync(launchScriptPath, { encoding: "utf8" });
			assert.equal(result.error, undefined);
			assert.match(readFileSync(running.doneSentinelFile!, "utf8"), /__SUBAGENT_DONE_42__/);
		} finally {
			if (originalPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalPiCommand;
			if (originalShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = originalShell;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("launches interactive Herdr children with resolved cwd, session, approval, and surface facts", async () => {
		const { logFile } = useFakeHerdr();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const childCwd = join(cwd, "child-workspace");
		mkdirSync(childCwd, { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "path-session.md"),
			[
				"---",
				"name: path-session",
				"session-mode: fork",
				"no-session: true",
				"trust-project: true",
				"cwd: child-workspace",
				"env: |",
				"  CUSTOM_ENV=from-agent",
				"flags: --alpha 'two words'",
				"---",
				"Preserve resolved runtime facts.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const waitedSurfaces: string[] = [];

		const running = await launchInteractiveSubagent(
			{
				name: "path-session-child",
				title: "Path session child",
				task: "Check launch parity.",
				agent: "path-session",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => 4096,
				getShellReadyDelayMs: () => 0,
				waitForInteractivePrompt: async (surface) => {
					waitedSurfaces.push(surface);
				},
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "w1:p2");
		assert.equal(running.noSession, true);
		assert.equal(running.modelContextWindow, 4096);
		assert.deepEqual(waitedSurfaces, ["w1:p2"]);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.sessionMode, "fork");
		assert.equal(metadata?.noSession, true);
		assert.equal(metadata?.trustProject, true);
		assert.equal(metadata?.cwd, childCwd);
		assert.equal(metadata?.env, "CUSTOM_ENV=from-agent");
		assert.equal(metadata?.flags, "--alpha 'two words'");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /status server --json/);
		assert.match(log, /pane current --current/);
		assert.match(log, /tab create --workspace w1 --cwd .* --label \[path-session\] Path session child --no-focus/);
		assert.match(log, /tab rename w1:t2 \[path-session\] Path session child/);
		assert.doesNotMatch(log, /tab list --workspace w1/);
		assert.match(log, /pane run w1:p2 /);
		assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
		const launchScript = readHerdrRunScript(log);
		assert.match(launchScript, new RegExp(`cd '${childCwd.replace(/'/g, "'\\''")}' &&`));
		assert.match(launchScript, new RegExp(`'--session' '${running.sessionFile.replace(/'/g, "'\\''")}'`));
		assert.match(launchScript, /'--no-session'/);
		assert.match(launchScript, /'--approve'/);
		assert.match(launchScript, /CUSTOM_ENV='from-agent'/);
		assert.match(launchScript, /PI_SUBAGENT_SURFACE='w1:p2'/);
		assert.match(launchScript, /'--alpha' 'two words'/);
	});

	it("honors an explicit Herdr mux preference at the launch seam", async () => {
		const { logFile } = useFakeHerdr();
		process.env.PI_SUBAGENT_MUX = "herdr";
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "forced-herdr.md"),
			[
				"---",
				"name: forced-herdr",
				"mode: interactive",
				"auto-exit: true",
				"async: false",
				"spawning: false",
				"---",
				"Launch through explicitly forced Herdr.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const baseParams = {
			name: "forced-herdr-child",
			title: "Forced Herdr child",
			task: "Check forced Herdr launch parity.",
			agent: "forced-herdr",
		};
		const agentDefs = loadAgentDefaults("forced-herdr", undefined, cwd);
		const effectiveParams = enforceAgentFrontmatterForTest(baseParams, agentDefs);
		assert.equal(effectiveParams.async, false);
		assert.equal(effectiveParams.blocking, true);

		const running = await launchInteractiveSubagent(
			effectiveParams,
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: () => 4096,
				getShellReadyDelayMs: () => 0,
				waitForInteractivePrompt: async () => {},
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "w1:p2");
		assert.equal(running.async, false);
		assert.equal(running.blocking, true);
		assert.equal(running.autoExit, true);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.autoExit, true);
		assert.equal(metadata?.async, false);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /status server --json/);
		assert.match(log, /pane current --current/);
		assert.match(log, /tab create --workspace w1 --cwd .* --label \[forced-herdr\] Forced herdr child --no-focus/);
		assert.match(log, /tab rename w1:t2 \[forced-herdr\] Forced herdr child/);
		assert.doesNotMatch(log, /tab list --workspace w1/);
		assert.match(log, /pane run w1:p2 /);
		assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
		const launchScript = readHerdrRunScript(log);
		assert.match(launchScript, /PI_SUBAGENT_SURFACE='w1:p2'/);
	});

	it("launches interactive Herdr children with resolved capability, model, and lifecycle facts", async () => {
		const { logFile } = useFakeHerdr();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const agentConfigDir = join(cwd, "agent-config");
		process.env.PI_CODING_AGENT_DIR = agentConfigDir;
		mkdirSync(join(agentConfigDir, "agents"), { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		const skillDir = join(cwd, ".pi", "skills", "review");
		mkdirSync(skillDir, { recursive: true });
		const skillFile = join(skillDir, "SKILL.md");
		writeFileSync(
			skillFile,
			[
				"---",
				"name: review",
				"description: Review skill fixture.",
				"---",
				"Review skill body token.",
			].join("\n"),
		);
		writeFileSync(
			join(cwd, ".pi", "agents", "capability-lifecycle.md"),
			[
				"---",
				"name: capability-lifecycle",
				"model: zai-messages/glm-5-turbo",
				"thinking: off",
				"auto-exit: true",
				"async: false",
				"parent-close-policy: continue",
				"tools: read,grep",
				"deny-tools: grep,set_tab_title",
				"extensions: none",
				"skills: review",
				"inject-skills: review",
				"spawning: false",
				"no-context-files: true",
				"---",
				"Preserve capability and lifecycle facts.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const baseParams = {
			name: "capability-child",
			title: "Capability child",
			task: "Check capability launch parity.",
			agent: "capability-lifecycle",
		};
		const agentDefs = loadAgentDefaults("capability-lifecycle", undefined, cwd);
		const effectiveParams = enforceAgentFrontmatterForTest(baseParams, agentDefs);
		assert.equal(effectiveParams.async, false);
		assert.equal(effectiveParams.blocking, true);
		const contextWindowRefs: Array<string | undefined> = [];

		const running = await launchInteractiveSubagent(
			effectiveParams,
			{
				cwd,
				parentModelRef: "parent/provider-model",
				parentThinking: "medium",
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{
				getContextWindow: (modelRef) => {
					contextWindowRefs.push(modelRef);
					return modelRef === "zai-messages/glm-5-turbo:off" ? 8192 : undefined;
				},
				getShellReadyDelayMs: () => 0,
				waitForInteractivePrompt: async () => {},
			},
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "w1:p2");
		assert.equal(running.autoExit, true);
		assert.equal(running.async, false);
		assert.equal(running.blocking, true);
		assert.equal(running.parentClosePolicy, "continue");
		assert.equal(running.modelRef, "zai-messages/glm-5-turbo:off");
		assert.equal(running.modelContextWindow, 8192);
		assert.deepEqual(contextWindowRefs, ["zai-messages/glm-5-turbo:off"]);

		const metadata = readSubagentLaunchMetadataForTest(running.sessionFile);
		assert.equal(metadata?.mode, "interactive");
		assert.equal(metadata?.autoExit, true);
		assert.equal(metadata?.async, false);
		assert.equal(metadata?.parentClosePolicy, "continue");
		assert.equal(metadata?.model, "zai-messages/glm-5-turbo");
		assert.equal(metadata?.thinking, "off");
		assert.equal(metadata?.modelRef, "zai-messages/glm-5-turbo:off");
		assert.equal(metadata?.definitionModel, "zai-messages/glm-5-turbo");
		assert.equal(metadata?.definitionThinking, "off");
		assert.equal(metadata?.modelSource, "agent");
		assert.equal(metadata?.tools, "read,grep");
		assert.equal(metadata?.skills, "review");
		assert.equal(metadata?.injectSkills, "review");
		assert.deepEqual(metadata?.extensions, []);
		assert.deepEqual(metadata?.denyTools, ["subagent", "subagent_resume", "grep", "set_tab_title"]);
		assert.equal(metadata?.noContextFiles, true);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /tab create --workspace w1 --cwd .* --label \[capability-lifecycle\] Capability child --no-focus/);
		assert.match(log, /tab rename w1:t2 \[capability-lifecycle\] Capability child/);
		assert.doesNotMatch(log, /tab list --workspace w1/);
		assert.match(log, /pane run w1:p2 /);
		assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
		const launchScript = readHerdrRunScript(log);
		assert.match(launchScript, /PI_SUBAGENT_AUTO_EXIT='1'/);
		assert.match(launchScript, /PI_DENY_TOOLS='subagent,subagent_resume,grep,set_tab_title'/);
		assert.match(launchScript, /PI_SUBAGENT_EXTENSIONS=''/);
		assert.match(launchScript, /--model 'zai-messages\/glm-5-turbo:off'/);
		assert.match(launchScript, /--no-context-files/);
		assert.match(launchScript, /'--no-extensions' '-e' '.*\/tools\/subagent-done\.ts'/);
		assert.equal(launchScript.match(/'--tools' '([^']+)'/)?.[1], "read,grep,caller_ping,subagent_done");
		assert.equal(
			launchScript.match(/'--exclude-tools' '([^']+)'/)?.[1],
			"subagent,subagent_resume,grep,set_tab_title",
		);
		assert.match(launchScript, new RegExp(`'--skill' '${skillFile.replace(/'/g, "'\\''")}'`));

		const taskArtifact = readFileSync(extractTaskArtifactPath(launchScript), "utf8");
		assert.match(taskArtifact, /<skill name="review">/);
		assert.match(taskArtifact, /Review skill body token\./);
		assert.match(taskArtifact, /Complete your task autonomously\./);
		assert.match(taskArtifact, /FINAL assistant message should summarize what you accomplished\./);
		assert.doesNotMatch(taskArtifact, /set_tab_title/);
	});

	it("keeps background launches independent of Herdr mux availability", async () => {
		const { dir, logFile: herdrLogFile } = useFakeHerdr();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		const childCwd = join(cwd, "background-workspace");
		mkdirSync(childCwd, { recursive: true });
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "bg-agent.md"),
			[
				"---",
				"name: bg-agent",
				"session-mode: lineage-only",
				"trust-project: true",
				"cwd: background-workspace",
				"env: |",
				"  CUSTOM_ENV=from-background-agent",
				"flags: --background-flag",
				"---",
				"Run in the background.",
			].join("\n"),
		);
		const parentSession = writeParentSession(cwd);
		const childLogFile = join(cwd, "background-child.log");
		const fakePi = writeExecutable(
			dir,
			"fake-pi",
			`#!/bin/sh
{
  printf 'PWD=%s\n' "$PWD"
  printf 'ARGS=%s\n' "$*"
  printf 'CUSTOM_ENV=%s\n' "\${CUSTOM_ENV-}"
  printf 'SURFACE=%s\n' "\${PI_SUBAGENT_SURFACE-}"
} >> "${childLogFile}"
`,
		);
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;

		const running = await launchBackgroundSubagent(
			{
				name: "background-child",
				title: "Background child",
				task: "Check background launch isolation.",
				agent: "bg-agent",
			},
			{
				cwd,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => "asst-001",
				},
			},
			{ getContextWindow: () => 2048 },
		);

		const childLog = await readEventually(
			childLogFile,
			(text) => text.includes("CUSTOM_ENV=") && text.includes("SURFACE="),
		);
		assert.equal(running.mode, "background");
		assert.equal(running.surface, undefined);
		assert.equal(running.modelContextWindow, 2048);
		assert.match(childLog, new RegExp(`PWD=${childCwd.replace(/'/g, "'\\''")}`));
		assert.match(childLog, /CUSTOM_ENV=from-background-agent/);
		assert.match(childLog, /SURFACE=\n/);
		assert.match(childLog, /--no-approve/);
		assert.match(childLog, /--background-flag/);
		assert.equal(readFileSync(herdrLogFile, "utf8"), "");
	});
});
