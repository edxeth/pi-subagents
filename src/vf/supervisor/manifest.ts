import {
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Durable manifest for a supervised run.
 *
 * One detached supervisor process owns a run end-to-end. The manifest is the
 * single durable state machine: it is written atomically (write to a temp
 * file, fsync, rename) so a crash never leaves a half-written state, and it
 * records the request (self-contained, so a dead supervisor can be replaced),
 * the lease (which supervisor process owns the run right now), and the
 * terminal result. Delivery to a parent session is claimed exactly once via
 * an O_EXCL claim file.
 */

export const MANIFEST_VERSION = 1;

export type SupervisorRunState = "running" | "completed" | "failed" | "cancelled";

export function isTerminalState(state: SupervisorRunState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

export interface SupervisorLease {
	pid: number;
	leaseId: string;
	/** Runtime label the supervisor was spawned with (node/bun/...). */
	runtime: string;
	startedAt: string;
	heartbeatAt: string;
}

/** Tracked body process so a replacement supervisor can clean up a stale one. */
export interface SupervisorBodyProcess {
	pid: number;
	pgid: number;
	startedAt: string;
}

export interface ProcessRunRequest {
	kind: "process";
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	/** Wall-clock cap for the body process; exceeded = SIGTERM then SIGKILL. */
	timeoutMs?: number;
}

export type SupervisorRequest = ProcessRunRequest;

export interface SupervisorRunResult {
	ok: boolean;
	/** Process exit code when the body was a process. */
	exitCode?: number;
	/** Supervisor-level failure description (timeout, spawn error, crash). */
	error?: string;
	stdoutBytes: number;
	stderrBytes: number;
	finishedAt: string;
}

export interface SupervisorManifest {
	version: number;
	runId: string;
	createdAt: string;
	state: SupervisorRunState;
	/** Lease id the spawning parent generated; the supervisor must present it. */
	leaseId: string;
	/** Set by the owning supervisor when it claims the run; null until then. */
	lease: SupervisorLease | null;
	/** Body process bookkeeping (written by the supervisor). */
	body: SupervisorBodyProcess | null;
	request: SupervisorRequest;
	result: SupervisorRunResult | null;
}

export interface DeliveryClaim {
	claimedAt: string;
	pid: number;
	/** sha256 of the result JSON — ties the claim to one specific result. */
	digest: string;
}

export class ManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestError";
	}
}

export interface RunFilePaths {
	runDir: string;
	manifest: string;
	stdout: string;
	stderr: string;
	supervisorLog: string;
	cancelSentinel: string;
	deliveryClaim: string;
}

export function runFilePaths(runDir: string): RunFilePaths {
	return {
		runDir,
		manifest: join(runDir, "manifest.json"),
		stdout: join(runDir, "stdout.log"),
		stderr: join(runDir, "stderr.log"),
		supervisorLog: join(runDir, "supervisor.log"),
		cancelSentinel: join(runDir, "cancel"),
		deliveryClaim: join(runDir, "delivery.claim"),
	};
}

/**
 * Atomic file write: temp file in the same directory, fsync, rename over the
 * destination, then fsync the directory so the rename itself survives a
 * crash. Readers only ever see the old or the new file, never a partial one.
 */
export function atomicWriteFileSync(path: string, data: string): void {
	const tmp = join(dirname(path), `.${basenameOf(path)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
	const fd = openSync(tmp, "wx");
	try {
		writeSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort cleanup; the rename failure is the reported error.
		}
		throw error;
	}
	syncDirBestEffort(dirname(path));
}

function basenameOf(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || "file";
}

function syncDirBestEffort(dir: string): void {
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Directory fsync is not supported everywhere (some filesystems, some
		// platforms); the rename is already durable on those that matter.
	}
}

export function writeManifest(runDir: string, manifest: SupervisorManifest): void {
	const paths = runFilePaths(runDir);
	atomicWriteFileSync(paths.manifest, `${JSON.stringify(manifest, null, "\t")}\n`);
}

export function readManifest(runDir: string): SupervisorManifest {
	const paths = runFilePaths(runDir);
	if (!existsSync(paths.manifest)) {
		throw new ManifestError(`No supervised-run manifest at ${paths.manifest}.`);
	}
	let manifest: SupervisorManifest;
	try {
		manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as SupervisorManifest;
	} catch (error) {
		throw new ManifestError(`Manifest at ${paths.manifest} is not valid JSON: ${(error as Error).message}`);
	}
	if (manifest.version !== MANIFEST_VERSION) {
		throw new ManifestError(
			`Manifest at ${paths.manifest} has version ${manifest.version}; this supervisor understands version ${MANIFEST_VERSION}.`,
		);
	}
	if (!manifest.runId || !manifest.leaseId || !manifest.request?.kind) {
		throw new ManifestError(`Manifest at ${paths.manifest} is missing runId, leaseId, or request.`);
	}
	return manifest;
}

/** Read-modify-write the manifest. Single-writer per lease; atomic per write. */
export function updateManifest(
	runDir: string,
	mutate: (manifest: SupervisorManifest) => void | Promise<void>,
): SupervisorManifest {
	const manifest = readManifest(runDir);
	const promise = mutate(manifest);
	if (promise instanceof Promise) throw new ManifestError("updateManifest mutator must be synchronous");
	writeManifest(runDir, manifest);
	return manifest;
}

export function digestResult(result: SupervisorRunResult | null): string {
	return createHash("sha256").update(JSON.stringify(result ?? null)).digest("hex");
}

/**
 * Claim the result for delivery exactly once. O_EXCL create is atomic on
 * POSIX: exactly one caller wins, every later caller sees the existing claim.
 */
export function claimDelivery(runDir: string, result: SupervisorRunResult | null): { claimed: boolean; claim: DeliveryClaim } {
	const paths = runFilePaths(runDir);
	if (existsSync(paths.deliveryClaim)) {
		return { claimed: false, claim: JSON.parse(readFileSync(paths.deliveryClaim, "utf8")) as DeliveryClaim };
	}
	const claim: DeliveryClaim = {
		claimedAt: new Date().toISOString(),
		pid: process.pid,
		digest: digestResult(result),
	};
	try {
		const fd = openSync(paths.deliveryClaim, "wx");
		try {
			const data = `${JSON.stringify(claim, null, "\t")}\n`;
			writeSync(fd, data);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		syncDirBestEffort(runDir);
		return { claimed: true, claim };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return { claimed: false, claim: JSON.parse(readFileSync(paths.deliveryClaim, "utf8")) as DeliveryClaim };
		}
		throw error;
	}
}

/** Liveness of a pid: false only when the pid definitively does not exist. */
export function isPidAlive(pid: number | null | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A lease is stale when its supervisor is dead AND its heartbeat is old. */
export function isLeaseStale(manifest: SupervisorManifest, now = Date.now(), maxAgeMs = 30_000): boolean {
	if (!manifest.lease) return true;
	if (isPidAlive(manifest.lease.pid)) return false;
	const heartbeat = Date.parse(manifest.lease.heartbeatAt);
	if (Number.isNaN(heartbeat)) return true;
	return now - heartbeat > maxAgeMs;
}
