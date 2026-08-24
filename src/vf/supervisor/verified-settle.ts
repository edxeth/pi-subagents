import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findLastSubagentOutputWithSource, getEntries } from "../../session/session.ts";
import { flattenSessionTrace } from "../flatten.ts";
import { defaultVerifierCachePath, runVerifierSelect, type MockVerifierConfig, type VerifierSelectResponse } from "../verifier/bridge.ts";
import { snapshotCandidateWorktree, type CandidateSnapshot, type CandidateWorktree } from "../worktrees.ts";
import type { VerifiedCandidateRuntime, VerifiedRunManifest, VerifiedRunSelection } from "../run/types.ts";

/**
 * Settle phases of a verified fan-out run, executed by the detached
 * supervisor once every candidate process is gone (ticket 07):
 * snapshot each candidate's worktree, flatten its session to a trace, collapse
 * exact duplicates, require two distinct completed candidates, then rank the
 * traces with the ticket-05 bridge and record the winner. Every failure is a
 * structured run failure — a winner is never fabricated.
 */

export interface SettledCandidate {
	spec: VerifiedRunManifest["request"]["candidates"][number];
	runtime: VerifiedCandidateRuntime;
	/** Exit-0 process (or adopted-with-report) that produced a session. */
	completed: boolean;
	report: string;
	trace: string | null;
	snapshot: CandidateSnapshot | null;
	snapshotError?: string;
	distinctKey: string | null;
}

export class SettleAbort extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "SettleAbort";
		this.code = code;
	}
}

function extractCandidateReport(sessionFile: string): string {
	try {
		const output = findLastSubagentOutputWithSource(getEntries(sessionFile));
		return output?.summary ?? "";
	} catch {
		return "";
	}
}

function flattenCandidateTrace(sessionFile: string): string {
	const flattened = flattenSessionTrace(sessionFile);
	return flattened.text;
}

/** Snapshot + flatten every settled candidate; completed requires exit 0 (or an adopted session with a report). */
export function settleCandidates(manifest: VerifiedRunManifest): SettledCandidate[] {
	return manifest.request.candidates.map((spec) => {
		const runtime = manifest.candidates.find((entry) => entry.index === spec.index);
		if (!runtime) {
			throw new SettleAbort("candidate-record-missing", `run ${manifest.runId}: no runtime record for candidate w${spec.index}`);
		}
		if (!runtime.settled) {
			throw new SettleAbort("candidate-unsettled", `run ${manifest.runId}: candidate w${spec.index} is not settled`);
		}
		const exitedOk = runtime.exitCode === 0;
		const adoptedWithReport = runtime.exitCode === null && runtime.error === undefined;
		const completed = (exitedOk || adoptedWithReport) && spec.sessionFile.length > 0;
		const report = completed ? extractCandidateReport(spec.sessionFile) : "";
		let snapshot: CandidateSnapshot | null = null;
		let snapshotError: string | undefined;
		if (completed) {
			try {
				snapshot = snapshotCandidateWorktree(worktreeFor(manifest, spec));
			} catch (error) {
				snapshotError = error instanceof Error ? error.message : String(error);
			}
		}
		const trace = completed && !snapshotError ? safeTrace(manifest, spec.index, spec.sessionFile) : null;
		const reportHash = createHash("sha256").update(report).digest("hex");
		const distinctKey =
			completed && snapshot && !snapshotError ? `${snapshot.treeHash}:${reportHash}` : null;
		return { spec, runtime, completed: completed && !snapshotError, report, trace, snapshot, snapshotError, distinctKey };
	});
}

function worktreeFor(
	manifest: VerifiedRunManifest,
	spec: VerifiedRunManifest["request"]["candidates"][number],
): CandidateWorktree {
	return {
		runId: manifest.runId,
		index: spec.index,
		repoRoot: manifest.request.sourceRepo,
		path: spec.worktree,
		branch: spec.internalBranch,
		baseCommit: manifest.request.baseCommit,
	};
}

function safeTrace(manifest: VerifiedRunManifest, index: number, sessionFile: string): string | null {
	try {
		return flattenCandidateTrace(sessionFile);
	} catch (error) {
		throw new SettleAbort(
			"trace-flatten-failed",
			`run ${manifest.runId}: flattening candidate w${index} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Collapse exact duplicates (tree hash + report hash); returns distinct representatives in index order. */
export function collapseDuplicates(settled: SettledCandidate[]): {
	distinct: SettledCandidate[];
	collapsed: number[];
	equivalences: Array<{ candidate: number; equivalentTo: number }>;
} {
	const byKey = new Map<string, SettledCandidate>();
	const collapsed: number[] = [];
	const equivalences: Array<{ candidate: number; equivalentTo: number }> = [];
	for (const candidate of settled) {
		if (!candidate.completed || !candidate.distinctKey) continue;
		const existing = byKey.get(candidate.distinctKey);
		if (existing) {
			collapsed.push(candidate.spec.index);
			equivalences.push({ candidate: candidate.spec.index, equivalentTo: existing.spec.index });
		} else {
			byKey.set(candidate.distinctKey, candidate);
		}
	}
	return { distinct: [...byKey.values()], collapsed, equivalences };
}

export function writeTraceArtifacts(runDir: string, settled: SettledCandidate[]): string[] {
	const paths: string[] = [];
	for (const candidate of settled) {
		if (!candidate.completed || !candidate.trace) continue;
		const file = join(runDir, "traces", `w${candidate.spec.index}.txt`);
		mkdirSync(join(runDir, "traces"), { recursive: true });
		writeFileSync(file, candidate.trace, "utf8");
		paths.push(file);
	}
	return paths;
}

export interface SelectionOutcome {
	selection: VerifiedRunSelection;
	response: VerifierSelectResponse;
}

/** Rank distinct completed candidates with the real bridge; any failure aborts the run (never a fabricated winner). */
export async function selectWinner(
	manifest: VerifiedRunManifest,
	runDir: string,
	distinct: SettledCandidate[],
	collapsed: number[],
	equivalences: Array<{ candidate: number; equivalentTo: number }>,
	options: { signal?: AbortSignal } = {},
): Promise<SelectionOutcome> {
	if (distinct.length < 2) {
		const equivalenceNote =
			collapsed.length > 0
				? ` All ${distinct.length + collapsed.length} finished attempts made the same code and report.`
				: "";
		throw new SettleAbort(
			"insufficient-distinct-candidates",
			`run ${manifest.runId} failed: only ${distinct.length} different finished attempt(s); at least two are required, so nothing was applied.${equivalenceNote}`,
		);
	}
	const response = await runVerifierSelect({
		problem: manifest.request.taskPrompt,
		candidates: distinct.map((candidate) => candidate.trace!),
		criteriaPath: manifest.request.verifier.criteriaPath,
		model: manifest.request.verifier.model,
		thinking: manifest.request.verifier.thinking,
		cachePath: defaultVerifierCachePath(runDir),
		env: manifest.request.verifier.env,
		mockVerifier: (manifest.request.verifier.mockVerifier as MockVerifierConfig | null | undefined) ?? null,
	}, {
		signal: options.signal,
		cwd: runDir,
	});
	const winner = distinct[response.winnerIndex];
	if (!winner) {
		throw new SettleAbort("winner-out-of-range", `bridge returned winnerIndex ${response.winnerIndex} outside the distinct set`);
	}
	const indexMap = new Map(distinct.map((candidate, order) => [order, candidate.spec.index]));
	const ranking = response.ranking.map((order) => indexMap.get(order) ?? -1);
	const selection: VerifiedRunSelection = {
		winnerIndex: winner.spec.index,
		ranking,
		scores: response.scores,
		criteria: response.criteria,
		model: response.model,
		winnerSessionFile: winner.spec.sessionFile,
		winnerWorktree: winner.spec.worktree,
		winnerBranch: winner.spec.internalBranch,
		winnerCommit: winner.snapshot?.commit ?? "",
		winnerTreeHash: winner.snapshot?.treeHash ?? "",
		winnerChanged: winner.snapshot?.changed ?? false,
		winnerScore: response.scores[response.ranking.indexOf(response.winnerIndex)] ?? 0,
		winnerReport: winner.report,
		winnerTrace: winner.trace ?? "",
		usage: {
			calls: response.usage.calls,
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
		},
		distinctCandidates: distinct.length,
		collapsed,
		equivalences,
		runnerUpSessionFiles: distinct
			.filter((candidate) => candidate.spec.index !== winner.spec.index)
			.map((candidate) => candidate.spec.sessionFile),
	};
	return { selection, response };
}
