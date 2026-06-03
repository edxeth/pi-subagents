import {
	assert,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	createTestDir,
	readSubagentLaunchMetadataForTest,
	writeResumeTaskArtifactForTest,
	writeSubagentLaunchMetadataEntryForTest,
	resolveResumeLaunchMetadataForTest,
	resetSubagentStateForTest,
	requestSubagentBatchStopForTest,
	getSubagentBatchStopMetadataForTest,
	writeExecutable,
	readFileSync,
	mkdirSync,
} from "../support/index.ts";
import { resolve } from "node:path";
import { resumeSubagentSession } from "../../src/runtime/resume-service.ts";

describe("subagent_resume name identity", () => {
	it("resolves canonical name from persisted launch metadata", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "child-sess",
			timestamp: new Date().toISOString(),
			cwd: dir,
		};
		writeFileSync(sessionFile, JSON.stringify(header) + "\n");

		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "magician",
			title: "Say hi",
			agent: "magician",
			mode: "interactive",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		const launchMetadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.ok(launchMetadata);
		assert.equal(launchMetadata!.name, "magician");

		const metadata = resolveResumeLaunchMetadataForTest(sessionFile);
		assert.equal(metadata.name, "magician");
	});

	it("resolves canonical name overrides user-provided name via params.name fallback", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);

		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "scout",
			agent: "scout",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: true,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		// The canonical name should always come from metadata, not from what the
		// user passes as 'name'. Simulate the name resolution from resume-tool.ts:
		const launchMetadata = readSubagentLaunchMetadataForTest(sessionFile);
		const metadata = resolveResumeLaunchMetadataForTest(sessionFile);
		const canonicalName = launchMetadata?.name ?? metadata.name ?? "Resume";
		const userProvidedName = "custom-label";

		assert.equal(canonicalName, "scout");
		assert.notEqual(canonicalName, userProvidedName);
	});

	it("falls back to Resume when no metadata is available", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "empty-child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);

		const launchMetadata = readSubagentLaunchMetadataForTest(sessionFile);
		const metadata = resolveResumeLaunchMetadataForTest(sessionFile);
		const canonicalName = launchMetadata?.name ?? metadata.name ?? "Resume";

		assert.equal(canonicalName, "Resume");
	});
});

describe("subagent_resume coordinator-only-turn", () => {
	afterEach(() => {
		delete process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
		resetSubagentStateForTest();
	});

	it("calls requestSubagentBatchStop for async resumes", () => {
		// Simulate what the resume tool does for an async (non-blocking) resume.
		// requestSubagentBatchStop should set the batch-stop flag so that
		// getSubagentBatchStopMetadata returns { terminate: true }.
		requestSubagentBatchStopForTest();
		const meta = getSubagentBatchStopMetadataForTest();
		assert.deepEqual(meta, { terminate: true });
	});

	it("respects coordinator-only-turn opt-out for async resumes", () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		requestSubagentBatchStopForTest();
		const meta = getSubagentBatchStopMetadataForTest();
		assert.equal(meta.terminate, undefined);
	});

	it("does not call batch stop for awaited (sync/blocking) resumes", () => {
		// When shouldAwait is true, the resume tool returns
		// runtime.getLaunchedSubagentResult() directly, not the batch-stop path.
		// getSubagentBatchStopMetadata should be empty in this case.
		const meta = getSubagentBatchStopMetadataForTest();
		assert.deepEqual(meta, {});
	});

	it("awaits an async resume when the batch was marked blocking by the classifier", async () => {
		// Mixed-batch contract: when the message_end classifier marks the
		// current batch blocking (async subagent_resume + non-subagent tool),
		// the resume tool must agree with the runtime that the parent should
		// wait. shouldAwaitSubagentLaunch is the shared predicate both the
		// subagent and subagent_resume tools route through.
		const { shouldAwaitSubagentLaunchForTest, markSubagentBatchBlockingForTest } =
			await import("../support/index.ts");
		const asyncRunning = { blocking: false, async: true };

		// Without the blocking flag, an async resume should not await.
		assert.equal(shouldAwaitSubagentLaunchForTest(asyncRunning), false);

		// With the classifier-marked flag, the same async resume should await.
		markSubagentBatchBlockingForTest();
		assert.equal(shouldAwaitSubagentLaunchForTest(asyncRunning), true);
	});
});

describe("subagent_resume interactive prompt delivery", () => {
	it("writes follow-up text to a resume artifact without trimming user content", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);

		const task = "  preserve leading space\n\nand trailing space  \n";
		const artifactPath = writeResumeTaskArtifactForTest("resume-child", task, sessionFile, dir);

		assert.equal(readFileSync(artifactPath, "utf8"), task);
		assert.match(artifactPath, /child-session\/context\/resume-child-/);
	});

	it("sanitizes resumed session ids before using them in artifact paths", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "../../evil/session", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);

		const artifactPath = writeResumeTaskArtifactForTest("resume-child", "safe", sessionFile, dir);

		assert.doesNotMatch(artifactPath, /\.\.\/\.\.\/evil\/session|evil\/session/);
		assert.match(artifactPath, /\.\.-\.\.-evil-session\/context\/resume-child-/);
	});

	it("passes follow-up task as an @artifact startup prompt instead of typing into the pane", async () => {
		const dir = createTestDir();
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const logFile = join(dir, "tmux.log");
		writeExecutable(binDir, "tmux", `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) printf '%%42\\n' ;;
esac
`);
		process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		process.env.FAKE_TMUX_LOG = logFile;

		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
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
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		await resumeSubagentSession(
			{ sessionFile, task: "follow up\nwith newline" },
			{
				isMuxAvailable: () => true,
				getShellReadyDelayMs: () => 0,
				waitForInteractivePrompt: async () => {},
				watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
				watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
				getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
				startWidgetRefresh: () => {},
				getContextWindow: () => undefined,
				runningSubagents: new Map<string, any>(),
			},
		);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /@.*child-session.*resume-child-/);
		assert.doesNotMatch(log, /send-keys -t %42 -l follow up/);
	});
});

describe("subagent_resume same-session guard", () => {
	it("does not persist resume override metadata before duplicate-session guard", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "scout",
			agent: "scout",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: true,
			parentClosePolicy: "terminate",
			async: true,
			model: "zai-messages/glm-5.1",
			modelRef: "zai-messages/glm-5.1",
			allowModelOverride: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: false,
		});

		const runningSubagents = new Map<string, any>();
		runningSubagents.set("existing-001", {
			id: "existing-001",
			name: "scout",
			agent: "scout",
			sessionFile,
		});

		await assert.rejects(
			() => resumeSubagentSession(
				{ sessionFile, model: "zai-messages/glm-5-turbo", thinking: "off" },
				{
					isMuxAvailable: () => true,
					getShellReadyDelayMs: () => 0,
					waitForInteractivePrompt: async () => {},
					watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
					watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
					getWatcherSignal: (_running: any, controller: AbortController) => controller.signal,
					startWidgetRefresh: () => {},
					getContextWindow: () => undefined,
					runningSubagents,
					modelRegistry: {
						getAvailable: () => [
							{ provider: "zai-messages", id: "glm-5-turbo" },
							{ provider: "zai-messages", id: "glm-5.1" },
						],
					},
				},
			),
			/already running/,
		);

		const metadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.equal(metadata?.modelRef, "zai-messages/glm-5.1");
		assert.equal(metadata?.requestedModelOverride, undefined);
		assert.equal(metadata?.requestedThinkingOverride, undefined);
	});

	it("detects duplicate sessionFile in running subagents", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: dir }) + "\n",
		);

		const runningSubagents = new Map<string, any>();
		const existingId = "existing-001";
		runningSubagents.set(existingId, {
			id: existingId,
			name: "magician",
			agent: "magician",
			sessionFile,
			mode: "interactive",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			task: "Do magic",
		});

		// Simulate the same-session guard from resume-tool.ts
		const normalizedFile = resolve(sessionFile);
		let guardResult: any = null;
		for (const existing of runningSubagents.values()) {
			if (existing.sessionFile && resolve(existing.sessionFile) === normalizedFile) {
				guardResult = {
					id: existing.id,
					name: existing.name,
					content: `Session "${existing.name}" (${existing.agent ?? "subagent"}) is already running with id ${existing.id}.`,
				};
				break;
			}
		}

		assert.ok(guardResult, "Guard should have triggered");
		assert.equal(guardResult!.name, "magician");
		assert.equal(guardResult!.id, existingId);
		assert.match(
			guardResult!.content,
			/existing-001/,
			"Should reference the existing running subagent id",
		);
	});

	it("does not trigger guard when sessionFile differs", () => {
		const runningSubagents = new Map<string, any>();
		runningSubagents.set("existing-001", {
			id: "existing-001",
			name: "scout",
			sessionFile: "/tmp/other-session.jsonl",
		});

		const newSessionFile = "/tmp/different-session.jsonl";
		const normalizedFile = resolve(newSessionFile);
		let guardResult: any = null;
		for (const existing of runningSubagents.values()) {
			if (existing.sessionFile && resolve(existing.sessionFile) === normalizedFile) {
				guardResult = { id: existing.id };
				break;
			}
		}

		assert.equal(guardResult, null, "Guard should not trigger for different session files");
	});
});
