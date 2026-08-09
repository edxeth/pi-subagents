import { join } from "node:path";
import { describe, it } from "node:test";
import { endedUnderContextPressure } from "../../src/session/completion-reason.ts";
import { assert, createTestDir, rmSync, writeFileSync } from "../support/index.ts";

function writeSession(dir: string, entries: object[]): string {
	const file = join(dir, "child.jsonl");
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

const marker = (id: string, parentId: string | undefined, reason: string) => ({
	id,
	...(parentId ? { parentId } : {}),
	type: "custom",
	customType: "pi-subagent-completion",
	data: { reason },
});

describe("completion reason", () => {
	it("reports pressure recorded on the active branch", () => {
		const dir = createTestDir();
		try {
			const file = writeSession(dir, [
				{ id: "root", type: "message" },
				marker("pressure", "root", "context-pressure"),
			]);
			assert.equal(endedUnderContextPressure(file), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores a marker left on an abandoned branch", () => {
		const dir = createTestDir();
		try {
			// The pressure marker belongs to a sibling branch. The active leaf
			// never descends from it, so it must not block this session.
			const file = writeSession(dir, [
				{ id: "root", type: "message" },
				marker("abandoned", "root", "context-pressure"),
				{ id: "clean-branch", parentId: "root", type: "message" },
			]);
			assert.equal(endedUnderContextPressure(file), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets a later clean completion on the same branch release the block", () => {
		const dir = createTestDir();
		try {
			const file = writeSession(dir, [
				{ id: "root", type: "message" },
				marker("pressure", "root", "context-pressure"),
				marker("clean", "pressure", "normal"),
			]);
			assert.equal(endedUnderContextPressure(file), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
