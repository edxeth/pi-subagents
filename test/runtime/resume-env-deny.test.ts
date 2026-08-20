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
});
