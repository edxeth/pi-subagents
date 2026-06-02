import {
	ASSISTANT_MSG,
	MODEL_CHANGE,
	SESSION_HEADER,
	USER_MSG,
	assert,
	createTestDir,
	describe,
	getEntries,
	it,
	join,
	writeFileSync,
} from "../support/index.ts";
import { ChildSessionStorage } from "../../src/session/child-session-storage.ts";
import type { PersistedSubagentLaunchMetadata } from "../../src/session/session-files.ts";

function launchMetadata(cwd: string): PersistedSubagentLaunchMetadata {
	return {
		version: 1,
		timestamp: "2026-06-01T00:00:00.000Z",
		name: "child-audit",
		title: "Child audit",
		sessionTitle: "[scout agent] Child audit",
		agent: "scout",
		mode: "background",
		sessionMode: "fork",
		parentClosePolicy: "terminate",
		async: true,
		model: "provider/model",
		thinking: "high",
		modelRef: "provider/model:high",
		allowModelOverride: true,
		modelSource: "launch-override",
		tools: "read,bash",
		skills: "none",
		denyTools: ["bash"],
		extensions: [],
		noContextFiles: false,
		noSession: false,
		agentConfigDir: cwd,
		cwd,
		boundarySystemPrompt: true,
	};
}

describe("child session storage", () => {
	it("seeds a child session and persists launch facts through one module", async () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(
			parent,
			`${[SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const storage = new ChildSessionStorage(child);
		const metadata = launchMetadata(dir);

		storage.seed("fork", parent, dir, {
			sessionName: metadata.sessionTitle,
			activeLeafId: "asst-001",
		});
		storage.writeModelState(metadata);
		await storage.writeLaunchMetadataWhenReady(metadata, 0);
		storage.writeExtensionEntry(metadata.extensions);

		const entries = getEntries(child) as Array<Record<string, unknown>>;
		assert.equal(entries[0].type, "session");
		assert.equal(entries[0].parentSession, parent);
		assert.equal(entries[0].name, metadata.sessionTitle);
		assert.equal(entries.some((entry) => entry.type === "model_change"), true);
		assert.equal(entries.some((entry) => entry.type === "thinking_level_change"), true);
		assert.deepEqual(storage.readLaunchMetadata(), metadata);
		assert.deepEqual(storage.readExtensionEntry(), []);
	});
});
