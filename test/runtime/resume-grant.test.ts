import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildResumeSpawnEnv,
	narrowSpawnBudget,
} from "../../src/spawn/policy.ts";
import {
	readSubagentLaunchMetadata,
	writeSubagentLaunchMetadataEntry,
	type PersistedSubagentLaunchMetadata,
} from "../../src/session/session-files.ts";
import { getPersistedSessionParityArgsForTest } from "../support/index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createSessionFile(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-subagents-resume-grant-"));
	temporaryDirectories.push(directory);
	const sessionFile = join(directory, "child.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: "2026-08-07T00:00:00.000Z",
			cwd: directory,
		})}\n`,
	);
	return sessionFile;
}

function launchMetadata(
	sessionFile: string,
	spawnBudget: number | null | undefined,
): PersistedSubagentLaunchMetadata {
	const cwd = dirname(sessionFile);
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: "worker-child",
		agent: "worker",
		mode: "background",
		sessionMode: "lineage-only",
		parentClosePolicy: "terminate",
		async: true,
		denyTools: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: cwd,
		cwd,
		boundarySystemPrompt: false,
		...(spawnBudget === undefined ? {} : { spawnBudget }),
		spawnableAgents: ["grandchild"],
	};
}

describe("resume spawn grant", () => {
	it("uses the first valid launch metadata entry for spawn authority", () => {
		const sessionFile = createSessionFile();
		writeSubagentLaunchMetadataEntry(sessionFile, launchMetadata(sessionFile, 0));
		writeSubagentLaunchMetadataEntry(sessionFile, launchMetadata(sessionFile, 5));

		assert.equal(readSubagentLaunchMetadata(sessionFile)?.spawnBudget, 0);
	});

	it("narrows persisted spawn budgets against the current caller grant", () => {
		assert.equal(narrowSpawnBudget({ spawnBudget: 1 }, 1, null), 0);
		assert.equal(narrowSpawnBudget({ spawnBudget: 2 }, null, null), 2);
		assert.equal(narrowSpawnBudget({}, null, null), 0);
		assert.equal(narrowSpawnBudget({ spawnBudget: 5 }, null, 3), 3);
	});

	it("serializes a fail-closed resume grant without inheriting spawn state", () => {
		assert.deepEqual(buildResumeSpawnEnv({ spawnableAgents: [] }, 0, null), {
			PI_SUBAGENT_SPAWN_BUDGET: "0",
			PI_SUBAGENT_SPAWNABLE: "",
			PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE: "",
			denyToolsToAdd: ["subagent", "subagent_resume", "subagent_kill"],
		});
		assert.deepEqual(buildResumeSpawnEnv({ spawnableAgents: true }, 2, 3), {
			PI_SUBAGENT_SPAWN_BUDGET: "2",
			PI_SUBAGENT_SPAWNABLE: "true",
			PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE: "3",
			denyToolsToAdd: [],
		});
	});

	it("keeps the resume deny list and the resumed tools allowlist in agreement", async () => {
		const narrowedGranted = narrowSpawnBudget({ spawnBudget: 2 }, null, null);
		const narrowedExhausted = narrowSpawnBudget({ spawnBudget: 1 }, 1, null);
		const metadata = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "resumed-child",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			trustProject: false,
			tools: "exec_command",
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: false,
		};

		assert.equal(narrowedGranted > 0, true);
		assert.deepEqual(buildResumeSpawnEnv({ spawnableAgents: true }, narrowedGranted, null).denyToolsToAdd, []);
		assert.deepEqual(await getPersistedSessionParityArgsForTest(metadata, "background", narrowedGranted > 0), [
			"--tools",
			"exec_command,caller_ping,subagent_done,subagent,subagent_resume,subagent_kill",
			"--no-approve",
		]);

		assert.equal(narrowedExhausted > 0, false);
		assert.deepEqual(buildResumeSpawnEnv({ spawnableAgents: true }, narrowedExhausted, null).denyToolsToAdd, [
			"subagent",
			"subagent_resume",
			"subagent_kill",
		]);
		assert.deepEqual(await getPersistedSessionParityArgsForTest(metadata, "background", narrowedExhausted > 0), [
			"--tools",
			"exec_command,caller_ping,subagent_done",
			"--no-approve",
		]);
	});
});
