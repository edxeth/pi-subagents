import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import { SUBAGENT_COMPLETION_ENTRY } from "../../src/tools/context-reminders.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { assert, createTestDir, existsSync, writeExecutable, writeFileSync } from "../support/index.ts";

const SPAWN_GRANT_VARS = [
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_SPAWN_DEPTH",
] as const;

/**
 * resumeSubagentSession reads the caller's spawn grant from the ambient
 * environment, so an operator running with these set would fail these tests
 * for reasons unrelated to the guard.
 */
function withoutAmbientSpawnGrant<T>(run: () => T): T {
	const saved = SPAWN_GRANT_VARS.map((name) => [name, process.env[name]] as const);
	for (const [name] of saved) delete process.env[name];
	try {
		return run();
	} finally {
		for (const [name, value] of saved) {
			if (value == null) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function writeExhaustedSession(dir: string, name: string): string {
	const sessionFile = join(dir, name);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "s",
			timestamp: new Date().toISOString(),
			cwd: dir,
		})}\n${JSON.stringify({
			type: "custom",
			customType: SUBAGENT_COMPLETION_ENTRY,
			data: { reason: "context-pressure" },
		})}\n`,
	);
	return sessionFile;
}

function createResumeRuntime() {
	const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	return {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: empty,
		watchSubagent: empty,
		getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map<string, any>(),
		wireSubagentSteerBack: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: {} }),
	};
}

function registerResumeTool(runtime: ReturnType<typeof createResumeRuntime>) {
	const tools = new Map<string, any>();
	registerSubagentResumeTool(
		{
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
		} as any,
		() => true,
		runtime as any,
	);
	return tools.get("subagent_resume");
}

describe("context-exhausted resume guard", () => {
	it("refuses an agent-initiated resume and never starts the child", async () => {
		const dir = createTestDir();
		const spawnMarker = join(dir, "child-started.txt");
		const bin = writeExecutable(dir, "marker-pi", `#!/usr/bin/env bash\nprintf started > ${JSON.stringify(spawnMarker)}\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		try {
			const sessionFile = writeExhaustedSession(dir, "exhausted-child.jsonl");
			const tool = registerResumeTool(createResumeRuntime());

			await assert.rejects(
				() => tool.execute("call-1", { sessionFile }, undefined),
				/stopped early as instructed by its context-warning policy[\s\S]*fresh sub-agent/,
			);
			assert.equal(existsSync(spawnMarker), false, "the guard must refuse before any child is started");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("leaves the operator overlay path free to resume the same session", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		try {
			const sessionFile = writeExhaustedSession(dir, "overlay-child.jsonl");

			// The overlay controller calls the service directly; the guard is agent-facing only.
			const running = await withoutAmbientSpawnGrant(() =>
				resumeSubagentSession({ sessionFile, mode: "background" }, createResumeRuntime() as any),
			);

			assert.equal(running.sessionFile, sessionFile);
			assert.ok(running.childProcess, "operator resume should still start the child");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});

	it("still resumes a session that was never context-warned", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "plain-pi", `#!/usr/bin/env bash\nexit 0\n`);
		const originalCommand = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = bin;
		try {
			const sessionFile = join(dir, "plain-child.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "s",
					timestamp: new Date().toISOString(),
					cwd: dir,
				})}\n`,
			);
			const tool = registerResumeTool(createResumeRuntime());

			// Without an explicit mode this session has no launch metadata, so the
			// resume falls back to interactive and would open a real mux pane.
			const result = await withoutAmbientSpawnGrant(() =>
				tool.execute("call-2", { sessionFile, mode: "background" }, undefined),
			);

			assert.equal(result.details.status, "started");
		} finally {
			if (originalCommand == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = originalCommand;
		}
	});
});
