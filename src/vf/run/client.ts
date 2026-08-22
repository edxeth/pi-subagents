import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "../supervisor/manifest.ts";
import { resolveSupervisorRuntime } from "../supervisor/spawn.ts";
import { defaultVerifierCachePath } from "../verifier/bridge.ts";
import {
	isTerminalRunState,
	isVerifiedRunDelivered,
	newVerifiedRunLeaseId,
	readVerifiedRunManifest,
	RETRYABLE_VERIFICATION_FAILURE_CODES,
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

/**
 * Retry verification for a halted run (ticket 06): re-rank the preserved
 * candidate traces without re-running any candidate. Allowed only for
 * selection-phase failures whose candidates all settled and whose sessions
 * and worktrees are intact. An optional verifier override lets the parent
 * point the retry at a repaired backend (fixed credentials, another model,
 * another criteria file) under the same non-empty model/criteria rules as
 * the original launch.
 */
export function retryVerifiedRunVerification(
	runDir: string,
	options: { verifier?: Partial<VerifiedRunManifest["request"]["verifier"]>; env?: NodeJS.ProcessEnv } = {},
): StartedVerifiedRun {
	const manifest = readVerifiedRunManifest(runDir);
	if (!isTerminalRunState(manifest.state)) {
		throw new Error(`Cannot retry verification: run ${manifest.runId} is still ${manifest.state}.`);
	}
	if (manifest.result?.ok) {
		throw new Error(`Cannot retry verification: run ${manifest.runId} already completed with a winner.`);
	}
	const failure = manifest.result?.failure;
	if (!failure || !(RETRYABLE_VERIFICATION_FAILURE_CODES as readonly string[]).includes(failure.code)) {
		throw new Error(
			`Cannot retry verification: run ${manifest.runId} failed with ${failure?.code ?? "(no failure recorded)"}, ` +
				`which is not a selection-phase failure (${RETRYABLE_VERIFICATION_FAILURE_CODES.join(", ")}). Start a fresh launch instead.`,
		);
	}
	const settled = manifest.candidates.filter((candidate) => candidate.settled).length;
	if (settled !== manifest.request.candidateCount) {
		throw new Error(
			`Cannot retry verification: only ${settled}/${manifest.request.candidateCount} candidates settled; the retry re-ranks traces, it never re-runs candidates.`,
		);
	}
	for (const spec of manifest.request.candidates) {
		if (!existsSync(spec.sessionFile)) {
			throw new Error(`Cannot retry verification: candidate session ${spec.sessionFile} is gone.`);
		}
		if (!existsSync(spec.worktree)) {
			throw new Error(`Cannot retry verification: candidate worktree ${spec.worktree} is gone.`);
		}
	}
	if (options.verifier) {
		const merged = { ...manifest.request.verifier, ...options.verifier };
		if (!merged.model?.trim() || !merged.criteriaPath?.trim()) {
			throw new Error("Cannot retry verification: the verifier override must keep a non-empty model and criteriaPath.");
		}
		manifest.request.verifier = merged;
	}
	// The halted attempt's cache carries the degenerate scores that stopped
	// the run; a retry must re-ask the backend, not replay the poison.
	rmSync(defaultVerifierCachePath(runDir), { force: true });
	const leaseId = newVerifiedRunLeaseId();
	manifest.state = "verifying";
	manifest.result = null;
	manifest.leaseId = leaseId;
	manifest.lease = null;
	writeVerifiedRunManifest(runDir, manifest);
	// Each verification attempt's outcome is deliverable exactly once.
	rmSync(verifiedRunFilePaths(runDir).deliveryClaim, { force: true });
	spawnVerifiedSupervisor(runDir, leaseId, options.env);
	return { runId: manifest.runId, runDir, leaseId, manifestPath: verifiedRunFilePaths(runDir).manifest };
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
