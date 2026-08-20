import { chmodSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, createTestDir, describe, it, readFileSync, rmSync } from "../support/index.ts";
import {
	DEFAULT_ENV_CAPSULE_MAX_AGE_MS,
	ENV_CAPSULE_DIR_PREFIX,
	sweepStaleEnvCapsules,
	writeEnvCapsule,
} from "../../src/launch/env-capsule.ts";

function capsuleDirOf(capsulePath: string): string {
	return capsulePath.slice(0, capsulePath.lastIndexOf("/"));
}

describe("env capsule storage", () => {
	it("writes a 0600 capsule inside a 0700 private temp dir", () => {
	 const root = createTestDir();
		const capsulePath = writeEnvCapsule(
			{
				command: "/bin/echo",
				args: ["hi"],
				parentEnv: { PARENT_VAR: "p" },
				overrides: { PI_SUBAGENT_NAME: "child" },
				paneIdentityKeys: ["TERM"],
			},
			root,
		);

		assert.ok(capsulePath.startsWith(join(root, ENV_CAPSULE_DIR_PREFIX)));
		assert.equal(statSync(capsuleDirOf(capsulePath)).mode & 0o777, 0o700);
		assert.equal(statSync(capsulePath).mode & 0o777, 0o600);

		const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
		assert.equal(capsule.command, "/bin/echo");
		assert.deepEqual(capsule.args, ["hi"]);
		assert.deepEqual(capsule.parentEnv, { PARENT_VAR: "p" });
		assert.deepEqual(capsule.overrides, { PI_SUBAGENT_NAME: "child" });
		assert.deepEqual(capsule.paneIdentityKeys, ["TERM"]);

		rmSync(capsuleDirOf(capsulePath), { recursive: true, force: true });
	});

	it("enforces 0600 even under a permissive umask-style creation", () => {
		const root = createTestDir();
		const capsulePath = writeEnvCapsule(
			{ command: "x", args: [], parentEnv: {}, overrides: {}, paneIdentityKeys: [] },
			root,
		);
		chmodSync(capsulePath, 0o644);
		// The invariant is on write; re-writing a fresh capsule still yields 0600.
		const second = writeEnvCapsule({ command: "x", args: [], parentEnv: {}, overrides: {}, paneIdentityKeys: [] }, root);
		assert.equal(statSync(second).mode & 0o777, 0o600);
		rmSync(capsuleDirOf(capsulePath), { recursive: true, force: true });
		rmSync(capsuleDirOf(second), { recursive: true, force: true });
	});

	it("sweeps stale capsule dirs but keeps fresh ones and ignores unrelated dirs", () => {
		const root = createTestDir();
		const stale = join(root, `${ENV_CAPSULE_DIR_PREFIX}stale`);
		const fresh = join(root, `${ENV_CAPSULE_DIR_PREFIX}fresh`);
		const unrelated = join(root, "unrelated-dir");
		for (const dir of [stale, fresh, unrelated]) {
			mkdirSync(dir);
			writeFileSync(join(dir, "capsule.json"), "{}");
		}
		const oldTime = new Date(Date.now() - DEFAULT_ENV_CAPSULE_MAX_AGE_MS - 60_000);
		utimesSync(stale, oldTime, oldTime);
		const freshTime = new Date(Date.now() - 1_000);
		utimesSync(fresh, freshTime, freshTime);

		const removed = sweepStaleEnvCapsules(DEFAULT_ENV_CAPSULE_MAX_AGE_MS, root);

		assert.equal(removed, 1);
		assert.equal(statSync(fresh, { throwIfNoEntry: false }) !== undefined, true);
		assert.equal(statSync(unrelated, { throwIfNoEntry: false }) !== undefined, true);
		rmSync(root, { recursive: true, force: true });
	});

	it("sweeps safely when the tmp root does not exist", () => {
		assert.equal(sweepStaleEnvCapsules(1000, join(tmpdir(), "pi-subagent-no-such-root")), 0);
	});

	it("leaves stale non-directory entries that merely share the prefix alone", () => {
		const root = createTestDir();
		const decoy = join(root, `${ENV_CAPSULE_DIR_PREFIX}not-a-dir`);
		writeFileSync(decoy, "x");
		const oldTime = new Date(Date.now() - DEFAULT_ENV_CAPSULE_MAX_AGE_MS - 60_000);
		utimesSync(decoy, oldTime, oldTime);

		const removed = sweepStaleEnvCapsules(DEFAULT_ENV_CAPSULE_MAX_AGE_MS, root);

		assert.equal(removed, 0);
		assert.equal(statSync(decoy, { throwIfNoEntry: false }) !== undefined, true);
		rmSync(root, { recursive: true, force: true });
	});
});
