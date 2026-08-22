import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWriteFileSync } from "../supervisor/manifest.ts";

/**
 * Durable manifest contract for a verified fan-out run (ticket 07).
 *
 * One detached supervisor process owns one run end-to-end. The manifest is
 * the durable state machine a reattaching parent reads after quit/reload:
 * candidates keep running under the supervisor, and the terminal outcome is
 * collected from here exactly once via the delivery claim.
 */

const VERIFIED_RUN_MANIFEST_VERSION = 2;

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
	createdAt: string;
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
}

export function verifiedRunFilePaths(runDir: string) {
	return {
		runDir,
		manifest: join(runDir, "manifest.json"),
		supervisorLog: join(runDir, "supervisor.log"),
		cancelSentinel: join(runDir, "cancel"),
		deliveryClaim: join(runDir, "delivery.claim"),
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
	if (parsed.version !== VERIFIED_RUN_MANIFEST_VERSION) {
		throw new VerifiedRunError(
			`Verified-run manifest at ${manifest} has version ${parsed.version}; this build understands ${VERIFIED_RUN_MANIFEST_VERSION}.`,
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
	return existsSync(verifiedRunFilePaths(runDir).deliveryClaim);
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
