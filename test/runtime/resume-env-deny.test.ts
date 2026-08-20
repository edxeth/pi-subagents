import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	readFileSync,
	writeExecutable,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";
import "../support/ambient-spawn-grant.ts";

async function readNonEmptyFileEventually(path: string): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (lastText.trim().length > 0) return lastText;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

describe("subagent_resume env filtering", () => {
	it("applies persisted deny-env to background resumes", async () => {
		const dir = createTestDir();
		const stdinLog = join(dir, "stdin.log");
		const envLog = join(dir, "env.log");
		const bin = writeExecutable(
			dir,
			"capture-pi",
			`#!/usr/bin/env bash
cat > '${stdinLog}'
printenv | sort > '${envLog}'
`,
		);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		const originalDeny = process.env.PI_SUBAGENT_ENV_DENY;
		process.env.PI_SUBAGENT_ENV_DENY = "RESUME_TEST_GLOBAL_DENY";
		const originalAgentDeny = process.env.RESUME_TEST_AGENT_DENY;
		process.env.RESUME_TEST_AGENT_DENY = "agent-denied";
		const originalKeep = process.env.RESUME_TEST_KEEP;
		process.env.RESUME_TEST_KEEP = "kept";
		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "background",
				sessionMode: "lineage-only",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				denyEnv: "RESUME_TEST_AGENT_DENY, RESUME_TEST_MISSING_*",
			});


			await resumeSubagentSession(
				{ sessionFile, task: "Background deny-env probe." },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: async () => ({
						name: "",
						task: "",
						summary: "",
						exitCode: 0,
						elapsed: 0,
					}),
					watchSubagent: async () => ({
						name: "",
						task: "",
						summary: "",
						exitCode: 0,
						elapsed: 0,
					}),
					getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, any>(),
				},
			);

			await readNonEmptyFileEventually(envLog);
			const env = readFileSync(envLog, "utf8");
			assert.doesNotMatch(env, /RESUME_TEST_AGENT_DENY=/, "persisted agent deny-env must filter the child env");
			assert.doesNotMatch(env, /RESUME_TEST_GLOBAL_DENY=/, "global deny must filter the child env");
			assert.match(env, /RESUME_TEST_KEEP=kept/, "non-denied env must still flow");
			assert.match(env, /PI_SUBAGENT_NAME=resume-child/, "controlled overrides must still flow");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
			if (originalDeny === undefined) delete process.env.PI_SUBAGENT_ENV_DENY;
			else process.env.PI_SUBAGENT_ENV_DENY = originalDeny;
			if (originalAgentDeny === undefined) delete process.env.RESUME_TEST_AGENT_DENY;
			else process.env.RESUME_TEST_AGENT_DENY = originalAgentDeny;
			if (originalKeep === undefined) delete process.env.RESUME_TEST_KEEP;
			else process.env.RESUME_TEST_KEEP = originalKeep;
		}
	});

	it("applies persisted deny-env to interactive resumes", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "tmux.log");
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		const originalKeep = process.env.RESUME_TEST_KEEP;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.FAKE_TMUX_LOG = logFile;
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;
		process.env.RESUME_TEST_KEEP = "kept";

		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "interactive",
				sessionMode: "fork",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
				denyEnv: "RESUME_TEST_AGENT_DENY, RESUME_TEST_MISSING_*",
			});

			await resumeSubagentSession(
				{ sessionFile, task: "Interactive deny-env probe." },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
					watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
					getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents: new Map<string, any>(),
				},
			);

			const log = readFileSync(logFile, "utf8");
			const capsuleMatch = log.match(/run-child\.mjs' '([^']+)'/);
			assert.ok(capsuleMatch, "expected the resume command to invoke the capsule launcher");
			const capsule = JSON.parse(readFileSync(capsuleMatch[1], "utf8"));
			assert.equal(capsule.parentEnv.RESUME_TEST_AGENT_DENY, undefined, "persisted deny-env must filter the resumed child env");
			assert.equal(capsule.parentEnv.RESUME_TEST_KEEP, "kept", "non-denied env must still flow");
			assert.equal(capsule.overrides.PI_SUBAGENT_NAME, "resume-child", "controlled overrides must survive");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalKeep === undefined) delete process.env.RESUME_TEST_KEEP;
			else process.env.RESUME_TEST_KEEP = originalKeep;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
			delete process.env.FAKE_TMUX_LOG;
			rmSync(capsuleRoot, { recursive: true, force: true });
		}
	});

	it("deletes the capsule when interactive resume delivery fails", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
case "$1" in
  new-window) printf '%%42\\n' ;;
  send-keys) exit 9 ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;

		try {
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(
				sessionFile,
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}) + "\n",
			);
			await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
				version: 1,
				timestamp: new Date().toISOString(),
				name: "resume-child",
				agent: "scout",
				mode: "interactive",
				sessionMode: "fork",
				autoExit: true,
				parentClosePolicy: "terminate",
				async: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: dir,
				cwd: dir,
				boundarySystemPrompt: false,
			});

			await assert.rejects(
				resumeSubagentSession(
					{ sessionFile, task: "Failure probe." },
					{
						isMuxAvailable: () => true,
						getShellReadyDelayMs: () => 0,
						watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
						watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
						getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
						startWidgetRefresh: () => {},
						getContextWindow: () => undefined,
						runningSubagents: new Map<string, any>(),
					},
				),
				/send-keys|Command failed|tmux/i,
			);

			assert.equal(
				existsSync(capsuleRoot) ? readdirSync(capsuleRoot).length : 0,
				0,
				"an unconsumed capsule must not survive a failed interactive resume delivery",
			);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
		}
	});
});
