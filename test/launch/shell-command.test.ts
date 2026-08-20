import { existsSync, statSync } from "node:fs";
import { assert, createTestDir, describe, it, readFileSync, rmSync, writeExecutable } from "../support/index.ts";
import { buildInteractiveShellCommand, getRunChildLauncherPath } from "../../src/launch/shell-command.ts";

describe("interactive shell command builder", () => {
	it("exposes a packaged launcher path", () => {
		assert.ok(getRunChildLauncherPath().endsWith("run-child.mjs"));
		assert.equal(existsSync(getRunChildLauncherPath()), true);
	});

	it("builds a command that carries only paths, and a capsule that carries the launch", () => {
		const root = createTestDir();
		const fakePi = writeExecutable(root, "fake-pi", "#!/bin/sh\nexit 0\n");
		const previous = process.env.PI_SUBAGENT_PI_COMMAND;
		process.env.PI_SUBAGENT_PI_COMMAND = fakePi;
		process.env.LEAK_PROBE = "leaky-secret-value";
		try {
			const { command, capsulePath } = buildInteractiveShellCommand({
				cwd: "/some/cwd",
				piArgs: ["--session", "/tmp/s.jsonl", "@/tmp/task.md"],
				envOverrides: { PI_SUBAGENT_NAME: "child", SECRET_OVERRIDE: "override-secret" },
				doneSentinelFile: "/tmp/done.txt",
			});

			assert.ok(command.startsWith("trap "));
			assert.ok(command.includes("cd '/some/cwd' && "));
			assert.ok(command.includes(getRunChildLauncherPath()));
			assert.ok(command.includes(capsulePath));
			// The observable pane command must not carry any env material.
			assert.ok(!command.includes("leaky-secret-value"));
			assert.ok(!command.includes("override-secret"));
			assert.ok(!command.includes("PI_SUBAGENT_NAME"));
			assert.ok(!command.includes("--session"));

			assert.equal(existsSync(capsulePath), true);
			assert.equal(statSync(capsulePath).mode & 0o777, 0o600);
			const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
			assert.equal(capsule.command, fakePi);
			assert.deepEqual(capsule.args, ["--session", "/tmp/s.jsonl", "@/tmp/task.md"]);
			assert.equal(capsule.cwd, "/some/cwd");
			assert.equal(capsule.overrides.PI_SUBAGENT_NAME, "child");
			assert.equal(capsule.overrides.SECRET_OVERRIDE, "override-secret");
			assert.equal(capsule.parentEnv.LEAK_PROBE, "leaky-secret-value");
			rmSync(capsulePath.slice(0, capsulePath.lastIndexOf("/")), { recursive: true, force: true });
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
			else process.env.PI_SUBAGENT_PI_COMMAND = previous;
			delete process.env.LEAK_PROBE;
		}
	});

	it("filters the parent snapshot with deny-env patterns and strips shell bookkeeping", () => {
		const previousGlobal = process.env.PI_SUBAGENT_ENV_DENY;
		process.env.TEST_DENY_A = "a";
		process.env.TEST_KEEP_B = "b";
		process.env.PWD = "/should/not/survive";
		process.env.PI_SUBAGENT_ENV_DENY = "TEST_DENY_*";
		try {
			const { capsulePath } = buildInteractiveShellCommand({
				piArgs: [],
				envOverrides: {},
				doneSentinelFile: "/tmp/done.txt",
				denyEnv: "TEST_KEEP_B, NONEXISTENT_*",
			});
			const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
			assert.equal(capsule.parentEnv.TEST_DENY_A, undefined, "global deny must filter the snapshot");
			assert.equal(capsule.parentEnv.TEST_KEEP_B, undefined, "agent deny-env must filter the snapshot");
			assert.equal(capsule.parentEnv.PWD, undefined);
			rmSync(capsulePath.slice(0, capsulePath.lastIndexOf("/")), { recursive: true, force: true });
		} finally {
			delete process.env.TEST_DENY_A;
			delete process.env.TEST_KEEP_B;
			delete process.env.PWD;
			if (previousGlobal === undefined) delete process.env.PI_SUBAGENT_ENV_DENY;
			else process.env.PI_SUBAGENT_ENV_DENY = previousGlobal;
		}
	});

	it("marks the capsule for zellij pane surface derivation", () => {
		const { capsulePath } = buildInteractiveShellCommand({
			piArgs: [],
			envOverrides: {},
			doneSentinelFile: "/tmp/done.txt",
			deriveZellijPaneSurface: true,
		});
		const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
		assert.equal(capsule.deriveZellijPaneSurface, true);
		assert.ok(Array.isArray(capsule.paneIdentityKeys) && capsule.paneIdentityKeys.length > 0);
		rmSync(capsulePath.slice(0, capsulePath.lastIndexOf("/")), { recursive: true, force: true });
	});
});
