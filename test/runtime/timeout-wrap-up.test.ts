import { once } from "node:events";
import { restartSubagentForTimeoutWrapUp } from "../../src/runtime/timeout-wrap-up.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import type { RunningSubagent } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

const savedPiCommand = process.env.PI_SUBAGENT_PI_COMMAND;

async function readNonEmptyFileEventually(path: string): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (existsSync(path)) {
			const value = readFileSync(path, "utf8");
			if (value) return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function makeMetadata(dir: string): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "timeout-child",
		agent: "scout",
		mode: "background",
		sessionMode: "fork",
		autoExit: false,
		parentClosePolicy: "terminate",
		async: true,
		modelRef: "test/model:off",
		denyTools: [],
		spawnBudget: 2,
		spawnableAgents: true,
		noContextFiles: false,
		noSession: true,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: true,
		timeout: 10,
		timeoutWarnThreshold: "80%",
	};
}

function makeRunning(dir: string, sessionFile: string): RunningSubagent {
	const startTime = Date.now() - 8_000;
	return {
		id: "timeout-child",
		name: "timeout-child",
		task: "Do the long task",
		agent: "scout",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		autoExit: false,
		noSession: true,
		startTime,
		sessionFile,
		timeoutBudget: { timeoutSeconds: 10 },
		timeoutWarnThreshold: 80,
		timeoutWrapUp: { kind: "timeout", seconds: 10, threshold: 80 },
		modelRef: "test/model:off",
		launchMetadata: makeMetadata(dir),
	};
}

describe("timeout wrap-up restart", () => {
	afterEach(() => {
		if (savedPiCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = savedPiCommand;
	});

	it("restarts the same background session with the original deadline and a report-only prompt", async () => {
		const dir = createTestDir();
		const stdinFile = join(dir, "stdin.txt");
		const envFile = join(dir, "env.txt");
		const argvFile = join(dir, "argv.txt");
		const pi = writeExecutable(
			dir,
			"capture-pi",
			`#!/usr/bin/env bash
printf '%s' "$PI_SUBAGENT_TIMEOUT_STARTED_AT|$PI_SUBAGENT_TIMEOUT_WRAP_UP|$PI_SUBAGENT_AUTO_EXIT|$PI_SUBAGENT_SPAWN_BUDGET" > "${envFile}"
printf '%s\n' "$@" > "${argvFile}"
cat > "${stdinFile}"
`,
		);
		process.env.PI_SUBAGENT_PI_COMMAND = pi;

		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
		);
		const running = makeRunning(dir, sessionFile);

		await restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 });
		assert.ok(running.childProcess);
		await once(running.childProcess!, "exit");

		assert.equal(
			await readNonEmptyFileEventually(envFile),
			`${running.startTime}|1|1|0`,
			"the continuation must keep the original clock, force auto-exit, and revoke spawning",
		);
		const argv = await readNonEmptyFileEventually(argvFile);
		assert.match(argv, /--session/);
		assert.match(argv, new RegExp(sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(argv, /--no-session/);

		const prompt = await readNonEmptyFileEventually(stdinFile);
		assert.match(prompt, /process restart.*does not reset/i);
		assert.match(prompt, /conversation inherited or forked.*consumed zero seconds/i);
		assert.match(prompt, /elapsed and remaining values.*authoritative/i);
		assert.match(prompt, /interrupted your previous active operation/i);
		assert.match(prompt, /Do not retry.*tool/i);
		assert.match(prompt, /Report your result now/i);
	});

	it("closes an interactive pane when restart fails after surface creation", async () => {
		const dir = createTestDir();
		const binDir = dir;
		const tmuxLog = join(dir, "tmux.log");
		writeFileSync(tmuxLog, "");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\n' "$*" >> "${tmuxLog}"
case "$1" in
  new-window) printf '%%42\n' ;;
  send-keys) exit 1 ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		const originalShell = process.env.SHELL;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.SHELL = "/bin/sh";

		try {
			const sessionFile = join(dir, "interactive-child.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: dir })}\n`,
			);
			const running = makeRunning(dir, sessionFile);
			running.mode = "interactive";
			running.launchMetadata = { ...running.launchMetadata!, mode: "interactive" };

			await assert.rejects(
				restartSubagentForTimeoutWrapUp(running, { getShellReadyDelayMs: () => 0 }),
				/send-keys|Command failed|tmux/i,
			);

			const log = readFileSync(tmuxLog, "utf8");
			assert.match(log, /new-window/);
			assert.match(log, /kill-pane -t %42/, "a partially created wrap-up pane must be closed on launch failure");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = originalShell;
		}
	});
});
