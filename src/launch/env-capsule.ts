import { chmodSync, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * One-shot launch capsule: the transport that carries a child's environment
 * from the parent pi process to a pane shell it does not own.
 *
 * Security contract:
 * - lives in a private 0700 mkdtemp dir under the system tmpdir, never in the
 *   model-context artifact tree
 * - file mode 0600; readable only by the launching uid
 * - consumed exactly once: the launcher unlinks it before spawning the child
 * - stale capsules whose pane never ran are removed by an age sweep on write
 */
export interface EnvCapsule {
	command: string;
	args: string[];
	cwd?: string;
	/** Parent process env snapshot: deny-filtered, shell-volatile vars stripped. */
	parentEnv: Record<string, string>;
	/** Controlled launch overrides: frontmatter `env:` plus PI_* control vars. */
	overrides: Record<string, string>;
	/** Env name patterns whose values must come from the child pane, not the parent. */
	paneIdentityKeys: string[];
	/** Derive PI_SUBAGENT_SURFACE as `pane:$ZELLIJ_PANE_ID` in the child pane. */
	deriveZellijPaneSurface?: boolean;
}

export const ENV_CAPSULE_DIR_PREFIX = "pi-subagent-env-";
const ENV_CAPSULE_FILE_NAME = "capsule.json";
export const DEFAULT_ENV_CAPSULE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Root directory for new capsules. PI_SUBAGENT_ENV_CAPSULE_DIR redirects the
 * root (used by the test suite so ambient env snapshots never land in the
 * shared system tmpdir); the parent process env is the source either way.
 */
function resolveEnvCapsuleRoot(): string {
	const redirect = process.env.PI_SUBAGENT_ENV_CAPSULE_DIR?.trim();
	return redirect || tmpdir();
}

/** Remove capsule dirs older than maxAge. Returns how many were removed. */
export function sweepStaleEnvCapsules(maxAgeMs = DEFAULT_ENV_CAPSULE_MAX_AGE_MS, dir = tmpdir()): number {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const entry of entries) {
		if (!entry.startsWith(ENV_CAPSULE_DIR_PREFIX)) continue;
		const path = join(dir, entry);
		try {
			const stats = statSync(path);
			if (stats.isDirectory() && stats.mtimeMs < cutoff) {
				rmSync(path, { recursive: true, force: true });
				removed++;
			}
		} catch {
			// A capsule dir disappearing mid-sweep is fine; it was consumed.
		}
	}
	return removed;
}

/**
 * Delete a capsule and its directory. Safe to call at any time: after the
 * pane's launcher has consumed the file this is a no-op, and a directory that
 * is not empty is left alone. Failure-path ownership: every launch site must
 * call this when surface creation or command delivery throws, so a capsule is
 * never left behind for a child that cannot run it.
 */
export function disposeEnvCapsule(capsulePath: string): void {
	try {
		unlinkSync(capsulePath);
	} catch {
		// Already consumed or never readable; nothing to protect.
	}
	const dir = dirname(capsulePath);
	if (!basename(dir).startsWith(ENV_CAPSULE_DIR_PREFIX)) return;
	try {
		rmdirSync(dir);
	} catch {
		// Not empty or already removed.
	}
}

/** Write a capsule and return its path. Stale capsules are swept first. */
export function writeEnvCapsule(capsule: EnvCapsule, dir = tmpdir()): string {
	const root = dir === tmpdir() ? resolveEnvCapsuleRoot() : dir;
	sweepStaleEnvCapsules(DEFAULT_ENV_CAPSULE_MAX_AGE_MS, root);
	const capsuleDir = mkdtempSync(join(root, ENV_CAPSULE_DIR_PREFIX));
	const capsulePath = join(capsuleDir, ENV_CAPSULE_FILE_NAME);
	writeFileSync(capsulePath, `${JSON.stringify(capsule)}\n`, { mode: 0o600 });
	chmodSync(capsulePath, 0o600);
	return capsulePath;
}
