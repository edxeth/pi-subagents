import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";
import { writeSubagentLaunchMetadataEntry } from "../../src/session/session-files.ts";
import { readSubagentTimeoutSidecar, writeSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import { registerSubagentResumeTool } from "../../src/tools/resume-tool.ts";
import { assert, createTestDir, existsSync, readFileSync, writeExecutable, writeFileSync } from "../support/index.ts";

const SPAWN_GRANT_VARS = [
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_SPAWN_DEPTH",
] as const;

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

function writeTimedOutSession(
	dir: string,
	name: string,
	options: { blocksResume: boolean; budget?: Partial<PersistedSubagentLaunchMetadata> },
): string {
	const sessionFile = join(dir, name);
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
	writeSubagentLaunchMetadataEntry(sessionFile, {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "runaway",
		mode: "background",
		sessionMode: "lineage-only",
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: dir,
		cwd: dir,
		boundarySystemPrompt: false,
		...options.budget,
	} as PersistedSubagentLaunchMetadata);
	writeSubagentTimeoutSidecar(sessionFile, { kind: "timeout", blocksResume: options.blocksResume });
	return sessionFile;
}

function createResumeRuntime() {
	const empty = async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 });
	return {
		isMuxAvailable: () => true,
		getShellReadyDelayMs: () => 0,
		watchBackgroundSubagent: empty,
		watchSubagent: empty,
		getWatcherSignal: (_running: unknown, controller: AbortController) => controller.signal,
		startWidgetRefresh: () => {},
		getContextWindow: () => undefined,
		runningSubagents: new Map<string, unknown>(),
		wireSubagentSteerBack: () => {},
		getLaunchedSubagentResult: async () => ({ content: [], details: {} }),
	};
}

function registerResumeTool(runtime: ReturnType<typeof createResumeRuntime>) {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown> }>();
	registerSubagentResumeTool(
		{
			registerTool(definition: { name: string }) {
				tools.set(definition.name, definition as never);
				return definition;
			},
		} as never,
		() => true,
		runtime as never,
	);
	return tools.get("subagent_resume")!;
}

function withFakePi<T>(bin: string, run: () => Promise<T>): Promise<T> {
	const original = process.env.PI_SUBAGENT_PI_COMMAND;
	process.env.PI_SUBAGENT_PI_COMMAND = bin;
	return run().finally(() => {
		if (original == null) delete process.env.PI_SUBAGENT_PI_COMMAND;
		else process.env.PI_SUBAGENT_PI_COMMAND = original;
	});
}

describe("timeout resume guard", () => {
	it("refuses an agent-initiated resume under on-timeout: block-resume", async () => {
		const dir = createTestDir();
		const spawnMarker = join(dir, "child-started.txt");
		const bin = writeExecutable(
			dir,
			"marker-pi",
			`#!/usr/bin/env bash\nprintf started > ${JSON.stringify(spawnMarker)}\n`,
		);
		await withFakePi(bin, async () => {
			const sessionFile = writeTimedOutSession(dir, "blocked-child.jsonl", { blocksResume: true });
			const tool = registerResumeTool(createResumeRuntime());

			await assert.rejects(
				() => tool.execute("call-1", { sessionFile }, undefined),
				/stopped this sub-agent because it went past its time limit[\s\S]*does not allow a resume[\s\S]*smaller task/,
			);
			assert.equal(existsSync(spawnMarker), false, "the guard must refuse before any child is started");
		});
	});

	it("still resumes a timed-out session under the default report policy", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeTimedOutSession(dir, "recoverable-child.jsonl", { blocksResume: false });

			const running = await withoutAmbientSpawnGrant(() =>
				resumeSubagentSession({ sessionFile, mode: "background" }, createResumeRuntime() as never),
			);

			assert.equal(running.sessionFile, sessionFile);
			assert.ok(running.childProcess, "a timeout alone must not make a session unrecoverable");
			assert.equal(
				readSubagentTimeoutSidecar(sessionFile),
				null,
				"a resume clears the spent verdict so a clean run releases the session",
			);
		});
	});

	it("re-arms the budgets from launch metadata so a resumed runaway is still bounded", async () => {
		const dir = createTestDir();
		const envDump = join(dir, "child-env.txt");
		const bin = writeExecutable(
			dir,
			"env-pi",
			`#!/usr/bin/env bash\nenv | grep '^PI_SUBAGENT_\\(TIMEOUT\\|IDLE_TIMEOUT\\)' | sort > ${JSON.stringify(envDump)}\n`,
		);
		await withFakePi(bin, async () => {
			const sessionFile = writeTimedOutSession(dir, "rearmed-child.jsonl", {
				blocksResume: false,
				budget: { timeout: 45, idleTimeout: 20, timeoutWarnThreshold: "80%", onTimeout: "report" },
			});

			const running = await withoutAmbientSpawnGrant(() =>
				resumeSubagentSession({ sessionFile, mode: "background" }, createResumeRuntime() as never),
			);

			assert.deepEqual(running.timeoutBudget, { timeoutSeconds: 45, idleTimeoutSeconds: 20 });
			assert.equal(running.timeoutBlocksResume, undefined);

			await new Promise((resolve) => running.childProcess?.once("exit", resolve));
			const childEnv = readFileSync(envDump, "utf8");
			assert.match(childEnv, /^PI_SUBAGENT_IDLE_TIMEOUT=20$/m);
			assert.match(childEnv, /^PI_SUBAGENT_TIMEOUT=45$/m);
			assert.match(childEnv, /^PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD=80%$/m);
			assert.match(childEnv, /^PI_SUBAGENT_TIMEOUT_STARTED_AT=\d+$/m);
		});
	});

	it("carries the resume block into a resumed run that times out again", async () => {
		const dir = createTestDir();
		const bin = writeExecutable(dir, "quiet-pi", "#!/usr/bin/env bash\nexit 0\n");
		await withFakePi(bin, async () => {
			const sessionFile = writeTimedOutSession(dir, "blocked-again.jsonl", {
				blocksResume: false,
				budget: { timeout: 30, onTimeout: "block-resume" },
			});

			const running = await withoutAmbientSpawnGrant(() =>
				resumeSubagentSession({ sessionFile, mode: "background" }, createResumeRuntime() as never),
			);

			assert.deepEqual(running.timeoutBudget, { timeoutSeconds: 30 });
			assert.equal(running.timeoutBlocksResume, true);
		});
	});
});
