import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentDefaults as loadAgentDefaultsFromDefinitions } from "../agents/definitions.ts";
import { assertModelAllowed, buildModelRef, splitModelRef } from "../agents/model-refs.ts";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { buildAppendSystemInheritancePlan } from "../launch/append-system.ts";
import { getPiInvocation, getSubagentChildProcessEnv } from "../launch/child-command.ts";
import { resolveDenyEnvPatterns } from "../launch/child-env.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "../launch/context-boundary.ts";
import { parseEnvString } from "../launch/env.ts";
import { resolveSubagentTimeoutState } from "../launch/policy.ts";
import {
	getExtensionLaunchArgs,
	getPersistedPromptLaunchArgs,
	getPersistedSessionParityArgs,
	normalizeModelRef,
	resolveAvailableModelRef,
} from "../launch/prep.ts";
import { writeResumeTaskArtifact } from "../launch/prompt-artifacts.ts";
import {
	buildResumePiArgs,
	getResumeCwd,
	resolveResumeLaunchMetadata,
} from "../launch/resume.ts";
import { expandSubagentTask } from "../launch/task-expansion.ts";
import { resolveSubagentCwd } from "../launch/runtime-paths.ts";
import { buildInteractiveShellCommand } from "../launch/shell-command.ts";
import { createZellijCommandSurface } from "../mux/zellij-placement.ts";
import { getZellijShellCommand, resolveZellijTarget } from "../mux/zellij-runtime.ts";
import {
	createSurface,
	getMuxBackend,
	muxSetupHint,
	resolveHerdrPlacementPolicy,
	resolveZellijPlacementPolicy,
	sendShellCommand,
} from "../mux.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { clearSubagentTimeoutSidecar, readSubagentTimeoutSidecar } from "../session/timeout-sidecar.ts";
import { getEntryCount } from "../session/session.ts";
import {
	getDoneSentinelFile,
	isResumeMode,
	type PersistedSubagentLaunchMetadata,
	readSubagentExtensionEntry,
	readSubagentLaunchMetadataEntries,
	writeSubagentLaunchMetadataEntry,
	writeSubagentModelStateEntries,
} from "../session/session-files.ts";
import {
	buildResumeSpawnEnv,
	narrowSpawnBudget,
	parseSpawnEnv,
	resolveSpawnPolicy,
} from "../spawn/policy.ts";
import { PI_SUBAGENT_CONTEXT_WARN_STEP, PI_SUBAGENT_CONTEXT_WARN_THRESHOLD } from "../tools/context-reminders.ts";
import {
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
} from "../tools/timeout-reminders.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";
import {
	claimSpawnWidthSlot,
	getLiveSlotCount,
	getSpawnWidthLimit,
	releaseSlots,
	releaseSpawnWidthSlot,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "./spawn-width.ts";

export interface ResumeServiceRuntime {
	getShellReadyDelayMs(): number;
	isMuxAvailable(): boolean;
	watchBackgroundSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	getWatcherSignal(running: RunningSubagent, controller: AbortController): AbortSignal;
	startWidgetRefresh(): void;
	getContextWindow(modelRef: string | undefined): number | undefined;
	runningSubagents: Map<string, RunningSubagent>;
	modelRegistry?: {
		getAvailable(): Array<{
			provider: string;
			id: string;
			reasoning?: boolean;
			thinkingLevelMap?: Record<string, string | null | undefined>;
		}>;
	};
}

export interface ResumeSessionInput {
	sessionFile: string;
	task?: string;
	name?: string;
	agent?: string;
	mode?: "interactive" | "background";
	model?: string;
	thinking?: string;
}

function splitResumeModelRef(
	model: string,
	fallbackThinking: string | undefined,
): { model: string; thinking: string | undefined; explicitThinking: boolean } {
	const split = splitModelRef(model);
	return split.thinking === undefined
		? { model, thinking: fallbackThinking, explicitThinking: false }
		: { model: split.model, thinking: split.thinking, explicitThinking: true };
}

export function resolveResumeHerdrPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveHerdrPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_HERDR_PLACEMENT;
	if (agentPolicy !== undefined) return resolveHerdrPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveHerdrPlacementPolicy(parentPolicy);
	return launchMetadata?.herdrPlacementPolicy;
}

export function resolveResumeZellijPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveZellijPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env).PI_SUBAGENT_ZELLIJ_PLACEMENT;
	if (agentPolicy !== undefined) return resolveZellijPlacementPolicy(agentPolicy);
	if (parentPolicy !== undefined) return resolveZellijPlacementPolicy(parentPolicy);
	return launchMetadata?.zellijPlacementPolicy;
}

export function resolveResumeLaunchMetadataForInvocation(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	requestedModel: string | undefined,
	requestedThinking?: string,
	modelRegistry?: ResumeServiceRuntime["modelRegistry"],
): PersistedSubagentLaunchMetadata | undefined {
	if (!launchMetadata || (!requestedModel && !requestedThinking)) return launchMetadata;
	if (launchMetadata.allowModelOverride === false) {
		return {
			...launchMetadata,
			...(requestedModel ? { ignoredModelOverride: requestedModel } : {}),
			...(requestedThinking ? { ignoredThinkingOverride: requestedThinking } : {}),
		};
	}
	const baseModel = requestedModel ?? launchMetadata.modelRef ?? launchMetadata.model;
	if (!baseModel) {
		throw new Error("Cannot apply thinking override without a persisted model.");
	}
	const requested = splitResumeModelRef(baseModel, requestedThinking ?? launchMetadata.thinking);
	const explicitThinking = requested.explicitThinking || requestedThinking != null;
	const resolved = resolveAvailableModelRef(
		requested.model,
		requested.thinking,
		explicitThinking,
		modelRegistry,
		launchMetadata.modelRef,
	);
	const { effectiveModel, effectiveThinking, effectiveModelRef } = normalizeModelRef(resolved.model, resolved.thinking);
	const implicitDefaultRef = buildModelRef(launchMetadata.definitionModel, launchMetadata.definitionThinking);
	const implicitAllowed = implicitDefaultRef
		? [implicitDefaultRef]
		: launchMetadata.modelSource === "parent" && launchMetadata.modelRef
			? [launchMetadata.modelRef]
			: [];
	assertModelAllowed(effectiveModelRef, launchMetadata.allowedModels, launchMetadata.name, implicitAllowed);
	return {
		...launchMetadata,
		timestamp: new Date().toISOString(),
		model: effectiveModel,
		thinking: effectiveThinking,
		modelRef: effectiveModelRef,
		modelSource: "resume-override",
		...(requestedModel ? { requestedModelOverride: requestedModel } : {}),
		...(requestedThinking ? { requestedThinkingOverride: requestedThinking } : {}),
	};
}

function mergeResumeInvocationMetadata(
	launchMetadata: PersistedSubagentLaunchMetadata,
	laterMetadata: PersistedSubagentLaunchMetadata,
): PersistedSubagentLaunchMetadata {
	return {
		...launchMetadata,
		...laterMetadata,
		// A child can append metadata to its own session. Keep grant authority
		// anchored to the first launch entry while allowing later entries to
		// carry legitimate invocation changes such as model and thinking.
		spawnBudget: launchMetadata.spawnBudget,
		spawnableAgents: launchMetadata.spawnableAgents,
		denyTools: launchMetadata.denyTools,
	};
}

/**
 * Shared resume logic used by both the LLM subagent_resume tool and the
 * /subagents TUI overlay. Handles validation, deduplication, environment
 * setup, process/pane spawning, and runtime registration.
 *
 * Callers must:
 * 1. Call wireSubagentSteerBack(pi, running, running.completionPromise!)
 * 2. Handle the result (await or return to user) as appropriate
 */
export async function resumeSubagentSession(
	input: ResumeSessionInput,
	runtime: ResumeServiceRuntime,
): Promise<RunningSubagent> {
	// Verified fan-out candidates are non-resumable (SPEC): their run is
	// finalized and their worktree workspace is deleted after selection, so a
	// resume would resurrect a session whose cwd no longer exists. Follow-up
	// work starts a fresh launch against the updated source tree.
	const verifiedRunDir = process.env.PI_SUBAGENT_VF_RUN_DIR;
	if (verifiedRunDir && verifiedRunDir.trim()) {
		throw new Error(
			`Session ${input.sessionFile} belongs to a verified fan-out run that is finalized (run dir ${verifiedRunDir}); ` +
				"the candidate's worktree workspace was removed after selection, so the session cannot be resumed. " +
				"Start a fresh launch of the agent instead.",
		);
	}
	const widthLimit = getSpawnWidthLimit();
	if (!tryAcquireSlots(1, widthLimit)) {
		throw new Error(
			`Spawn width limit reached (${getLiveSlotCount()}/${widthLimit} slots busy). Wait for a running subagent to finish, or use subagent_kill to free a slot. Interactive children with auto-exit: false keep their slot until the pane closes.`,
		);
	}

	let claimedRunning: RunningSubagent | undefined;
	try {
		const running = await resumeSubagentSessionWithoutWidth(input, runtime);
		claimSpawnWidthSlot(running);
		claimedRunning = running;
		if (running.completionPromise) {
			running.completionPromise = releaseSpawnWidthSlotOnCompletion(running, running.completionPromise);
		}
		return running;
	} catch (error) {
		if (claimedRunning) releaseSpawnWidthSlot(claimedRunning);
		else releaseSlots(1);
		throw error;
	}
}

async function resumeSubagentSessionWithoutWidth(
	input: ResumeSessionInput,
	runtime: ResumeServiceRuntime,
): Promise<RunningSubagent> {
	const { sessionFile, task } = input;

	if (!existsSync(sessionFile)) {
		throw new Error(`Session file not found: ${sessionFile}`);
	}

	const explicitMode = isResumeMode(input.mode) ? input.mode : undefined;
	const metadata = resolveResumeLaunchMetadata(sessionFile, explicitMode);
	const launchMetadataEntries = readSubagentLaunchMetadataEntries(sessionFile);
	const launchMetadata = launchMetadataEntries[0];
	const latestLaunchMetadata = launchMetadataEntries[launchMetadataEntries.length - 1];
	const invocationMetadataSource =
		launchMetadata && latestLaunchMetadata && latestLaunchMetadata !== launchMetadata
			? mergeResumeInvocationMetadata(launchMetadata, latestLaunchMetadata)
			: launchMetadata;
	const invocationMetadata = resolveResumeLaunchMetadataForInvocation(
		invocationMetadataSource,
		input.model,
		input.thinking,
		runtime.modelRegistry,
	);
	const shouldPersistInvocationMetadata = invocationMetadata && invocationMetadata !== invocationMetadataSource;
	const targetAgent = launchMetadata?.agent ?? metadata.agent ?? input.agent;
	const targetCwd = launchMetadata?.cwd ?? invocationMetadataSource?.cwd ?? process.cwd();
	const targetDefs = targetAgent
		? loadAgentDefaultsFromDefinitions(targetAgent, undefined, targetCwd, resolveSubagentCwd)
		: null;
	const callerEnv = parseSpawnEnv(process.env);
	const targetSpawning =
		launchMetadata?.spawnableAgents === true ? true : (launchMetadata?.spawnableAgents ?? false);
	const spawnPolicy = resolveSpawnPolicy({
		callerAgent: callerEnv.callerAgent,
		targetAgent: targetAgent ?? "",
		callerBudget: callerEnv.callerBudget,
		callerSpawnable: callerEnv.callerSpawnable,
		targetSpawning,
		targetSpawnDepth: launchMetadata?.spawnBudget ?? 0,
		targetSpawnWidth: targetDefs?.spawnWidth,
		targetVisibleTo: targetDefs?.visibleTo ?? ["all"],
		envDepthCeiling: callerEnv.envDepthCeiling,
		envWidthCeiling: callerEnv.envWidthCeiling,
	});
	if (!spawnPolicy.allowed) {
		throw new Error(`Error: ${spawnPolicy.reason ?? "Spawn policy denied this target."}`);
	}
	const narrowedSpawnBudget = narrowSpawnBudget(
		launchMetadata,
		callerEnv.callerBudget,
		callerEnv.envDepthCeiling,
	);
	const resumeSpawnEnv = buildResumeSpawnEnv(launchMetadata, narrowedSpawnBudget, spawnPolicy.effectiveWidth);
	const name = invocationMetadata?.name ?? metadata.name ?? input.name ?? "Resume";
	const displayName = input.name ?? name;

	if (metadata.mode === "interactive" && !runtime.isMuxAvailable()) {
		throw new Error(`Subagents require a supported terminal multiplexer. ${muxSetupHint()}`);
	}

	// Guard: reject duplicate resume of the same session file
	const normalizedFile = resolve(sessionFile);
	for (const existing of runtime.runningSubagents.values()) {
		if (existing.sessionFile && resolve(existing.sessionFile) === normalizedFile) {
			throw new Error(
				`Session "${existing.name}" (${existing.agent ?? "subagent"}) is already running with id ${existing.id}. ` +
					"Use subagent_kill first or wait for it to complete.",
			);
		}
	}

	const entryCountBefore = getEntryCount(sessionFile);
	clearSubagentExitSidecar(sessionFile);
	// Read the previous verdict before clearing it: it carries the budgets the
	// killed run was under, which is the only record for a session mode that
	// never persisted launch metadata.
	const previousTimeout = readSubagentTimeoutSidecar(sessionFile);
	// The previous run's verdict is spent. Clearing it here is what lets a
	// resumed run that finishes cleanly release a session an earlier timeout
	// had flagged, while a resumed run that times out again writes a fresh one.
	clearSubagentTimeoutSidecar(sessionFile);
	const subagentDonePath = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "subagent-done.ts");
	const savedExtensions = invocationMetadata ? invocationMetadata.extensions : readSubagentExtensionEntry(sessionFile);
	const extensionArgs =
		invocationMetadata !== undefined || savedExtensions !== undefined
			? getExtensionLaunchArgs(savedExtensions, subagentDonePath, narrowedSpawnBudget > 0)
			: ["--no-extensions", "-e", subagentDonePath];
	const parityArgs = [
		...getPersistedPromptLaunchArgs(invocationMetadata),
		...(await getPersistedSessionParityArgs(invocationMetadata, metadata.mode, narrowedSpawnBudget > 0)),
		...(invocationMetadata ? [] : ["--no-approve"]),
	];
	const resumeCwd = getResumeCwd(invocationMetadata);
	const expandedTask = task
		? await expandSubagentTask(task, {
				enabled: invocationMetadata?.taskExpansion === "shell",
				cwd: resumeCwd ?? process.cwd(),
			})
		: undefined;

	const resumedAgent = invocationMetadata?.agent ?? metadata.agent ?? input.agent;

	const resumeEnvVars: Record<string, string> = {};
	// Restore user-configured env vars from the original launch FIRST,
	// so internal PI vars below can override them if needed.
	if (invocationMetadata?.env) {
		const configuredEnv = parseEnvString(invocationMetadata.env);
		// Strip internal spawn-grant vars from the persisted frontmatter env so a
		// forged or stale value cannot override the narrowed grant written below.
		for (const key of [
			"PI_SUBAGENT_SPAWN_DEPTH",
			"PI_SUBAGENT_SPAWN_WIDTH",
			"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
			"PI_SUBAGENT_SPAWN_BUDGET",
			"PI_SUBAGENT_SPAWNABLE",
		]) {
			delete configuredEnv[key];
		}
		Object.assign(resumeEnvVars, configuredEnv);
	}
	Object.assign(
		resumeEnvVars,
		buildAppendSystemInheritancePlan({
			inheritAppendSystem: invocationMetadata?.inheritAppendSystem === true,
			systemPromptMode: invocationMetadata?.systemPromptMode,
			systemPrompt: invocationMetadata?.systemPrompt,
			boundarySystemPrompt: invocationMetadata?.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
		}).env,
	);
	if (invocationMetadata?.agentConfigDir) {
		resumeEnvVars.PI_CODING_AGENT_DIR = invocationMetadata.agentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		resumeEnvVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	const denyTools = new Set<string>();
	if (launchMetadata?.denyTools?.length) {
		for (const toolName of launchMetadata.denyTools) denyTools.add(toolName);
	} else if (process.env.PI_DENY_TOOLS) {
		for (const toolName of process.env.PI_DENY_TOOLS.split(",").map((name) => name.trim()).filter(Boolean)) {
			denyTools.add(toolName);
		}
	}
	for (const toolName of resumeSpawnEnv.denyToolsToAdd) denyTools.add(toolName);
	if (denyTools.size > 0) resumeEnvVars.PI_DENY_TOOLS = [...denyTools].join(",");
	// These grant variables are deliberately unconditional. Unlike the deny-tools
	// fallback above, inheriting process.env here would launder the parent's grant.
	resumeEnvVars.PI_SUBAGENT_SPAWN_BUDGET = resumeSpawnEnv.PI_SUBAGENT_SPAWN_BUDGET;
	resumeEnvVars.PI_SUBAGENT_SPAWNABLE = resumeSpawnEnv.PI_SUBAGENT_SPAWNABLE;
	resumeEnvVars.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE = resumeSpawnEnv.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE;
	if (savedExtensions !== undefined) {
		resumeEnvVars.PI_SUBAGENT_EXTENSIONS = savedExtensions.join(",");
	} else if (process.env.PI_SUBAGENT_EXTENSIONS) {
		resumeEnvVars.PI_SUBAGENT_EXTENSIONS = process.env.PI_SUBAGENT_EXTENSIONS;
	}
	if (process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE === "1") {
		resumeEnvVars.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
	}
	resumeEnvVars[PI_SUBAGENT_CONTEXT_WARN_THRESHOLD] = invocationMetadata?.contextWarnThreshold ?? "";
	resumeEnvVars[PI_SUBAGENT_CONTEXT_WARN_STEP] = invocationMetadata?.contextWarnStep ?? "";
	// Budget inheritance: a resumed run is bounded exactly like the launch that
	// created the session, so resuming a child that ran away cannot run away
	// unbounded.
	const resumeStartTime = Date.now();
	// Launch metadata is authoritative; the previous verdict is the fallback for
	// sessions that never persisted any.
	const resumedTimeout = invocationMetadata?.timeout ?? previousTimeout?.budget?.timeoutSeconds;
	const resumedIdleTimeout = invocationMetadata?.idleTimeout ?? previousTimeout?.budget?.idleTimeoutSeconds;
	resumeEnvVars[PI_SUBAGENT_TIMEOUT] = resumedTimeout ? String(resumedTimeout) : "";
	resumeEnvVars[PI_SUBAGENT_IDLE_TIMEOUT] = resumedIdleTimeout ? String(resumedIdleTimeout) : "";
	resumeEnvVars[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = invocationMetadata?.timeoutWarnThreshold ?? "";
	if (resumedTimeout || resumedIdleTimeout) {
		resumeEnvVars[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(resumeStartTime);
	}
	resumeEnvVars.PI_SUBAGENT_NAME = invocationMetadata?.name ?? name;
	resumeEnvVars.PI_SUBAGENT_AGENT = resumedAgent ?? "";
	resumeEnvVars.PI_SUBAGENT_SESSION = sessionFile;

	const resumedAsync = invocationMetadata?.async ?? metadata.async ?? true;
	const resumedAutoExit = invocationMetadata?.autoExit ?? metadata.autoExit ?? true;
	resumeEnvVars.PI_SUBAGENT_AUTO_EXIT = resumedAutoExit ? "1" : "";
	resumeEnvVars.PI_PACKAGE_DIR = "";
	resumeEnvVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();

	const id = Math.random().toString(16).slice(2, 10);
	const running: RunningSubagent = {
		id,
		name,
		task: task ?? "resumed session",
		agent: resumedAgent,
		mode: metadata.mode,
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: invocationMetadata?.parentClosePolicy ?? metadata.parentClosePolicy ?? "terminate",
		async: resumedAsync,
		blocking: resumedAsync === false,
		autoExit: resumedAutoExit,
		reportContextUsage: invocationMetadata?.reportContextUsage ?? true,
		...resolveSubagentTimeoutState({
			timeout: resumedTimeout,
			idleTimeout: resumedIdleTimeout,
			timeoutWarnThreshold: invocationMetadata?.timeoutWarnThreshold,
			onTimeout: invocationMetadata?.onTimeout ?? (previousTimeout?.blocksResume ? "block-resume" : undefined),
		}),
		startTime: resumeStartTime,
		sessionFile,
		launchEntryCount: entryCountBefore,
		modelContextWindow: runtime.getContextWindow(invocationMetadata?.modelRef),
		modelRef: invocationMetadata?.modelRef,
		launchMetadata: invocationMetadata,
	};

	if (metadata.mode === "background") {
		const invocation = getPiInvocation([
			...buildResumePiArgs(sessionFile, "background"),
			...extensionArgs,
			...parityArgs,
		]);
		const child = spawn(invocation.command, invocation.args, {
			...(resumeCwd ? { cwd: resumeCwd } : {}),
			detached: true,
			stdio:
				running.parentClosePolicy === "continue"
					? (["pipe", "ignore", "ignore"] as const)
					: (["pipe", "pipe", "pipe"] as const),
			env: getSubagentChildProcessEnv(invocation, resumeEnvVars, resolveDenyEnvPatterns(invocationMetadata?.denyEnv)),
		});
		if (expandedTask !== undefined) {
			child.stdin?.end(expandedTask);
		} else {
			child.stdin?.end();
		}
		child.unref();
		running.childProcess = child;
		child.stdout?.on("data", (chunk: Buffer) => {
			running.stdoutTail = rememberTail(running.stdoutTail, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			running.stderrTail = rememberTail(running.stderrTail, chunk);
		});
	} else {
		const surfaceName = invocationMetadata?.sessionTitle ?? displayName;
		const backend = getMuxBackend();
		const herdrContext =
			backend === "herdr"
				? {
						policy: resolveResumeHerdrPlacementPolicy(invocationMetadata, process.env.PI_SUBAGENT_HERDR_PLACEMENT),
					}
				: undefined;
		const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
		const configuredZellijPolicy = resolveResumeZellijPlacementPolicy(
			invocationMetadata,
			process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT,
		);
		const zellijContext =
			invocationMetadata?.zellijPlacementGroupKey && Number.isInteger(parentPaneId)
				? {
						groupKey: invocationMetadata.zellijPlacementGroupKey,
						parentPaneId,
						policy: configuredZellijPolicy,
					}
				: undefined;
		const zellijTarget = backend === "zellij" ? await resolveZellijTarget() : undefined;
		const ordinarySurface = zellijTarget
			? undefined
			: await createSurface(surfaceName, {
					herdr: herdrContext,
					zellij: zellijContext,
				});
		const doneSentinelFile = getDoneSentinelFile(sessionFile, id);
		const piArgs = buildResumePiArgs(sessionFile, "interactive");
		piArgs.push(...extensionArgs, ...parityArgs);
		if (expandedTask !== undefined) {
			const taskPath = writeResumeTaskArtifact(name, expandedTask, sessionFile, resumeCwd ?? process.cwd());
			piArgs.push(`@${taskPath}`);
		}
		if (zellijTarget) resumeEnvVars.ZELLIJ_SESSION_NAME = zellijTarget.sessionName;
		if (ordinarySurface) resumeEnvVars.PI_SUBAGENT_SURFACE = ordinarySurface;
		const { command, dispose } = buildInteractiveShellCommand({
			cwd: resumeCwd ?? undefined,
			piArgs,
			envOverrides: resumeEnvVars,
			denyEnv: invocationMetadata?.denyEnv,
			doneSentinelFile,
			...(zellijTarget ? { deriveZellijPaneSurface: true } : {}),
		});
		try {
			const surface =
				ordinarySurface ??
				(await createZellijCommandSurface(surfaceName, zellijTarget!, getZellijShellCommand(command), zellijContext));
			if (!zellijTarget) {
				await new Promise<void>((resolve) => setTimeout(resolve, runtime.getShellReadyDelayMs()));
				sendShellCommand(surface, command);
			}
			running.surface = surface;
			running.doneSentinelFile = doneSentinelFile;
			running.zellijTarget = zellijTarget;
		} catch (error) {
			// Nothing consumed the capsule; do not leave credentials behind.
			dispose();
			throw error;
		}
	}

	if (shouldPersistInvocationMetadata) {
		if (invocationMetadata.modelSource === "resume-override") {
			writeSubagentModelStateEntries(sessionFile, invocationMetadata);
		}
		writeSubagentLaunchMetadataEntry(sessionFile, invocationMetadata);
	}
	runtime.runningSubagents.set(id, running);
	runtime.startWidgetRefresh();

	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;
	running.completionPromise =
		metadata.mode === "background"
			? runtime.watchBackgroundSubagent(running, runtime.getWatcherSignal(running, watcherAbort))
			: runtime.watchSubagent(running, runtime.getWatcherSignal(running, watcherAbort));

	return running;
}

function rememberTail(current: string | undefined, chunk: Buffer | string): string {
	return `${current ?? ""}${chunk.toString()}`.slice(-4000);
}
