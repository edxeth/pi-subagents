import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "../supervisor/manifest.ts";
import { resolveSupervisorRuntime } from "../supervisor/spawn.ts";
import {
	isTerminalRunState,
	isVerifiedRunDelivered,
	newVerifiedRunLeaseId,
	readVerifiedRunManifest,
	verifiedRunFilePaths,
	writeVerifiedRunManifest,
	type VerifiedRunManifest,
} from "./types.ts";

/**
 * Parent-side API for verified fan-out runs (ticket 07).
 *
 * `startVerifiedRun` freezes the request into a durable manifest and spawns
 * a DETACHED supervisor process that owns the run: worktree creation,
 * candidate spawning, settling, and selection all continue under the
 * supervisor when the parent quits, reloads, or is replaced. A parent
 * re-attaches with `attachVerifiedRun` / `waitForVerifiedRunResult` and
 * claims the result exactly once with `claimVerifiedRunDelivery`.
 */

function getVerifiedSupervisorEntry(): string {
	return fileURLToPath(new URL("../supervisor/verified-main.ts", import.meta.url));
}

function resolveVerifiedRunsRoot(baseDir: string): string {
	return join(baseDir, "vf-runs");
}

export interface StartedVerifiedRun {
	runId: string;
	runDir: string;
	leaseId: string;
	manifestPath: string;
}

/**
 * Write the provisioning manifest and spawn the detached supervisor that
 * owns the run. The request must already be fully resolved (worktree paths,
 * candidate argv, verifier); this function spends nothing on candidates.
 */
export function startVerifiedRun(options: {
	baseDir: string;
	runId: string;
	request: VerifiedRunManifest["request"];
	env?: NodeJS.ProcessEnv;
}): StartedVerifiedRun {
	const runDir = join(resolveVerifiedRunsRoot(options.baseDir), options.runId);
	const paths = verifiedRunFilePaths(runDir);
	mkdirSync(paths.runDir, { recursive: true });
	const leaseId = newVerifiedRunLeaseId();
	const now = new Date().toISOString();
	writeVerifiedRunManifest(runDir, {
		version: 2,
		runId: options.runId,
		createdAt: now,
		updatedAt: now,
		state: "provisioning",
		leaseId,
		lease: null,
		request: options.request,
		candidates: [],
		result: null,
	});
	spawnVerifiedSupervisor(runDir, leaseId, options.env);
	return { runId: options.runId, runDir, leaseId, manifestPath: paths.manifest };
}

function spawnVerifiedSupervisor(runDir: string, leaseId: string, env?: NodeJS.ProcessEnv): void {
	const runtime = resolveSupervisorRuntime();
	const paths = verifiedRunFilePaths(runDir);
	const logFd = openSync(paths.supervisorLog, "a");
	const child = spawn(runtime.command, [getVerifiedSupervisorEntry(), runDir, leaseId], {
		detached: true, // survives parent quit; gets its own process group
		stdio: ["ignore", logFd, logFd],
		env: env ?? process.env,
	});
	child.unref();
}

/** Replace a supervisor whose lease is dead; the new one adopts live candidates. */
export function respawnVerifiedSupervisor(runDir: string, options: { env?: NodeJS.ProcessEnv } = {}): void {
	const manifest = readVerifiedRunManifest(runDir);
	if (isTerminalRunState(manifest.state)) {
		throw new Error(`Cannot respawn supervisor: run ${manifest.runId} is already ${manifest.state}.`);
	}
	if (manifest.lease && isPidAlive(manifest.lease.pid)) {
		throw new Error(`Cannot respawn supervisor for run ${manifest.runId}: pid ${manifest.lease.pid} is still alive.`);
	}
	spawnVerifiedSupervisor(runDir, manifest.leaseId, options.env);
}

export interface VerifiedRunSnapshot {
	manifest: VerifiedRunManifest;
	supervisorAlive: boolean;
	delivered: boolean;
}

export function attachVerifiedRun(runDir: string): VerifiedRunSnapshot {
	const manifest = readVerifiedRunManifest(runDir);
	return {
		manifest,
		supervisorAlive: isPidAlive(manifest.lease?.pid),
		delivered: isVerifiedRunDelivered(runDir),
	};
}

/** True when a run has no live supervisor but is not terminal (needs respawn). */
export function isVerifiedRunOrphaned(snapshot: VerifiedRunSnapshot): boolean {
	if (isTerminalRunState(snapshot.manifest.state)) return false;
	return !snapshot.manifest.lease || !isPidAlive(snapshot.manifest.lease.pid);
}

export function waitForVerifiedRunResult(
	runDir: string,
	options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<VerifiedRunManifest> {
	const pollMs = options.pollMs ?? 250;
	const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;
	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout | undefined;
		const clear = () => {
			if (timer) clearTimeout(timer);
		};
		const poll = () => {
			if (options.signal?.aborted) {
				clear();
				reject(new Error(`verified-run wait aborted: ${options.signal?.reason ?? "aborted"}`));
				return;
			}
			let manifest: VerifiedRunManifest;
			try {
				manifest = readVerifiedRunManifest(runDir);
			} catch (error) {
				clear();
				reject(error);
				return;
			}
			if (isTerminalRunState(manifest.state)) {
				clear();
				resolve(manifest);
				return;
			}
			if (Date.now() > deadline) {
				clear();
				reject(new Error(`Timed out waiting for verified run ${manifest.runId} (state ${manifest.state}).`));
				return;
			}
			timer = setTimeout(poll, pollMs);
		};
		timer = setTimeout(poll, 0);
		options.signal?.addEventListener(
			"abort",
			() => {
				clear();
				reject(new Error(`verified-run wait aborted: ${options.signal?.reason ?? "aborted"}`));
			},
			{ once: true },
		);
	});
}

export function requestVerifiedRunCancel(runDir: string): void {
	const paths = verifiedRunFilePaths(runDir);
	writeFileSync(paths.cancelSentinel, `${new Date().toISOString()}\n`);
	const manifest = readVerifiedRunManifest(runDir);
	if (manifest.lease && isPidAlive(manifest.lease.pid)) {
		try {
			process.kill(manifest.lease.pid, "SIGTERM");
		} catch {
			// The sentinel covers it; the supervisor polls every tick.
		}
	}
}

export async function cancelVerifiedRun(
	runDir: string,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ outcome: "cancelled" | "already-terminal"; manifest: VerifiedRunManifest }> {
	const manifest = readVerifiedRunManifest(runDir);
	if (isTerminalRunState(manifest.state)) return { outcome: "already-terminal", manifest };
	requestVerifiedRunCancel(runDir);
	const final = await waitForVerifiedRunResult(runDir, options);
	return { outcome: "cancelled", manifest: final };
}

/** Discover run dirs under a runs root (reattach scan); missing dir yields []. */
export function listVerifiedRuns(baseDir: string): string[] {
	const root = resolveVerifiedRunsRoot(baseDir);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name));
}
