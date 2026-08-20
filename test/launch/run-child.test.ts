import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, createTestDir, describe, it, readFileSync, rmSync } from "../support/index.ts";
import { PANE_IDENTITY_ENV_PATTERNS } from "../../src/launch/child-env.ts";
import { writeEnvCapsule } from "../../src/launch/env-capsule.ts";

const LAUNCHER_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "launch", "run-child.mjs");

function runLauncher(capsule: Parameters<typeof writeEnvCapsule>[0], paneEnv: Record<string, string>) {
	const root = createTestDir();
	const capsulePath = writeEnvCapsule(capsule, root);
	const result = spawnSync(process.execPath, [LAUNCHER_PATH, capsulePath], {
		env: paneEnv,
		encoding: "utf8",
		timeout: 30_000,
	});
	return { result, capsulePath, root };
}

function envDumpCommand(outFile: string): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))", outFile],
	};
}

describe("run-child launcher", () => {
	it("merges parent snapshot, pane identity, and overrides in precedence order", () => {
		const outFile = join(createTestDir(), "env.json");
		const { result, capsulePath, root } = runLauncher(
			{
				...envDumpCommand(outFile),
				parentEnv: { PARENT_VAR: "parent", OPENCODE_API_KEY: "sk-parent" },
				overrides: { PARENT_VAR: "overridden", PI_SUBAGENT_NAME: "child" },
				paneIdentityKeys: [...PANE_IDENTITY_ENV_PATTERNS],
			},
			{
				ZELLIJ_PANE_ID: "9",
				TERM: "screen-256color",
				DAEMON_VAR: "daemon",
				PATH: process.env.PATH ?? "/usr/bin",
			},
		);

		assert.equal(result.error, undefined, result.stderr);
		assert.equal(result.status, 0, result.stderr);
		const childEnv = JSON.parse(readFileSync(outFile, "utf8"));
		assert.equal(childEnv.PARENT_VAR, "overridden", "overrides must beat the parent snapshot");
		assert.equal(childEnv.OPENCODE_API_KEY, "sk-parent", "ambient parent env must reach the child");
		assert.equal(childEnv.ZELLIJ_PANE_ID, "9", "pane identity must come from the pane shell env");
		assert.equal(childEnv.TERM, "screen-256color");
		assert.equal(childEnv.DAEMON_VAR, undefined, "non-identity pane env must not leak into the child");
		assert.equal(childEnv.PI_SUBAGENT_NAME, "child");
		assert.equal(existsSync(capsulePath), false, "capsule must be unlinked after read");
		rmSync(root, { recursive: true, force: true });
	});

	it("derives PI_SUBAGENT_SURFACE from the child pane when asked", () => {
		const outFile = join(createTestDir(), "env.json");
		const { result, root } = runLauncher(
			{
				...envDumpCommand(outFile),
				parentEnv: {},
				overrides: {},
				paneIdentityKeys: [...PANE_IDENTITY_ENV_PATTERNS],
				deriveZellijPaneSurface: true,
			},
			{ ZELLIJ_PANE_ID: "42", PATH: process.env.PATH ?? "/usr/bin" },
		);

		assert.equal(result.status, 0, result.stderr);
		const childEnv = JSON.parse(readFileSync(outFile, "utf8"));
		assert.equal(childEnv.PI_SUBAGENT_SURFACE, "pane:42");
		rmSync(root, { recursive: true, force: true });
	});

	it("propagates the child exit code", () => {
		const { result, root } = runLauncher(
			{ command: process.execPath, args: ["-e", "process.exit(42)"], parentEnv: {}, overrides: {}, paneIdentityKeys: [] },
			{ PATH: process.env.PATH ?? "/usr/bin" },
		);
		assert.equal(result.status, 42);
		rmSync(root, { recursive: true, force: true });
	});

	it("exits with an error and no crash when the capsule is missing", () => {
		const result = spawnSync(process.execPath, [LAUNCHER_PATH, "/nonexistent/capsule.json"], {
			env: { PATH: process.env.PATH ?? "/usr/bin" },
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /cannot read capsule/);
	});

	it("exits with an error when no capsule path is given", () => {
		const result = spawnSync(process.execPath, [LAUNCHER_PATH], {
			env: { PATH: process.env.PATH ?? "/usr/bin" },
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /missing capsule path/);
	});

	it("mirrors child termination by signal", () => {
		const { result, root } = runLauncher(
			{ command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')"], parentEnv: {}, overrides: {}, paneIdentityKeys: [] },
			{ PATH: process.env.PATH ?? "/usr/bin" },
		);
		assert.equal(result.signal, "SIGTERM");
		assert.notEqual(result.status, 0);
		rmSync(root, { recursive: true, force: true });
	});

	it("unlinks a malformed capsule before exiting with an error", () => {
		const dir = join(tmpdir(), `pi-subagent-env-badcaps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		const capsulePath = join(dir, "capsule.json");
		writeFileSync(capsulePath, "{ not valid json", { mode: 0o600 });

		const result = spawnSync(process.execPath, [LAUNCHER_PATH, capsulePath], {
			env: { PATH: process.env.PATH ?? "/usr/bin" },
			encoding: "utf8",
			timeout: 30_000,
		});

		assert.equal(result.status, 2);
		assert.equal(existsSync(capsulePath), false, "malformed capsule must still be consumed");
		rmSync(dir, { recursive: true, force: true });
	});

	it("drops env keys that cannot round-trip through execve", () => {
		const outFile = join(createTestDir(), "env.json");
		const { result, root } = runLauncher(
			{
				...envDumpCommand(outFile),
				parentEnv: { "BAD=KEY": "v", FINE_KEY: "ok" },
				overrides: {},
				paneIdentityKeys: [],
			},
			{ PATH: process.env.PATH ?? "/usr/bin" },
		);

		assert.equal(result.status, 0, result.stderr);
		const childEnv = JSON.parse(readFileSync(outFile, "utf8"));
		assert.equal(childEnv["BAD=KEY"], undefined);
		assert.equal(childEnv.FINE_KEY, "ok");
		rmSync(root, { recursive: true, force: true });
	});
});
