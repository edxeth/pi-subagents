import {
	resolveResumeHerdrPlacementPolicy,
	resolveResumeZellijPlacementPolicy,
} from "../../src/runtime/resume-service.ts";
import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	readSubagentLaunchMetadataForTest,
	resolveResumeLaunchMetadataForTest,
	writeFileSync,
	writeSubagentLaunchMetadataEntryForTest,
} from "../support/index.ts";

describe("subagent_resume Herdr placement", () => {
	it("keeps the persisted per-agent policy over the current parent default", () => {
		assert.equal(
			resolveResumeHerdrPlacementPolicy(
				{
					env: "PI_SUBAGENT_HERDR_PLACEMENT=tab",
					herdrPlacementPolicy: "tab",
				} as Parameters<typeof resolveResumeHerdrPlacementPolicy>[0],
				"auto",
			),
			"tab",
		);
	});

	it("lets the current parent default override a persisted operator policy", () => {
		assert.equal(
			resolveResumeHerdrPlacementPolicy(
				{ herdrPlacementPolicy: "down-stack" } as Parameters<typeof resolveResumeHerdrPlacementPolicy>[0],
				"tab",
			),
			"tab",
		);
	});

	it("treats an empty persisted agent value as an explicit auto override", () => {
		assert.equal(
			resolveResumeHerdrPlacementPolicy(
				{
					env: "PI_SUBAGENT_HERDR_PLACEMENT=",
					herdrPlacementPolicy: "tab",
				} as Parameters<typeof resolveResumeHerdrPlacementPolicy>[0],
				"down",
			),
			"auto",
		);
	});

	it("uses the current parent default when old metadata has no persisted policy", () => {
		assert.equal(resolveResumeHerdrPlacementPolicy(undefined, "right-stack"), "right-stack");
	});

	it("treats an empty current parent value as an explicit auto override", () => {
		assert.equal(
			resolveResumeHerdrPlacementPolicy(
				{ herdrPlacementPolicy: "tab" } as Parameters<typeof resolveResumeHerdrPlacementPolicy>[0],
				"",
			),
			"auto",
		);
	});
});

describe("subagent_resume Zellij placement", () => {
	it("keeps the persisted per-agent policy over the current parent default", () => {
		assert.equal(
			resolveResumeZellijPlacementPolicy(
				{
					env: "PI_SUBAGENT_ZELLIJ_PLACEMENT=down-stack",
					zellijPlacementPolicy: "down-stack",
				} as Parameters<typeof resolveResumeZellijPlacementPolicy>[0],
				"floating",
			),
			"down-stack",
		);
	});

	it("lets the current parent default override a persisted operator policy", () => {
		assert.equal(
			resolveResumeZellijPlacementPolicy(
				{ zellijPlacementPolicy: "down-stack" } as Parameters<typeof resolveResumeZellijPlacementPolicy>[0],
				"floating",
			),
			"floating",
		);
	});

	it("treats an empty persisted agent value as an explicit auto override", () => {
		assert.equal(
			resolveResumeZellijPlacementPolicy(
				{
					env: "PI_SUBAGENT_ZELLIJ_PLACEMENT=",
					zellijPlacementPolicy: "down-stack",
				} as Parameters<typeof resolveResumeZellijPlacementPolicy>[0],
				"floating",
			),
			"auto",
		);
	});

	it("uses the current parent default when old metadata has no persisted policy", () => {
		assert.equal(resolveResumeZellijPlacementPolicy(undefined, "right-stack"), "right-stack");
	});

	it("treats an empty current parent value as an explicit auto override", () => {
		assert.equal(
			resolveResumeZellijPlacementPolicy(
				{ zellijPlacementPolicy: "down-stack" } as Parameters<typeof resolveResumeZellijPlacementPolicy>[0],
				"",
			),
			"auto",
		);
	});
});

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
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);

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
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "s",
				timestamp: new Date().toISOString(),
				cwd: dir,
			})}\n`,
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
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "s",
				timestamp: new Date().toISOString(),
				cwd: dir,
			})}\n`,
		);

		const launchMetadata = readSubagentLaunchMetadataForTest(sessionFile);
		const metadata = resolveResumeLaunchMetadataForTest(sessionFile);
		const canonicalName = launchMetadata?.name ?? metadata.name ?? "Resume";

		assert.equal(canonicalName, "Resume");
	});
});
