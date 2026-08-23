import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { isPidAlive } from "./manifest.ts";
import { createCandidateWorktrees, preflightWorktreeSource } from "../worktrees.ts";
import { applyWinnerToSource, ApplyError, cleanupRunWorktrees } from "../apply.ts";
import { runVerifierProbe, VerifierBridgeError, type MockVerifierConfig } from "../verifier/bridge.ts";
import { RETRYABLE_VERIFICATION_FAILURE_CODES } from "../run/types.ts";
import {
	collapseDuplicates,
	selectWinner,
	settleCandidates,
	writeTraceArtifacts,
	SettleAbort,
} from "./verified-settle.ts";
import {
	isCandidateGroupAlive,
	isTerminalRunState,
	readVerifiedRunManifest,
	verifiedRunFilePaths,
	writeVerifiedRunManifest,
	type VerifiedCandidateRuntime,
	type VerifiedRunManifest,
	type VerifiedRunApply,
	type VerifiedRunResult,
	type VerifiedRunSelection,
} from "../run/types.ts";

/**
 * Detached supervisor entrypoint for a verified fan-out run (ticket 07).
 * Usage: `<runtime> verified-main.ts <runDir> <leaseId>`.
 *
 * The supervisor owns the run end-to-end: it creates the candidate
 * worktrees, spawns the candidates as detached processes (one process group
 * each), waits for every candidate to settle, then snapshots + flattens +
 * ranks them and writes the terminal result. Candidates survive supervisor
 * replacement; a takeover supervisor adopts the still-running process groups
 * instead of re-spawning them.
 *
 * Exit codes: 0 = terminal state reached, 2 = usage/manifest/protocol
 * error, 5 = lease lost.
 */

const TICK_MS = 250;
const HEARTBEAT_MS = 5000;
const KILL_GRACE_MS = 5000;

function log(runDir: string, message: string): void {
	const { supervisorLog } = verifiedRunFilePaths(runDir);
	writeFileSync(supervisorLog, `[verified-supervisor ${new Date().toISOString()}] ${message}\n`, { flag: "a" });
}

function fail(message: string, code = 2): never {
	process.stderr.write(`[verified-supervisor] ${message}\n`);
	process.exit(code);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const [runDir, leaseId] = process.argv.slice(2);
if (!runDir || !leaseId) {
	fail(`usage: ${basename(process.argv[1] ?? "verified-main.ts")} <runDir> <leaseId>`);
}

let manifest: VerifiedRunManifest;
try {
	manifest = readVerifiedRunManifest(runDir);
} catch (error) {
	fail(`cannot read manifest: ${(error as Error).message}`);
}
if (isTerminalRunState(manifest.state)) {
	log(runDir, `run ${manifest.runId} already ${manifest.state}; nothing to own`);
	process.exit(0);
}
if (manifest.leaseId !== leaseId) {
	fail(`lease mismatch: manifest expects lease ${manifest.leaseId}, got ${leaseId}`, 5);
}
if (manifest.lease && manifest.lease.pid !== process.pid && isPidAlive(manifest.lease.pid)) {
	fail(`another supervisor (pid ${manifest.lease.pid}) still owns this run`, 5);
}

const runStartedAt = Date.now();
manifest.lease = {
	pid: process.pid,
	label: basename(process.execPath).replace(/\.exe$/, ""),
	startedAt: new Date().toISOString(),
	heartbeatAt: new Date().toISOString(),
};
writeVerifiedRunManifest(runDir, manifest);
log(runDir, `claimed run ${manifest.runId} (pid ${process.pid})`);

/** Live child handles for candidates this process spawned (adoption uses group liveness only). */
const children = new Map<number, ChildProcess>();
/** Exit bookkeeping updated from 'exit' events; persisted by the tick loop. */
const exits = new Map<number, { code: number | null; signal: string | null }>();

function killGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Already gone.
	}
}

async function killAllCandidates(): Promise<void> {
	const graceDeadline = Date.now() + KILL_GRACE_MS;
	for (const candidate of manifest.candidates) {
		if (isCandidateGroupAlive(candidate.pgid)) killGroup(candidate.pgid, "SIGTERM");
	}
	while (Date.now() < graceDeadline) {
		if (!manifest.candidates.some((candidate) => isCandidateGroupAlive(candidate.pgid))) return;
		await sleep(100);
	}
	for (const candidate of manifest.candidates) {
		if (isCandidateGroupAlive(candidate.pgid)) killGroup(candidate.pgid, "SIGKILL");
	}
}

function spawnCandidates(): void {
	const request = manifest.request;
	const specs = request.candidates;
	const recorded = new Set(manifest.candidates.map((candidate) => candidate.index));
	for (const spec of specs) {
		if (recorded.has(spec.index)) continue; // adopted by a predecessor; never re-spawn
		if (!existsSync(spec.worktree)) {
			fail(`candidate worktree missing before spawn: ${spec.worktree}`);
		}
		const child = spawn(request.piCommand, [...request.piCommandArgs, ...spec.args], {
			cwd: spec.worktree,
			detached: true, // own process group: survives this supervisor's death
			stdio: ["ignore", "ignore", "ignore"],
			env: { ...request.env, ...spec.env },
		});
		const pid = child.pid;
		if (!pid) fail(`candidate w${spec.index} spawn returned no pid`);
		children.set(spec.index, child);
		child.on("exit", (code, signal) => {
			exits.set(spec.index, { code, signal: signal ?? null });
		});
		child.on("error", (error) => {
			exits.set(spec.index, { code: null, signal: null });
			log(runDir, `candidate w${spec.index} spawn error: ${error.message}`);
			const record = manifest.candidates.find((candidate) => candidate.index === spec.index);
			if (record) record.error = `spawn failed: ${error.message}`;
		});
		child.unref();
		manifest.candidates.push({
			index: spec.index,
			pid,
			pgid: pid,
			startedAt: new Date().toISOString(),
			exitCode: null,
			exitSignal: null,
			settled: false,
		});
		// Persist each pid the moment it exists: a supervisor crash mid-spawn
		// must leave every spawned candidate adoptable (never orphaned and
		// never re-spawned) by the takeover supervisor.
		writeVerifiedRunManifest(runDir, manifest);
		log(runDir, `spawned candidate w${spec.index} pid ${pid} in ${spec.worktree}`);
	}
}

function provisionWorktrees(): void {
	const request = manifest.request;
	if (manifest.candidates.length > 0) return; // adopted run: worktrees already exist
	const preflight = preflightWorktreeSource(request.sourceRepo);
	if (preflight.baseCommit !== request.baseCommit) {
		manifest.result = {
			ok: false,
			selection: null,
			apply: null,
			failure: {
				code: "base-drift",
				message: `run ${manifest.runId}: source base drifted before candidates launched (request recorded ${request.baseCommit}, source is now ${preflight.baseCommit}); aborting before any spend`,
			},
			artifacts: { traces: [], report: "winner-report.md", ranking: "ranking.json" },
			elapsedMs: Date.now() - runStartedAt,
			finishedAt: new Date().toISOString(),
		};
		manifest.state = "failed";
		writeVerifiedRunManifest(runDir, manifest);
		log(runDir, `base commit drifted: ${request.baseCommit} -> ${preflight.baseCommit}; failing closed`);
		process.exit(0);
	}
	const worktrees = createCandidateWorktrees({
		cwd: request.sourceRepo,
		runId: manifest.runId,
		count: request.candidates.length,
		preflight,
	});
	for (const worktree of worktrees) {
		const spec = request.candidates.find((candidate) => candidate.index === worktree.index);
		if (spec && spec.worktree !== worktree.path) {
			fail(`worktree path mismatch for candidate w${worktree.index}: planned ${spec.worktree}, created ${worktree.path}`);
		}
	}
	log(runDir, `created ${worktrees.length} candidate worktrees at base ${request.baseCommit}`);
}

/**
 * Ticket 06 capability gate: before any worktree is created or candidate
 * launched, the configured verifier backend must pass the preflight probe
 * (usable A-T score-token logprobs) and the deterministic good-vs-bad
 * canary. A logprob-less backend fails here, having spent nothing.
 */
async function gateVerifierCapability(): Promise<{ coverage: string[]; canary: { goodScore: number; badScore: number } } | null> {
	if (manifest.candidates.length > 0) return null; // adopted run: a predecessor already gated
	const verifier = manifest.request.verifier;
	const probe = await runVerifierProbe(
		{
			model: verifier.model,
			thinking: verifier.thinking,
			criteriaPath: verifier.criteriaPath,
			env: verifier.env,
			mockVerifier: (verifier.mockVerifier as MockVerifierConfig | null | undefined) ?? null,
		},
		{ cwd: runDir, signal: verifyAbort.signal },
	);
	log(
		runDir,
		`capability probe passed: model=${probe.model} ${probe.coverage.scoreA.length} A-T letters at <score_A>, canary ${probe.canary.goodScore.toFixed(3)} > ${probe.canary.badScore.toFixed(3)}`,
	);
	return { coverage: probe.coverage.scoreA, canary: probe.canary };
}

function persistCandidateExits(): void {
	let dirty = false;
	for (const candidate of manifest.candidates) {
		const exit = exits.get(candidate.index);
		if (exit && !candidate.settled) {
			candidate.exitCode = exit.code;
			candidate.exitSignal = exit.signal;
			candidate.settled = true;
			dirty = true;
		}
		if (!candidate.settled && candidate.pid !== null && !isCandidateGroupAlive(candidate.pgid)) {
			// Adopted candidate (spawned by a dead predecessor): the exit code is
			// unobservable; settle detection falls back to the session file.
			candidate.settled = true;
			candidate.exitCode = null;
			dirty = true;
		}
	}
	if (dirty) writeVerifiedRunManifest(runDir, manifest);
}

function allSettled(): boolean {
	return manifest.candidates.length > 0 && manifest.candidates.every((candidate) => candidate.settled);
}

let cancelled = false;
const verifyAbort = new AbortController();
let lastHeartbeat = Date.now();
/** Traces written before a failure stay in the result's artifact list (ticket 06). */
let preservedTraceArtifacts: string[] = [];

process.on("SIGTERM", () => {
	cancelled = true;
	verifyAbort.abort();
});
process.on("SIGINT", () => {
	cancelled = true;
	verifyAbort.abort();
});

/** Watchdog covering every verifier call (gate + selection): cancellation,
 * lease loss, and heartbeat must be honored while the bridge runs. */
function startWatchdog(): () => void {
	const interval = setInterval(() => {
		void (async () => {
			if (!cancelled && existsSync(verifiedRunFilePaths(runDir).cancelSentinel)) {
				cancelled = true;
				log(runDir, "cancel observed during verification");
				verifyAbort.abort();
			}
			const current = safeReadManifest();
			if (current && (current.leaseId !== manifest.leaseId || (current.lease && current.lease.pid !== process.pid))) {
				log(runDir, "lease lost during verification; aborting selection");
				verifyAbort.abort();
			}
			if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
				lastHeartbeat = Date.now();
				if (manifest.lease) manifest.lease.heartbeatAt = new Date().toISOString();
				writeVerifiedRunManifest(runDir, manifest);
			}
		})();
	}, TICK_MS);
	return () => clearInterval(interval);
}

function verifierFailureCode(error: VerifierBridgeError): string {
	if (["capability", "credentials", "degenerate-scores", "comparison-count", "cache"].includes(error.kind)) {
		return error.kind;
	}
	return "verifier-failed";
}

try {
	const stopWatchdog = startWatchdog();
	// Ticket 06: gate the verifier backend BEFORE creating worktrees or
	// launching candidates (a fresh run only — an adopted run already paid
	// for its candidates behind a gate a predecessor passed).
	await gateVerifierCapability();
	provisionWorktrees();
	spawnCandidates(); // spawns only candidates no predecessor already recorded
	manifest.state = "running";
	writeVerifiedRunManifest(runDir, manifest);

	while (!allSettled()) {
		await sleep(TICK_MS);
		if (cancelled || existsSync(verifiedRunFilePaths(runDir).cancelSentinel)) {
			cancelled = true;
			log(runDir, "cancel observed; killing candidates");
			await killAllCandidates();
			for (const candidate of manifest.candidates) {
				if (!candidate.settled) {
					candidate.settled = true;
					candidate.exitSignal = "SIGTERM";
				}
			}
			manifest.result = failureResult(runStartedAt, "cancelled", `run ${manifest.runId} cancelled before selection`);
			manifest.state = "cancelled";
			writeVerifiedRunManifest(runDir, manifest);
			log(runDir, "run cancelled");
			process.exit(0);
		}
		const current = safeReadManifest();
		if (!current) continue; // atomic-rename race; retry next tick
		if (isTerminalRunState(current.state)) process.exit(0);
		if (current.leaseId !== manifest.leaseId || (current.lease && current.lease.pid !== process.pid)) {
			await killAllCandidates();
			fail("lease lost: another supervisor took over this run", 5);
		}
		if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
			lastHeartbeat = Date.now();
			if (manifest.lease) manifest.lease.heartbeatAt = new Date().toISOString();
			writeVerifiedRunManifest(runDir, manifest);
		}
		persistCandidateExits();
	}

	manifest.state = "verifying";
	writeVerifiedRunManifest(runDir, manifest);

	const settled = settleCandidates(manifest);
	const { distinct, collapsed, equivalences } = collapseDuplicates(settled);
	const traceArtifacts = writeTraceArtifacts(runDir, settled);
	preservedTraceArtifacts = traceArtifacts;
	log(
		runDir,
		`settled: ${distinct.length} distinct completed (${collapsed.length} collapsed) of ${settled.length}`,
	);
	if (equivalences.length > 0) {
		log(
			runDir,
			`equivalent candidates (identical tree + report): ${equivalences.map((e) => `w${e.candidate}=w${e.equivalentTo}`).join(", ")}`,
		);
	}
	let selection: Awaited<ReturnType<typeof selectWinner>>["selection"];
	let response: Awaited<ReturnType<typeof selectWinner>>["response"];
	try {
		({ selection, response } = await selectWinner(manifest, runDir, distinct, collapsed, equivalences, {
			signal: verifyAbort.signal,
		}));
	} finally {
		stopWatchdog();
	}
	writeResultArtifacts(runDir, selection.winnerReport, response);
	const apply = applySelectionWinner(manifest, selection);
	manifest.result = {
		ok: true,
		selection,
		failure: null,
		apply,
		artifacts: {
			traces: traceArtifacts,
			report: "winner-report.md",
			ranking: "ranking.json",
		},
		elapsedMs: Date.now() - runStartedAt,
		finishedAt: new Date().toISOString(),
	};
	manifest.state = "completed";
	writeVerifiedRunManifest(runDir, manifest);
	log(
		runDir,
		`run completed: winner w${selection.winnerIndex} (${distinct.length} distinct); apply ${apply.applied ? "succeeded" : `skipped (${apply.code})`}`,
	);
	process.exit(0);
} catch (error) {
	if (cancelled) {
		manifest.result = failureResult(runStartedAt, "cancelled", `run ${manifest.runId} cancelled during verification`);
		manifest.state = "cancelled";
		writeVerifiedRunManifest(runDir, manifest);
		process.exit(0);
	}
	const code = error instanceof SettleAbort
		? error.code
		: error instanceof VerifierBridgeError
			? verifierFailureCode(error)
			: "run-failed";
	let message = error instanceof Error ? error.message : String(error);
	if ((RETRYABLE_VERIFICATION_FAILURE_CODES as readonly string[]).includes(code)) {
		// Ticket 06: a halted selection preserves everything the candidates
		// paid for; the retry path re-ranks frozen traces without respawning.
		message += ` Candidate traces and snapshots are preserved in ${runDir}; retry verification without re-running candidates with retryVerifiedRunVerification(${JSON.stringify(runDir)}).`;
	}
	manifest.result = failureResult(runStartedAt, code, message, preservedTraceArtifacts);
	manifest.state = "failed";
	writeVerifiedRunManifest(runDir, manifest);
	log(runDir, `run failed (${code}): ${message}`);
	process.exit(0);
}

/**
 * Ticket 08: apply the winner's snapshot commit to the source worktree as an
 * explicit, IMMEDIATE clean-base compare-and-swap — this runs right here,
 * inside the live supervisor that just finished selection, never at an
 * arbitrary later time. Any drift/conflict/mismatch resets the transaction
 * and applies nothing; the winner branch is retained either way. On success
 * the candidate worktree directories are removed (branches/commits stay).
 */
function applySelectionWinner(
	manifest: VerifiedRunManifest,
	selection: VerifiedRunSelection,
): VerifiedRunApply {
	const request = manifest.request;
	const finishedAt = new Date().toISOString();
	try {
		const applied = applyWinnerToSource({
			sourceRepo: request.sourceRepo,
			baseCommit: request.baseCommit,
			winnerCommit: selection.winnerCommit,
			winnerTreeHash: selection.winnerTreeHash,
		});
		let worktreesRemoved = true;
		try {
			cleanupRunWorktrees(
				manifest.runId,
				request.sourceRepo,
				request.candidates.map((candidate) => candidate.worktree),
			);
		} catch (error) {
			worktreesRemoved = false;
			log(
				runDir,
				`worktree cleanup after apply failed: ${error instanceof Error ? error.message : String(error)} (branches remain)`,
			);
		}
		log(runDir, `applied winner w${selection.winnerIndex} onto base ${request.baseCommit} (tree ${applied.treeHash})`);
		return {
			applied: true,
			code: "applied",
			message: `winner changes are staged in ${request.sourceRepo}; review with git diff --staged, revert with git reset --hard ${request.baseCommit}`,
			treeHash: applied.treeHash,
			worktreesRemoved,
			finishedAt,
		};
	} catch (error) {
		const code = error instanceof ApplyError ? error.code : "apply-failed";
		const message = error instanceof Error ? error.message : String(error);
		log(runDir, `apply skipped (${code}): ${message}`);
		return {
			applied: false,
			code,
			message,
			treeHash: null,
			worktreesRemoved: false,
			finishedAt,
		};
	}
}

function safeReadManifest(): VerifiedRunManifest | null {
	try {
		return readVerifiedRunManifest(runDir);
	} catch {
		return null;
	}
}

function failureResult(startedAt: number, code: string, message: string, traces: string[] = []): VerifiedRunResult {
	return {
		ok: false,
		selection: null,
		apply: null,
		failure: { code, message },
		artifacts: { traces, report: "winner-report.md", ranking: "ranking.json" },
		elapsedMs: Date.now() - startedAt,
		finishedAt: new Date().toISOString(),
	};
}

function writeResultArtifacts(runDir: string, winnerReport: string, response: unknown): void {
	const paths = verifiedRunFilePaths(runDir);
	writeFileSync(paths.report, winnerReport, "utf8");
	writeFileSync(paths.ranking, `${JSON.stringify(response, null, "\t")}\n`, "utf8");
}
