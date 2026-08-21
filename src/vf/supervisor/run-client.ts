import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	claimDelivery,
	isLeaseStale,
	isPidAlive,
	isTerminalState,
	readManifest,
	runFilePaths,
	writeManifest,
	type DeliveryClaim,
	type SupervisorManifest,
	type SupervisorRequest,
	type SupervisorRunResult,
} from "./manifest.ts";
import { getSupervisorMainPath, resolveSupervisorRuntime } from "./spawn.ts";

/**
 * Parent-side API for supervised runs.
 *
 * `startSupervisedRun` writes the manifest and spawns a DETACHED supervisor
 * process that owns the run independently of this parent. A parent that
 * quits, reloads, or is replaced re-attaches with `attachRun` /
 * `waitForRunResult` and claims the result exactly once with
 * `claimRunResult`. This is the durability contract that in-process
 * ownership cannot provide.
 */

export interface StartedSupervisedRun {
	runId: string;
	runDir: string;
	leaseId: string;
	manifestPath: string;
	supervisorLogPath: string;
}

export function newRunId(): string {
	const now = new Date();
	const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
		now.getDate(),
	).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(
		now.getSeconds(),
	).padStart(2, "0")}`;
	return `vf-${stamp}-${randomBytes(4).toString("hex")}`;
}

export function startSupervisedRun(options: {
	baseDir: string;
	request: SupervisorRequest;
	/** Env for the supervisor process itself (defaults to the parent env). */
	env?: NodeJS.ProcessEnv;
}): StartedSupervisedRun {
	const runtime = resolveSupervisorRuntime();
	const runId = newRunId();
	const runDir = join(options.baseDir, runId);
	const paths = runFilePaths(runDir);
	mkdirSync(runDir, { recursive: true });
	const leaseId = randomBytes(8).toString("hex");
	writeManifest(runDir, {
		version: 1,
		runId,
		createdAt: new Date().toISOString(),
		state: "running",
		leaseId,
		lease: null,
		body: null,
		request: options.request,
		result: null,
	});
	const logFd = openSync(paths.supervisorLog, "a");
	const child = spawn(
		runtime.command,
		[...runtime.preArgs, getSupervisorMainPath(), runDir, leaseId],
		{
			detached: true, // survives parent quit; gets its own process group
			stdio: ["ignore", logFd, logFd],
			env: options.env ?? process.env,
		},
	);
	child.unref();
	return {
		runId,
		runDir,
		leaseId,
		manifestPath: paths.manifest,
		supervisorLogPath: paths.supervisorLog,
	};
}

/**
 * Replace a supervisor whose lease is dead (crash, OOM-kill, machine
 * reboot). The new supervisor re-executes the same self-contained request;
 * the caller owns the idempotency implications of that re-execution.
 */
export function respawnSupervisor(runDir: string, options: { env?: NodeJS.ProcessEnv } = {}): StartedSupervisedRun {
	const manifest = readManifest(runDir);
	if (manifest.state !== "running") {
		throw new Error(`Cannot respawn supervisor: run ${manifest.runId} is already ${manifest.state}.`);
	}
	if (manifest.lease && isPidAlive(manifest.lease.pid)) {
		throw new Error(
			`Cannot respawn supervisor for run ${manifest.runId}: pid ${manifest.lease.pid} is still alive.`,
		);
	}
	const runtime = resolveSupervisorRuntime();
	const paths = runFilePaths(runDir);
	const logFd = openSync(paths.supervisorLog, "a");
	const child = spawn(runtime.command, [...runtime.preArgs, getSupervisorMainPath(), runDir, manifest.leaseId], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: options.env ?? process.env,
	});
	child.unref();
	return {
		runId: manifest.runId,
		runDir,
		leaseId: manifest.leaseId,
		manifestPath: paths.manifest,
		supervisorLogPath: paths.supervisorLog,
	};
}

export interface RunSnapshot {
	manifest: SupervisorManifest;
	supervisorAlive: boolean;
	leaseStale: boolean;
	delivered: boolean;
	claim: DeliveryClaim | null;
}

export function attachRun(runDir: string): RunSnapshot {
	const manifest = readManifest(runDir);
	const paths = runFilePaths(runDir);
	// attachRun never claims: observing a snapshot is not delivery. Read an
	// existing claim file without creating one.
	const claim = readDeliveryClaim(runDir);
	return {
		manifest,
		supervisorAlive: isPidAlive(manifest.lease?.pid),
		leaseStale: isLeaseStale(manifest),
		delivered: claim !== null,
		claim,
	};
}

function readDeliveryClaim(runDir: string): DeliveryClaim | null {
	const paths = runFilePaths(runDir);
	if (!existsSync(paths.deliveryClaim)) return null;
	try {
		return JSON.parse(readFileSync(paths.deliveryClaim, "utf8")) as DeliveryClaim;
	} catch {
		return null;
	}
}

export function waitForRunResult(
	runDir: string,
	options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<SupervisorManifest> {
	const pollMs = options.pollMs ?? 200;
	const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Number.POSITIVE_INFINITY;
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (options.signal?.aborted) {
				reject(new Error(`wait aborted: ${options.signal?.reason ?? "aborted"}`));
				return;
			}
			let manifest: SupervisorManifest;
			try {
				manifest = readManifest(runDir);
			} catch (error) {
				reject(error);
				return;
			}
			if (isTerminalState(manifest.state)) {
				resolve(manifest);
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error(`Timed out waiting for run ${manifest.runId} (state ${manifest.state}).`));
				return;
			}
			timer = setTimeout(poll, pollMs);
		};
		let timer: NodeJS.Timeout = setTimeout(poll, 0);
		options.signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error(`wait aborted: ${options.signal?.reason ?? "aborted"}`));
			},
			{ once: true },
		);
	});
}

export interface ClaimedRunResult {
	claimed: boolean;
	result: SupervisorRunResult | null;
	state: SupervisorManifest["state"];
	/** Present when another parent already claimed delivery. */
	alreadyDeliveredBy: DeliveryClaim | null;
	claim: DeliveryClaim | null;
}

/**
 * Claim the terminal result for delivery. Exactly one caller across all
 * parent processes wins; later callers get `claimed: false` plus the winning
 * claim for auditing. A parent that claims and dies mid-routing is reported
 * as already-delivered to the replacement: results are never re-routed.
 */
export function claimRunResult(runDir: string): ClaimedRunResult {
	const manifest = readManifest(runDir);
	if (!isTerminalState(manifest.state)) {
		throw new Error(`Run ${manifest.runId} is still ${manifest.state}; no result to claim yet.`);
	}
	const { claimed, claim } = claimDelivery(runDir, manifest.result);
	const prior = claimed ? null : claim ?? readDeliveryClaim(runDir);
	return {
		claimed,
		result: manifest.result,
		state: manifest.state,
		alreadyDeliveredBy: prior,
		claim: claimed ? claim : null,
	};
}

export function requestCancel(runDir: string): void {
	const paths = runFilePaths(runDir);
	writeFileSync(paths.cancelSentinel, `${new Date().toISOString()}\n`);
	const manifest = readManifest(runDir);
	if (manifest.lease && isPidAlive(manifest.lease.pid)) {
		try {
			process.kill(manifest.lease.pid, "SIGTERM");
		} catch {
			// The sentinel covers it; the supervisor polls every TICK_MS.
		}
	}
}

export type CancelOutcome = "cancelled" | "already-terminal" | "not-running";

export async function cancelRun(
	runDir: string,
	options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ outcome: CancelOutcome; manifest: SupervisorManifest }> {
	let manifest: SupervisorManifest;
	try {
		manifest = readManifest(runDir);
	} catch (error) {
		throw error;
	}
	if (isTerminalState(manifest.state)) return { outcome: "already-terminal", manifest };
	if (!manifest.lease || !isPidAlive(manifest.lease.pid)) return { outcome: "not-running", manifest };
	requestCancel(runDir);
	const final = await waitForRunResult(runDir, options);
	return { outcome: "cancelled", manifest: final };
}
