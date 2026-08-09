import { join } from "node:path";
import { describe, it } from "node:test";
import { createExitSignalWriter } from "../../src/tools/exit-signal.ts";
import { assert, createTestDir, readFileSync, rmSync, writeFileSync } from "../support/index.ts";

function setup() {
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, "");
	const entries: Array<{ customType: string; data: unknown }> = [];
	const writeExitSignal = createExitSignalWriter({
		pi: {
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data });
			},
		} as never,
		getFinalContextUsage: () => undefined,
		hasDeliveredFinalWarning: () => true,
	});
	const readSidecar = () => JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
	return { dir, sessionFile, entries, writeExitSignal, readSidecar };
}

describe("child exit signal", () => {
	it("marks context pressure on a normal completion", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			writeExitSignal({ type: "done", outputTokens: 3 });

			assert.equal(readSidecar().completionReason, "context-pressure");
			assert.deepEqual(entries.at(-1), {
				customType: "pi-subagent-completion",
				data: { reason: "context-pressure" },
			});
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records nothing when a ping already owns the outcome", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			// caller_ping writes its outcome and then requests shutdown, which
			// emits a `done` the sidecar refuses. That refused write must not
			// block the resume caller_ping promises the parent.
			writeExitSignal({ type: "ping", name: "child", message: "need help" });
			writeExitSignal({ type: "done", outputTokens: 0 });

			assert.equal(readSidecar().type, "ping");
			assert.equal(readSidecar().completionReason, undefined);
			assert.deepEqual(entries, [], "a refused exit write must not record an outcome");
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("flags a failure that happened while the context was spent", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			// A failure is not an instructed wrap-up, but the parent still needs
			// to know the context was spent. This must not record an outcome that
			// blocks resume.
			writeExitSignal({ type: "error", errorMessage: "provider down" });

			assert.equal(readSidecar().completionReason, "context-pressure-failure");
			assert.deepEqual(entries, []);
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not mark a shutdown the child did not decide", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			// A pane closed by the operator is a lifecycle event, not the child
			// deciding to stop, even if a final warning is still held.
			writeExitSignal({ type: "done", outputTokens: 0 }, { autonomous: false });

			assert.equal(readSidecar().completionReason, undefined);
			assert.deepEqual(entries.at(-1), {
				customType: "pi-subagent-completion",
				data: { reason: "normal" },
			});
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("still lets a genuine completion supersede an earlier error", () => {
		const { dir, sessionFile, entries, writeExitSignal, readSidecar } = setup();
		const originalSession = process.env.PI_SUBAGENT_SESSION;
		process.env.PI_SUBAGENT_SESSION = sessionFile;
		try {
			writeExitSignal({ type: "error", errorMessage: "provider down" });
			writeExitSignal({ type: "done", outputTokens: 1 }, { supersede: true });

			assert.equal(readSidecar().type, "done");
			assert.equal(readSidecar().completionReason, "context-pressure");
			assert.deepEqual(entries.at(-1)?.data, { reason: "context-pressure" });
		} finally {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
