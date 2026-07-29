import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assert, createTestDir } from "../support/index.ts";
import {
	clearSubagentExitSidecar,
	getSubagentExitSidecarPath,
	writeSubagentExitSidecar,
} from "../../src/session/exit-sidecar.ts";
import { consumeSubagentExitSignal } from "../../src/mux/poll.ts";

describe("subagent exit sidecars", () => {
	it("stores exit sidecars next to the child session and consumes them once", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 7 }));

		assert.equal(exitFile, `${sessionFile}.exit`);
		assert.deepEqual(consumeSubagentExitSignal(sessionFile), {
			reason: "done",
			exitCode: 0,
			outputTokens: 7,
		});
		assert.equal(existsSync(exitFile), false);
		assert.equal(consumeSubagentExitSignal(sessionFile), null);
	});

	it("supersedes only existing error signals when requested", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);

		for (const replacement of [
			{ type: "done", outputTokens: 8 },
			{ type: "ping", message: "help" },
		]) {
			writeFileSync(exitFile, JSON.stringify({ type: "error", errorMessage: "transient" }));
			writeSubagentExitSidecar(sessionFile, replacement, { supersede: true });
			assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), replacement);
		}
	});

	it("never supersedes existing done or ping signals", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);

		for (const existing of [{ type: "done" }, { type: "ping", message: "help" }]) {
			writeFileSync(exitFile, JSON.stringify(existing));
			writeSubagentExitSidecar(sessionFile, { type: "done", outputTokens: 8 }, { supersede: true });
			assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), existing);
		}
	});

	it("keeps first-write-wins behavior by default", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		const error = { type: "error", errorMessage: "failure" };
		writeFileSync(exitFile, JSON.stringify(error));

		writeSubagentExitSidecar(sessionFile, { type: "done" });

		assert.deepEqual(JSON.parse(readFileSync(exitFile, "utf8")), error);
	});

	it("clears stale sidecars before reusing a session path", () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "resumed-child.jsonl");
		const exitFile = getSubagentExitSidecarPath(sessionFile);
		writeFileSync(sessionFile, "");
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 99 }));

		clearSubagentExitSidecar(sessionFile);

		assert.equal(existsSync(exitFile), false);
		assert.equal(consumeSubagentExitSignal(sessionFile), null);
		writeFileSync(exitFile, JSON.stringify({ type: "done", outputTokens: 3 }));
		assert.equal(readFileSync(exitFile, "utf8"), JSON.stringify({ type: "done", outputTokens: 3 }));
	});
});
