import {
	afterEach,
	assert,
	describe,
	it,
	join,
	mkdirSync,
	readSubagentLaunchMetadataForTest,
	resetSubagentStateForTest,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";

describe("auto-exit persistence (no headless override leakage)", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("preserves auto-exit: false in persisted metadata", async () => {
		const dir = "/tmp/pi-subagent-test-" + Math.random().toString(16).slice(2);
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "child.jsonl");

		// Write minimal session header
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "test-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		// Write metadata with auto-exit: false (as the agent file specifies)
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "test-child",
			mode: "background",
			sessionMode: "lineage-only",
			autoExit: false,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			model: "nahcrof/deepseek-v4-flash",
			thinking: "low",
			modelRef: "nahcrof/deepseek-v4-flash:low",
			tools: "read,bash,grep,find,ls",
			denyTools: ["subagent", "subagent_resume"],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp/pi-subagent-test",
			cwd: dir,
			boundarySystemPrompt: false,
		});

		// Read back the metadata
		const metadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.ok(metadata, "metadata should be readable");
		assert.equal(metadata!.autoExit, false, "autoExit should be false in persisted metadata");
		assert.equal(metadata!.model, "nahcrof/deepseek-v4-flash", "model should be preserved");
		assert.equal(metadata!.thinking, "low", "thinking should be preserved");
		assert.equal(metadata!.tools, "read,bash,grep,find,ls", "tools should be preserved");
	});

	it("correctly reads auto-exit: false on resume", async () => {
		const dir = "/tmp/pi-subagent-test-" + Math.random().toString(16).slice(2);
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "child.jsonl");

		// Session header
		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "test-session-2",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		// Write metadata as it would be persisted after the fix
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "resume-child",
			mode: "background",
			sessionMode: "fork",
			autoExit: false,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			model: "zai-messages/glm-5-turbo",
			thinking: "low",
			modelRef: "zai-messages/glm-5-turbo:low",
			denyTools: ["subagent", "subagent_resume"],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: true,
		});

		// Simulate what resume-tool does: read metadata and use autoExit
		const metadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.ok(metadata, "metadata should be readable");

		// Simulate the resume-tool logic
		const resumedAutoExit = metadata!.autoExit ?? true;
		assert.equal(resumedAutoExit, false, "resume should honor auto-exit: false");

		// Verify model params are also preserved
		assert.equal(metadata!.modelRef, "zai-messages/glm-5-turbo:low", "modelRef with thinking should be preserved");
	});

	it("handles missing auto-exit field gracefully (no agent default)", async () => {
		const dir = "/tmp/pi-subagent-test-" + Math.random().toString(16).slice(2);
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "child.jsonl");

		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "test-session-3",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		// Metadata without autoExit field
		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "no-autoexit-child",
			mode: "background",
			sessionMode: "lineage-only",
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

		const metadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.ok(metadata, "metadata should be readable even without autoExit");
		// autoExit should be undefined when not set
		assert.equal(metadata!.autoExit, undefined, "autoExit should be undefined when not in metadata");
	});

	it("round-trips auto-exit: true correctly", async () => {
		const dir = "/tmp/pi-subagent-test-" + Math.random().toString(16).slice(2);
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "child.jsonl");

		writeFileSync(
			sessionFile,
			JSON.stringify({
				type: "session",
				version: 3,
				id: "test-session-4",
				timestamp: new Date().toISOString(),
				cwd: dir,
			}) + "\n",
		);

		await writeSubagentLaunchMetadataEntryForTest(sessionFile, {
			version: 1,
			timestamp: new Date().toISOString(),
			name: "autoexit-child",
			mode: "background",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "terminate",
			blocking: false,
			async: true,
			model: "nahcrof/deepseek-v4-flash",
			modelRef: "nahcrof/deepseek-v4-flash",
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: true,
		});

		const metadata = readSubagentLaunchMetadataForTest(sessionFile);
		assert.ok(metadata, "metadata should be readable");
		assert.equal(metadata!.autoExit, true, "autoExit should be true");
		assert.equal(metadata!.model, "nahcrof/deepseek-v4-flash", "model preserved");
	});
});
