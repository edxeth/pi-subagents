import { spawn } from "node:child_process";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import {
	ASSISTANT_MSG,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	MODEL_CHANGE,
	mkdirSync,
	readFileSync,
	readSubagentLaunchMetadataForTest,
	SESSION_HEADER,
	sleep,
	USER_MSG,
	useFakeHerdrApp,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

function useApp(): { dir: string; logFile: string } {
	for (const key of ["PI_SUBAGENT_MUX", "PI_SUBAGENT_HERDR_PLACEMENT", "PI_SUBAGENT_PI_COMMAND", "HERDR_ENV"]) {
		delete process.env[key];
	}
	const fake = useFakeHerdrApp();
	// Staged scripts need rm and friends, so keep the system PATH behind the fakes.
	process.env.PATH = `${fake.dir}:${process.env.PATH ?? ""}`;
	process.env.SHELL = "/bin/sh";
	return fake;
}

function writeParentSession(dir: string): string {
	return createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
}

async function readEventually(path: string, isReady: (text: string) => boolean): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (isReady(lastText)) return lastText;
		}
		await sleep(10);
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

function extractCapsulePath(commandText: string): string {
	const match = commandText.match(/run-child\.mjs' '([^']+)'/);
	if (!match?.[1]) throw new Error("Expected herdr-app launch command to invoke the capsule launcher");
	return match[1];
}

function readStagedScript(log: string): { path: string; text: string } {
	const match = log.match(/hc send t2 '([^']+)'; rm -f/);
	if (!match?.[1]) throw new Error(`Expected a staged script sent through hc send; log: ${log}`);
	return { path: match[1], text: readFileSync(match[1], "utf8") };
}

const CTX = (cwd: string, parentSession: string) => ({
	cwd,
	sessionManager: {
		getSessionFile: () => parentSession,
		getSessionId: () => "parent-session-id",
		getLeafId: () => "asst-001",
	},
});

describe("Herdr app interactive launch", () => {
	it("launches in a split terminal and delivers the command as a staged script", async () => {
		const { dir, logFile } = useApp();
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "sentinel-child.md"),
			["---", "name: sentinel-child", "auto-exit: true", "---", "Exit immediately."].join("\n"),
		);
		process.env.PI_SUBAGENT_PI_COMMAND = writeExecutable(dir, "fake-pi", "#!/bin/sh\nexit 42\n");

		const running = await launchInteractiveSubagent(
			{ name: "app-child", title: "App child", task: "Check herdr-app launch.", agent: "sentinel-child" },
			CTX(cwd, writeParentSession(cwd)),
			{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
		);

		assert.equal(running.mode, "interactive");
		assert.equal(running.surface, "t2");
		const log = readFileSync(logFile, "utf8");
		assert.match(log, /do pane\.split --direction right --pane p1/);
		assert.doesNotMatch(log, /hc run|tab\.new/);
		const script = readStagedScript(log);
		const capsule = JSON.parse(readFileSync(extractCapsulePath(script.text), "utf8")) as {
			overrides: Record<string, string>;
		};
		assert.equal(capsule.overrides.PI_SUBAGENT_SURFACE, "t2");
		assert.doesNotMatch(script.text, /PI_SUBAGENT_SURFACE=/);

		const command = script.text.split("\n").slice(1).join("\n").trim();
		const shell = spawn("/bin/sh", [], { stdio: ["pipe", "ignore", "ignore"] });
		try {
			shell.stdin.write(`${command}\n`);
			const sentinel = await readEventually(running.doneSentinelFile!, (text) => /__SUBAGENT_DONE_42__/.test(text));
			assert.match(sentinel, /__SUBAGENT_DONE_42__/);
		} finally {
			shell.stdin.end("exit\n");
		}
	});

	it("persists and applies an agent env placement policy", async () => {
		const { logFile } = useApp();
		process.env.PI_SUBAGENT_HERDR_PLACEMENT = "auto";
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "tab-child.md"),
			["---", "name: tab-child", "auto-exit: true", "env: PI_SUBAGENT_HERDR_PLACEMENT=tab", "---", "Use a tab."].join(
				"\n",
			),
		);

		const running = await launchInteractiveSubagent(
			{ name: "tab-child-run", title: "Tab child", task: "Check placement.", agent: "tab-child" },
			CTX(cwd, writeParentSession(cwd)),
			{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
		);

		assert.equal(running.surface, "t2");
		assert.equal(readSubagentLaunchMetadataForTest(running.sessionFile)?.herdrPlacementPolicy, "tab");
		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane\.split/);
		assert.match(log, /do tab\.new --space sp1 --folder .* --name .*Tab child/);
	});

	it("closes the terminal it just created when the launch command cannot be sent", async () => {
		const { logFile } = useApp();
		process.env.FAKE_HERDR_APP_MODE = "send-fail";
		const cwd = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "plain-child.md"),
			["---", "name: plain-child", "auto-exit: true", "---", "Never starts."].join("\n"),
		);

		await assert.rejects(
			launchInteractiveSubagent(
				{ name: "orphan-child", title: "Orphan child", task: "Never sent.", agent: "plain-child" },
				CTX(cwd, writeParentSession(cwd)),
				{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
			),
			/fake send failure/,
		);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /hc send t2 /);
		assert.match(log, /hc kill t2/);
		assert.doesNotMatch(log, /--force/);
	});
});
