import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFileSync, isPidAlive } from "../supervisor/manifest.ts";

/**
 * Durable manifest contract for a verified fan-out run (ticket 07).
 *
 * One detached supervisor process owns one run end-to-end. The manifest is
 * the durable state machine a reattaching parent reads after quit/reload:
 * candidates keep running under the supervisor, and the terminal outcome is
 * collected from here exactly once via the delivery claim.
 */

/** Written version. Reader also accepts 2 (pre-recipient-freeze runs); older
 * builds reject 3 and therefore cannot run their ungated adoption on new runs. */
const VERIFIED_RUN_MANIFEST_VERSION = 3;
const LEGACY_VERIFIED_RUN_MANIFEST_VERSION = 2;

const VERIFIED_RUN_STATES = [
	"provisioning",
	"running",
	"verifying",
	"completed",
	"failed",
	"cancelled",
] as const;
export type VerifiedRunState = (typeof VERIFIED_RUN_STATES)[number];

export function isTerminalRunState(state: VerifiedRunState): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * Failure codes that left every candidate settled with its traces and
 * snapshots preserved: selection alone can be retried (the retry never
 * re-runs candidates). Everything else needs a fresh launch.
 */
export const RETRYABLE_VERIFICATION_FAILURE_CODES = [
	"verifier-failed",
	"degenerate-scores",
	"comparison-count",
	"cache",
] as const;

class VerifiedRunError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifiedRunError";
	}
}

/** Per-candidate spawn spec, frozen into the request before any spend. */
export interface VerifiedCandidateSpec {
	/** 1-based candidate index. */
	index: number;
	/** Candidate session JSONL (unique per candidate; parent-resolved). */
	sessionFile: string;
	/** Absolute path of this candidate's git worktree (deterministic name). */
	worktree: string;
	/** Internal audit branch snapshotting this candidate. */
	internalBranch: string;
	/** Complete argv for the candidate pi process (after the shared piCommand). */
	args: string[];
	/** Per-candidate env overlay on top of the frozen base env (includes PI_SUBAGENT_SESSION). */
	env: Record<string, string>;
	/** Number of session entries present before the candidate starts. */
	launchEntryCount: number;
}

/**
 * Self-contained run request. Everything the supervisor needs is frozen here
 * by the launching parent: a crashed supervisor can be replaced and the run
 * re-driven from this file alone.
 */
export interface VerifiedRunRequest {
	kind: "verified-fanout";
	/** Logical-child identity (tool name/title) for reattach delivery. */
	name: string;
	title: string;
	/** Resolved pi invocation (command resolved in the parent process). */
	piCommand: string;
	/** Prefix words between the command and the per-candidate argv (multi-word PI_SUBAGENT_PI_COMMAND, script path). */
	piCommandArgs: string[];
	/** Frozen prompt artifact consumed via @path by every candidate. */
	taskArtifact: string;
	/** The byte-identical full task text (also the verifier `problem`). */
	taskPrompt: string;
	/** Source repo cwd; candidates spawn with per-candidate worktree cwds. */
	sourceRepo: string;
	baseCommit: string;
	agent: string;
	/** Candidate count (spec list length must match). */
	candidateCount: number;
	candidates: VerifiedCandidateSpec[];
	/** Verifier resolution (model + criteria), frozen before any spend. */
	verifier: {
		model: string;
		thinking: string | null;
		env: Record<string, string>;
		criteriaPath: string;
		/** Test seam mirroring the ticket-05 bridge mock; never set by production launch paths. */
		mockVerifier?: unknown;
	};
	/** Full candidate env (deny-filtered parent snapshot + launch env), frozen. */
	env: Record<string, string>;
	/** Parent session that started the run (reattach addressing). */
	parentSessionId: string | null;
	/** Sessions allowed to receive the report, frozen at launch (origin plus
	 * ancestors). Legacy runs without this list fall back to parentSessionId
	 * alone; runs with neither are manual-delivery-only. */
	authorizedRecipients?: string[];
	createdAt: string;
}

/**
 * Delivery lease: one session at a time may run the delivery handshake.
 * Unlike the legacy O_EXCL claim, a lease whose holder died (process gone)
 * or whose result generation rotated is reclaimable, so a crash between
 * lease and send can never strand a result.
 */
interface VerifiedRunDeliveryLease {
	sessionId: string;
	pid: number;
	generation: number;
	deliveryId: string;
	acquiredAt: string;
}

/** Durable proof the report reached a session; written only after the
 * receiving session persisted the deliveryId. Exactly-once delivery. */
export interface VerifiedRunDeliveryReceipt {
	sessionId: string;
	deliveryId: string;
	digest: string;
	deliveredAt: string;
}

type VerifiedRunLease = {
	pid: number;
	label: string;
	startedAt: string;
	heartbeatAt: string;
};

/** Live candidate bookkeeping written by the owning supervisor. */
export interface VerifiedCandidateRuntime {
	index: number;
	pid: number | null;
	pgid: number;
	startedAt: string;
	/** Null until the supervisor observes the process settle. */
	exitCode: number | null;
	exitSignal: string | null;
	settled: boolean;
	/** Spawn/adoption/timeout failure reason, if any. */
	error?: string;
}

type VerifiedRunFailure = { code: string; message: string };

export interface VerifiedRunSelection {
	winnerIndex: number;
	/** Ranking as candidate indices, winner first (bridge echo, validated). */
	ranking: number[];
	scores: number[];
	/** Criteria ids the verifier scored against. */
	criteria: string[];
	model: string;
	winnerSessionFile: string;
	winnerWorktree: string;
	winnerBranch: string;
	/** Internal snapshot commit of the winner (cherry-picked by the apply gate). */
	winnerCommit: string;
	winnerTreeHash: string;
	winnerChanged: boolean;
	/** Winner's verifier score in [0,1] (logprob expectation aggregate). */
	winnerScore: number;
	winnerReport: string;
	winnerTrace: string;
	/** Verifier token usage of the selection tournament. */
	usage: { calls: number; inputTokens: number; outputTokens: number };
	distinctCandidates: number;
	/** Candidate indices collapsed as exact duplicates (same tree + report). */
	collapsed: number[];
	/** Exact-duplicate equivalence report: each collapsed candidate and the
	 * distinct representative it is equivalent to (same tree + report hash). */
	equivalences: Array<{ candidate: number; equivalentTo: number }>;
	runnerUpSessionFiles: string[];
}

/** Ticket 08 outcome of the guarded winner application. */
export interface VerifiedRunApply {
	applied: boolean;
	/** "applied" on success; otherwise the fail-closed skip code (source-drift, apply-conflict, ...). */
	code: string;
	message: string;
	/** Staged tree hash after a successful apply (equals the winner tree). */
	treeHash: string | null;
	/** True when the candidate worktree directories were removed after a successful apply. */
	worktreesRemoved: boolean;
	finishedAt: string;
}

export interface VerifiedRunResult {
	ok: boolean;
	selection: VerifiedRunSelection | null;
	failure: VerifiedRunFailure | null;
	/** Guarded winner application result (null while selection has not succeeded). */
	apply: VerifiedRunApply | null;
	/** Relative artifact names inside the run dir (traces/<i>.txt etc.). */
	artifacts: { traces: string[]; report: string; ranking: string };
	elapsedMs: number;
	finishedAt: string;
}

export interface VerifiedRunManifest {
	version: number;
	runId: string;
	createdAt: string;
	updatedAt: string;
	state: VerifiedRunState;
	/** Lease id the spawning parent generated; the supervisor must present it. */
	leaseId: string;
	lease: VerifiedRunLease | null;
	request: VerifiedRunRequest;
	/** Candidate process bookkeeping (written by the owning supervisor). */
	candidates: VerifiedCandidateRuntime[];
	result: VerifiedRunResult | null;
	/** Verification attempt counter; a retry rotates the deliverable result. */
	resultGeneration?: number;
}

export function verifiedRunFilePaths(runDir: string) {
	return {
		runDir,
		manifest: join(runDir, "manifest.json"),
		supervisorLog: join(runDir, "supervisor.log"),
		cancelSentinel: join(runDir, "cancel"),
		deliveryClaim: join(runDir, "delivery.claim"),
		deliveryLease: join(runDir, "delivery.lease"),
		deliveryReceipt: join(runDir, "delivery.receipt"),
		careLease: join(runDir, "care.lease"),
		report: join(runDir, "winner-report.md"),
		ranking: join(runDir, "ranking.json"),
		tracesDir: join(runDir, "traces"),
	};
}

export function readVerifiedRunManifest(runDir: string): VerifiedRunManifest {
	const { manifest } = verifiedRunFilePaths(runDir);
	let parsed: VerifiedRunManifest;
	try {
		parsed = JSON.parse(readFileSync(manifest, "utf8")) as VerifiedRunManifest;
	} catch (error) {
		const reason = (error as { code?: string }).code === "ENOENT" ? "does not exist" : "is not valid JSON";
		throw new VerifiedRunError(`Verified-run manifest at ${manifest} ${reason} (${(error as Error).message}).`);
	}
	if (parsed.version !== VERIFIED_RUN_MANIFEST_VERSION && parsed.version !== LEGACY_VERIFIED_RUN_MANIFEST_VERSION) {
		throw new VerifiedRunError(
			`Verified-run manifest at ${manifest} has version ${parsed.version}; this build understands ${VERIFIED_RUN_MANIFEST_VERSION} (and legacy ${LEGACY_VERIFIED_RUN_MANIFEST_VERSION}).`,
		);
	}
	if (parsed.runId !== basename(runDir)) {
		throw new VerifiedRunError(`Verified-run manifest at ${manifest} names run ${parsed.runId} but lives in ${runDir}.`);
	}
	if (!parsed.request || parsed.request.kind !== "verified-fanout") {
		throw new VerifiedRunError(`Verified-run manifest at ${manifest} is missing its verified-fanout request.`);
	}
	return parsed;
}

export function writeVerifiedRunManifest(runDir: string, manifest: VerifiedRunManifest): void {
	const paths = verifiedRunFilePaths(runDir);
	const next: VerifiedRunManifest = { ...manifest, updatedAt: new Date().toISOString() };
	atomicWriteFileSync(paths.manifest, `${JSON.stringify(next, null, "\t")}\n`);
}

/**
 * Claim the terminal result for delivery exactly once (O_EXCL). A parent
 * that quits before delivering leaves the claim absent, so the reattaching
 * parent claims and delivers instead; a claim that exists was honored by
 * exactly one parent session.
 */
export function claimVerifiedRunDelivery(runDir: string): { claimed: boolean; claimedByPid: number } {
	const paths = verifiedRunFilePaths(runDir);
	if (existsSync(paths.deliveryClaim)) {
		try {
			const prior = JSON.parse(readFileSync(paths.deliveryClaim, "utf8")) as { pid?: number };
			return { claimed: false, claimedByPid: prior.pid ?? -1 };
		} catch {
			return { claimed: false, claimedByPid: -1 };
		}
	}
	const claim = {
		claimedAt: new Date().toISOString(),
		pid: process.pid,
		digest: createHash("sha256")
			.update(JSON.stringify(readVerifiedRunManifest(runDir).result ?? null))
			.digest("hex"),
	};
	try {
		writeFileSync(paths.deliveryClaim, `${JSON.stringify(claim, null, "\t")}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { claimed: false, claimedByPid: -1 };
		throw error;
	}
	return { claimed: true, claimedByPid: process.pid };
}

export function isVerifiedRunDelivered(runDir: string): boolean {
	// Only a receipt proves delivery; a bare legacy claim does not.
	return readVerifiedRunDeliveryReceipt(runDir) !== null;
}

/** The deliverable result generation (legacy manifests predate retries). */
export function verifiedRunResultGeneration(manifest: VerifiedRunManifest): number {
	return manifest.resultGeneration ?? 1;
}

export type VerifiedRunLeaseOutcome =
	| { acquired: true; deliveryId: string }
	| { acquired: false; reason: "delivered" | "live-lease" | "rotated" };

/**
 * Acquire (or re-enter) the delivery lease for this run. Refuses when the
 * receipt already exists (exactly-once) or when another live session holds
 * the lease. A lease from a dead holder, or one keyed to a rotated result
 * generation, is reclaimed instead of honored.
 */
export function acquireVerifiedRunDeliveryLease(
	runDir: string,
	options: { sessionId: string; expectedGeneration?: number },
): VerifiedRunLeaseOutcome {
	const paths = verifiedRunFilePaths(runDir);
	// Only a receipt for the CURRENT generation proves delivery. A bare legacy
	// claim does not: a crashed live watcher could write the claim and die
	// before anything was sent, so it stays reclaimable instead of stranding
	// the report.
	const currentGeneration = verifiedRunResultGeneration(readVerifiedRunManifest(runDir));
	if (options.expectedGeneration !== undefined && options.expectedGeneration !== currentGeneration) {
		// The result rotated (retry) between the caller's snapshot and this
		// acquisition: the caller holds a stale report and must not deliver it.
		return { acquired: false, reason: "rotated" };
	}
	const receipt = readVerifiedRunDeliveryReceipt(runDir);
	if (receipt && receipt.deliveryId.endsWith(`-g${currentGeneration}`)) {
		return { acquired: false, reason: "delivered" };
	}
	const manifest = readVerifiedRunManifest(runDir);
	const deliveryId = `${manifest.runId}-g${verifiedRunResultGeneration(manifest)}`;
	if (existsSync(paths.deliveryLease)) {
		try {
			const lease = JSON.parse(readFileSync(paths.deliveryLease, "utf8")) as VerifiedRunDeliveryLease;
			const holderAlive = typeof lease.pid === "number" && lease.pid > 0 && isPidAlive(lease.pid);
			const staleGeneration = lease.generation !== currentGeneration;
			if (holderAlive && !staleGeneration) {
				// A live holder blocks every contender, including the same
				// session id in another process. A lease from a rotated
				// generation never blocks the current result: its holder can
				// no longer write a receipt (generation-fenced), so it is
				// reclaimable regardless of liveness.
				return { acquired: false, reason: "live-lease" };
			}
			// Dead holder: unlink, then exclusive-create. A contender that
			// wins the unlink→create gap makes our create fail with EEXIST;
			// the re-read then sees their live lease and we back off.
			rmSync(paths.deliveryLease, { force: true });
		} catch {
			// Unreadable lease: reclaim rather than strand the result.
			rmSync(paths.deliveryLease, { force: true });
		}
	}
	const lease: VerifiedRunDeliveryLease = {
		sessionId: options.sessionId,
		pid: process.pid,
		generation: verifiedRunResultGeneration(manifest),
		deliveryId,
		acquiredAt: new Date().toISOString(),
	};
	try {
		writeFileSync(paths.deliveryLease, `${JSON.stringify(lease, null, "\t")}\n`, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// Lost the takeover race: re-read once; a fresh live holder wins.
		try {
			const winner = JSON.parse(readFileSync(paths.deliveryLease, "utf8")) as VerifiedRunDeliveryLease;
			if (typeof winner.pid === "number" && winner.pid > 0 && isPidAlive(winner.pid)) {
				return { acquired: false, reason: "live-lease" };
			}
		} catch {
			// unreadable: the next attempt reclaims
		}
		return { acquired: false, reason: "live-lease" };
	}
	return { acquired: true, deliveryId };
}

export function writeVerifiedRunDeliveryReceipt(
	runDir: string,
	info: { sessionId: string; deliveryId: string },
): void {
	const manifest = readVerifiedRunManifest(runDir);
	if (!info.deliveryId.endsWith(`-g${verifiedRunResultGeneration(manifest)}`)) {
		throw new Error(
			`Refusing delivery receipt for ${info.deliveryId}: run ${manifest.runId} is at generation ` +
				`${verifiedRunResultGeneration(manifest)}; a late writer must not block the current result.`,
		);
	}
	const receipt: VerifiedRunDeliveryReceipt = {
		...info,
		digest: createHash("sha256").update(JSON.stringify(manifest.result ?? null)).digest("hex"),
		deliveredAt: new Date().toISOString(),
	};
	writeFileSync(verifiedRunFilePaths(runDir).deliveryReceipt, `${JSON.stringify(receipt, null, "\t")}\n`, { flag: "wx" });
}

/** Release a lease this session owns (owner token + delivery id). A lease
 * held by anyone else, or already rotated, is left untouched. */
export function releaseVerifiedRunDeliveryLease(
	runDir: string,
	info: { sessionId: string; deliveryId: string },
): void {
	const paths = verifiedRunFilePaths(runDir);
	try {
		const lease = JSON.parse(readFileSync(paths.deliveryLease, "utf8")) as VerifiedRunDeliveryLease;
		if (lease.sessionId === info.sessionId && lease.deliveryId === info.deliveryId) {
			rmSync(paths.deliveryLease, { force: true });
		}
	} catch {
		// absent or unreadable: nothing to release
	}
}

export function readVerifiedRunDeliveryReceipt(runDir: string): VerifiedRunDeliveryReceipt | null {
	try {
		return JSON.parse(readFileSync(verifiedRunFilePaths(runDir).deliveryReceipt, "utf8")) as VerifiedRunDeliveryReceipt;
	} catch {
		return null;
	}
}

/**
 * Serialize supervisor respawn: exactly one session may spawn a replacement
 * supervisor for an orphaned run. A lease held by a dead pid is stale and
 * may be taken over; the replacement supervisor releases the lease once it
 * owns the run.
 */
export function takeVerifiedRunCareLease(runDir: string): { taken: boolean; holderPid?: number } {
	const paths = verifiedRunFilePaths(runDir);
	const lease = { pid: process.pid, takenAt: new Date().toISOString() };
	try {
		writeFileSync(paths.careLease, `${JSON.stringify(lease, null, "\t")}\n`, { flag: "wx" });
		return { taken: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	try {
		const prior = JSON.parse(readFileSync(paths.careLease, "utf8")) as { pid?: number };
		if (typeof prior.pid === "number" && prior.pid > 0 && isPidAlive(prior.pid)) {
			return { taken: false, holderPid: prior.pid };
		}
	} catch {
		// Unreadable lease: take over rather than block recovery.
	}
	writeFileSync(paths.careLease, `${JSON.stringify(lease, null, "\t")}\n`);
	// Plain overwrite is last-writer-wins: re-read to detect a concurrent
	// winner so exactly one contender proceeds to spawn.
	try {
		const winner = JSON.parse(readFileSync(paths.careLease, "utf8")) as { pid?: number };
		if (winner.pid !== process.pid) return { taken: false, holderPid: winner.pid };
	} catch {
		return { taken: false };
	}
	return { taken: true };
}

/**
 * Sessions allowed to receive this run's report. Runs launched before
 * recipient freezing record only `parentSessionId`; those deliver to that
 * session alone. Runs with no recorded origin are manual-delivery-only.
 */
export function authorizedRecipientIds(manifest: VerifiedRunManifest): string[] {
	const frozen = manifest.request.authorizedRecipients;
	if (Array.isArray(frozen) && frozen.length > 0) return frozen;
	return manifest.request.parentSessionId ? [manifest.request.parentSessionId] : [];
}

export function newVerifiedRunLeaseId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Process-group liveness of a candidate (pgid == pid because spawns are detached). */
export function isCandidateGroupAlive(pgid: number): boolean {
	if (!pgid || pgid <= 0) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
