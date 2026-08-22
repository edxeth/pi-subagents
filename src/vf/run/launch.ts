import { getArtifactProjectName, getArtifactStorageRoot } from "../../artifact-storage.ts";
import type { AgentDefaults } from "../../agents/definitions.ts";
import { buildParentEnvSnapshot } from "../../launch/child-env.ts";
import { buildBackgroundLaunchPlan } from "../../launch/background.ts";
import { basename, dirname, join } from "node:path";
import type { SubagentLaunchContext } from "../../launch/prep.ts";
import { runningSubagents } from "../../runtime/state.ts";
import {
	claimSpawnWidthSlot,
	getSpawnWidthLimit,
	releaseSlots,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "../../runtime/spawn-width.ts";
import { SPAWNING_TOOL_NAMES } from "../../tools/tool-names.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../../types.ts";
import { resolveVerifiedFanOutLaunch } from "../criteria.ts";
import { assertVerifierCredentials, resolveVerifierModel } from "../verifier-profile.ts";
import { candidateWorktreeBranchName, candidateWorktreeDirName, preflightWorktreeSource } from "../worktrees.ts";
import { newRunId } from "../supervisor/run-client.ts";
import { startVerifiedRun, verifiedRunDirFor, waitForVerifiedRunResult } from "./client.ts";
import { claimVerifiedRunDelivery } from "./types.ts";
import type { VerifiedCandidateSpec, VerifiedRunManifest, VerifiedRunRequest } from "./types.ts";

/**
 * Parent-side launch of a verified fan-out (ticket 07).
 *
 * A launch of an agent marked `llm-as-a-verifier: true` becomes ONE logical
 * child: N candidates are planned here from one resolved launch plan
 * (byte-identical prompt), spawned in isolated git worktrees by a detached
 * supervisor, ranked when they settle, and routed back as a single outcome.
 * Per-candidate steer/result routes never exist in the parent.
 */

export class VerifiedLaunchError extends Error {
	/** Machine-readable failure code (spawn_width, no-session-unsupported, ...). */
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = "VerifiedLaunchError";
		this.code = code;
	}
}

/** Test seam mirroring the ticket-05 bridge mock; never set by production paths. */
const MOCK_VERIFIER_ENV = "PI_SUBAGENT_VF_MOCK_VERIFIER";

export function verifiedRunsBaseDir(cwd: string): string {
	return join(getArtifactStorageRoot(), getArtifactProjectName(cwd));
}

/** Force `spawning: false` normalization on a candidate env overlay. */
function denyCandidateSpawning(env: Record<string, string>): void {
	env.PI_SUBAGENT_SPAWN_BUDGET = "0";
	env.PI_SUBAGENT_SPAWNABLE = "";
	const denied = new Set((env.PI_DENY_TOOLS ?? "").split(",").filter(Boolean));
	for (const tool of SPAWNING_TOOL_NAMES) denied.add(tool);
	env.PI_DENY_TOOLS = [...denied].join(",");
}

function candidateLaunchEnv(repoBasename: string, runId: string, index: number): Record<string, string> {
	return {
		COMPOSE_PROJECT_NAME: `${repoBasename}-vf-${runId}-w${index}`,
		PORT_OFFSET: String((index - 1) * 100),
	};
}

export interface VerifiedFanOutLaunch {
	running: RunningSubagent;
	runId: string;
	runDir: string;
}

export async function launchVerifiedFanOut(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults,
	ctx: SubagentLaunchContext,
	options: { signal?: AbortSignal; awaited?: boolean; slotsPreReserved?: boolean } = {},
): Promise<VerifiedFanOutLaunch> {
	const fanout = resolveVerifiedFanOutLaunch(
		{
			llmAsVerifierCandidates: agentDefs.llmAsVerifierCandidates,
			llmAsVerifierModel: agentDefs.llmAsVerifierModel ?? undefined,
			llmAsVerifierCriteria: agentDefs.llmAsVerifierCriteria,
		},
		ctx.cwd,
	);
	const verifier = resolveVerifierModel({ override: fanout.modelOverride ?? undefined, baseCwd: ctx.cwd });
	assertVerifierCredentials(verifier);
	if (agentDefs.noSession) {
		throw new VerifiedLaunchError(
			`Agent ${params.agent} uses no-session sessions; verified fan-out candidates need durable session files so their transcripts can be flattened and ranked.`,
			"no-session-unsupported",
		);
	}
	const preflight = preflightWorktreeSource(ctx.cwd);
	const runId = newRunId();
	const runDir = verifiedRunDirFor(verifiedRunsBaseDir(ctx.cwd), runId);
	const repoParent = dirname(preflight.repoRoot);
	const repoBasename = basename(preflight.repoRoot);

	// Slot accounting: the fan-out's N candidates consume N spawn slots,
	// reserved before any worktree creation or verifier spend. The subagent
	// tool pre-reserves the full N for verified children (one atomic batch
	// reservation); direct callers get the same reservation here.
	const limit = getSpawnWidthLimit();
	if (!options.slotsPreReserved && !tryAcquireSlots(fanout.candidates, limit)) {
		throw new VerifiedLaunchError(
			`Verified fan-out needs ${fanout.candidates} spawn slots (spawn width limit ${limit}); ` +
				`wait for running subagents to finish or lower llm-as-a-verifier-candidates.`,
			"spawn_width",
		);
	}
	let reservedExtra = fanout.candidates - 1;
	const releaseReserved = () => {
		if (reservedExtra > 0) {
			releaseSlots(reservedExtra);
			reservedExtra = 0;
		}
	};

	try {
		// SPEC normalization profile: candidates are background, auto-exit,
		// non-spawning workers with durable sessions; everything else about
		// the agent definition is preserved.
		const candidateCtx: SubagentLaunchContext = { ...ctx, autoExit: true };
		const specs: VerifiedCandidateSpec[] = [];
		let frozenTaskArg: string | undefined;
		let frozenFullTask: string | undefined;
		let fullTask = "";
		let piCommand = "";
		let baseEnv: Record<string, string> | undefined;
		let denyPatterns: string[] = [];
		let modelRef: string | undefined;
		for (let index = 1; index <= fanout.candidates; index++) {
			const worktree = join(repoParent, candidateWorktreeDirName(preflight.repoRoot, runId, index));
			const candidateParams: SubagentParamsInput = {
				...params,
				background: true,
				forcedCwd: worktree,
				launchEnv: candidateLaunchEnv(repoBasename, runId, index),
			};
			const plan = await buildBackgroundLaunchPlan(candidateParams, candidateCtx, {
				frozenTaskArg,
				frozenFullTask,
				spawningDenied: true,
			});
			if (index === 1) {
				frozenTaskArg = plan.taskArg;
				frozenFullTask = plan.fullTask;
				fullTask = plan.fullTask;
				piCommand = plan.invocation.command;
				denyPatterns = plan.denyPatterns;
				modelRef = plan.launch.prepared.effectiveModelRef;
				baseEnv = buildParentEnvSnapshot(process.env, denyPatterns);
			} else if (plan.fullTask !== fullTask) {
				throw new VerifiedLaunchError(
					`candidate ${index} prompt diverged from candidate 1 (${plan.fullTask.length} vs ${fullTask.length} chars)`,
					"prompt-drift",
				);
			}
			denyCandidateSpawning(plan.launch.envVars);
			// Ticket 08: candidate sessions are non-resumable once their run is
			// finalized; this marker lets subagent_resume fail with the precise
			// error instead of resurrecting a session in a deleted worktree.
			plan.launch.envVars.PI_SUBAGENT_VF_RUN_DIR = runDir;
			specs.push({
				index,
				sessionFile: plan.launch.prepared.subagentSessionFile,
				worktree,
				internalBranch: candidateWorktreeBranchName(runId, index),
				args: plan.args,
				env: plan.launch.envVars,
				launchEntryCount: plan.launch.launchEntryCount,
			});
		}

		const mockVerifier = process.env[MOCK_VERIFIER_ENV];
		const request: VerifiedRunRequest = {
			kind: "verified-fanout",
			name: params.name,
			title: params.title,
			piCommand,
			taskArtifact: frozenTaskArg!.slice(1),
			taskPrompt: fullTask,
			sourceRepo: preflight.repoRoot,
			baseCommit: preflight.baseCommit,
			agent: params.agent,
			candidateCount: fanout.candidates,
			candidates: specs,
			verifier: {
				model: verifier.model,
				thinking: verifier.thinking,
				env: verifier.env,
				criteriaPath: fanout.criteria.path,
				...(mockVerifier !== undefined ? { mockVerifier: JSON.parse(mockVerifier) } : {}),
			},
			env: baseEnv!,
			parentSessionId: ctx.sessionManager.getSessionId?.() ?? null,
			createdAt: new Date().toISOString(),
		};

		const started = startVerifiedRun({
			baseDir: verifiedRunsBaseDir(ctx.cwd),
			runId,
			request,
		});
		reservedExtra = 0; // ownership transferred to the completion promise

		const startTime = Date.now();
		const running: RunningSubagent = {
			id: runId.slice(-8),
			name: params.name,
			task: params.task,
			title: params.title,
			agent: params.agent,
			mode: "background",
			executionState: "running",
			deliveryState: options.awaited ? "awaited" : "detached",
			parentClosePolicy: "continue",
			blocking: params.blocking ?? false,
			async: params.async ?? !(params.blocking ?? false),
			autoExit: true,
			noSession: false,
			startTime,
			sessionFile: specs[0].sessionFile,
			launchEntryCount: specs[0].launchEntryCount,
			modelRef,
			verifiedRunDir: started.runDir,
			verifiedRunId: runId,
		};
		const watcherAbort = new AbortController();
		running.abortController = watcherAbort;
		running.completionPromise = releaseSpawnWidthSlotOnCompletion(
			running,
			waitForVerifiedOutcome(started.runDir, runId, params, startTime, {
				signal: options.signal ?? watcherAbort.signal,
				reservedSlots: fanout.candidates - 1,
			}),
		);
		claimSpawnWidthSlot(running);
		runningSubagents.set(running.id, running);
		return { running, runId, runDir: started.runDir };
	} catch (error) {
		releaseReserved();
		throw error;
	}
}

/** Poll the durable manifest; resolve ONE SubagentResult for the whole fan-out. */
async function waitForVerifiedOutcome(
	runDir: string,
	runId: string,
	params: SubagentParamsInput,
	startTime: number,
	options: { signal: AbortSignal; reservedSlots: number },
): Promise<SubagentResult> {
	try {
		const manifest = await waitForVerifiedRunResult(runDir, { signal: options.signal });
		return deliverOnce(manifest, runDir, params, startTime);
	} catch (error) {
		if (options.signal.aborted) {
			// The wait stopped (kill or parent shutdown), not the run: give the
			// cancel path a grace window to terminalize, then surface the state.
			const settled = await waitForVerifiedRunResult(runDir, { timeoutMs: 10_000 }).catch(() => null);
			if (settled) return deliverOnce(settled, runDir, params, startTime);
		}
		throw error;
	} finally {
		if (options.reservedSlots > 0) releaseSlots(options.reservedSlots);
	}
}

/** Claim the delivery exactly once; a run another session already delivered must not steer again. */
function deliverOnce(
	manifest: VerifiedRunManifest,
	runDir: string,
	params: Pick<SubagentParamsInput, "name" | "task">,
	startTime: number,
): SubagentResult {
	const claim = claimVerifiedRunDelivery(runDir);
	const result = verifiedRunToSubagentResult(manifest, runDir, params, startTime);
	if (!claim.claimed) {
		result.summary = `[verified fan-out ${manifest.runId} result already delivered by another session (pid ${claim.claimedByPid})]`;
	}
	return result;
}

export function verifiedRunToSubagentResult(
	manifest: VerifiedRunManifest,
	runDir: string,
	params: Pick<SubagentParamsInput, "name" | "task">,
	startTime: number,
): SubagentResult {
	const result = manifest.result;
	const elapsed = (Date.now() - startTime) / 1000;
	if (!result) {
		return {
			name: params.name,
			task: params.task,
			summary: `Verified fan-out run ${manifest.runId} is ${manifest.state} with no recorded result.`,
			exitCode: 1,
			elapsed,
			errorMessage: `run ${manifest.state} without a result`,
			sessionFile: manifest.request.candidates[0]?.sessionFile,
		};
	}
	if (result.ok && result.selection) {
		const selection = result.selection;
		const footer = verificationFooter(manifest, runDir);
		return {
			name: params.name,
			task: params.task,
			summary: `${selection.winnerReport}${footer}`,
			summarySource: "subagent",
			sessionFile: selection.winnerSessionFile,
			exitCode: 0,
			elapsed,
			outputTokens: undefined,
		};
	}
	return {
		name: params.name,
		task: params.task,
		summary: result.failure?.message ?? `Verified fan-out run ${manifest.runId} failed.`,
		exitCode: 1,
		elapsed,
		errorMessage: result.failure ? `${result.failure.code}: ${result.failure.message}` : "run failed",
	};
}

/**
 * Compact verification footer (ticket 08): everything needed to audit the
 * selection — N, winner id, criteria, score, verifier token usage, artifact
 * path — plus the exact review/revert commands for the applied winner.
 */
function verificationFooter(manifest: VerifiedRunManifest, runDir: string): string {
	const selection = manifest.result!.selection!;
	const apply = manifest.result!.apply;
	const usage = selection.usage;
	const applyLine = apply?.applied
		? `winner changes applied and staged — review \`git diff --staged\`, revert \`git reset --hard ${manifest.request.baseCommit}\``
		: apply
			? `winner NOT applied (${apply.code}); winner retained on branch \`${selection.winnerBranch}\``
			: `winner retained on branch \`${selection.winnerBranch}\``;
	return (
		`\n\n[verified fan-out ${manifest.runId}: winner w${selection.winnerIndex} of ` +
		`${manifest.request.candidateCount} candidates (${selection.distinctCandidates} distinct), ` +
		`score ${selection.winnerScore.toFixed(3)}, criteria ${selection.criteria.join(", ")}, ` +
		`verifier ${selection.model} (${usage.calls} calls, ${usage.inputTokens} in / ${usage.outputTokens} out tokens)\n` +
		`${applyLine}; artifacts ${runDir}]`
	);
}
