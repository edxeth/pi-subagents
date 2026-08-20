import { mkdirSync, readdirSync } from "node:fs";
import { launchInteractiveSubagent } from "../../src/launch/interactive.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

describe("interactive launch capsule ownership", () => {
	it("deletes the capsule when command delivery to the pane fails", async () => {
		const dir = createTestDir();
		const capsuleRoot = join(dir, "capsules");
		mkdirSync(capsuleRoot, { recursive: true });
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeExecutable(
			binDir,
			"tmux",
			`#!/usr/bin/env bash
case "$1" in
  new-window) printf '%%42\\n' ;;
  send-keys) exit 7 ;;
esac
`,
		);
		const originalPath = process.env.PATH;
		const originalMux = process.env.PI_SUBAGENT_MUX;
		const originalTmux = process.env.TMUX;
		process.env.PATH = `${binDir}:${originalPath ?? ""}`;
		process.env.PI_SUBAGENT_MUX = "tmux";
		process.env.TMUX = "fake-tmux-socket";
		const originalCapsuleDir = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
		process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = capsuleRoot;

		try {
			const agentDir = join(dir, ".pi", "agents");
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(agentDir, "delivery-probe.md"),
				"---\nname: delivery-probe\nauto-exit: true\n---\nProbe body.",
			);
			const parentSession = join(dir, "parent.jsonl");
			writeFileSync(
				parentSession,
				`${JSON.stringify({ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: dir })}\n`,
			);

			await assert.rejects(
				launchInteractiveSubagent(
					{ name: "delivery-failure-child", title: "Delivery failure child", task: "Probe.", agent: "delivery-probe" },
					{
						cwd: dir,
						sessionManager: {
							getSessionFile: () => parentSession,
							getSessionId: () => "parent",
							getLeafId: () => "asst-001",
						},
					},
					{ getContextWindow: () => undefined, getShellReadyDelayMs: () => 0 },
				),
				/send-keys|Command failed|tmux/i,
			);

			assert.equal(
				existsSync(capsuleRoot) ? readdirSync(capsuleRoot).length : 0,
				0,
				"an unconsumed capsule must not survive a failed pane delivery",
			);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalMux === undefined) delete process.env.PI_SUBAGENT_MUX;
			else process.env.PI_SUBAGENT_MUX = originalMux;
			if (originalTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = originalTmux;
			if (originalCapsuleDir === undefined) delete process.env.PI_SUBAGENT_ENV_CAPSULE_DIR;
			else process.env.PI_SUBAGENT_ENV_CAPSULE_DIR = originalCapsuleDir;
		}
	});
});
