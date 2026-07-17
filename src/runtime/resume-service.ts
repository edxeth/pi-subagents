import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { getPiInvocation, getPiShellParts, getSubagentChildProcessEnv } from "../launch/child-command.ts";
import { writeResumeTaskArtifact } from "../launch/prompt-artifacts.ts";
import { expandSubagentTask } from "../launch/task-expansion.ts";
import { buildInteractiveSentinelShellCommands } from "../launch/interactive-sentinel.ts";
import { parseEnvString } from "../launch/env.ts";
import { assertModelAllowed, buildModelRef } from "../agents/model-refs.ts";
import {
	getExtensionLaunchArgs,
	getPersistedPromptLaunchArgs,
	getPersistedSessionParityArgs,
	normalizeModelRef,
	resolveAvailableModelRef,
} from "../launch/prep.ts";
import {
	buildResumePiArgs,
	buildShellChangeDirectoryPrefix,
	getResumeCwd,
	resolveResumeLaunchMetadata,
} from "../launch/resume.ts";
import {
	createSurface,
	muxSetupHint,
	resolveZellijPlacementPolicy,
	sendShellCommand,
	shellEscape,
} from "../mux.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { getEntryCount } from "../session/session.ts";
import {
	getDoneSentinelFile,
	isResumeMode,
	readSubagentExtensionEntry,
	readSubagentLaunchMetadata,
	writeSubagentLaunchMetadataEntry,
	writeSubagentModelStateEntries,
	type PersistedSubagentLaunchMetadata,
} from "../session/session-files.ts";
import type { RunningSubagent, SubagentResult } from "../types.ts";

export interface ResumeServiceRuntime {
	getShellReadyDelayMs(): number;
	isMuxAvailable(): boolean;
	watchBackgroundSubagent(
		running: RunningSubagent,
		signal: AbortSignal,
	): Promise<SubagentResult>;
	watchSubagent(
		running: RunningSubagent,
		signal: AbortSignal,
	): Promise<SubagentResult>;
	getWatcherSignal(
		running: RunningSubagent,
		controller: AbortController,
	): AbortSignal;
	startWidgetRefresh(): void;
	getContextWindow(modelRef: string | undefined): number | undefined;
	runningSubagents: Map<string, RunningSubagent>;
	modelRegistry?: {
		getAvailable(): Array<{
			provider: string;
			id: string;
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

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function splitResumeModelRef(
	model: string,
	fallbackThinking: string | undefined,
): { model: string; thinking: string | undefined; explicitThinking: boolean } {
	const idx = model.lastIndexOf(":");
	if (idx === -1) return { model, thinking: fallbackThinking, explicitThinking: false };
	const suffix = model.slice(idx + 1);
	if (!THINKING_LEVELS.has(suffix)) return { model, thinking: fallbackThinking, explicitThinking: false };
	return { model: model.slice(0, idx), thinking: suffix, explicitThinking: true };
}

export function resolveResumeZellijPlacementPolicy(
	launchMetadata: PersistedSubagentLaunchMetadata | undefined,
	parentPolicy: string | undefined,
): ReturnType<typeof resolveZellijPlacementPolicy> | undefined {
	const agentPolicy = parseEnvString(launchMetadata?.env)
		.PI_SUBAGENT_ZELLIJ_PLACEMENT;
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
	const { effectiveModel, effectiveThinking, effectiveModelRef } = normalizeModelRef(
		resolved.model,
		resolved.thinking,
	);
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
	const { sessionFile, task } = input;

	if (!existsSync(sessionFile)) {
		throw new Error(`Session file not found: ${sessionFile}`);
	}

	const explicitMode = isResumeMode(input.mode) ? input.mode : undefined;
	const metadata = resolveResumeLaunchMetadata(sessionFile, explicitMode);
	const launchMetadata = readSubagentLaunchMetadata(sessionFile);
	const invocationMetadata = resolveResumeLaunchMetadataForInvocation(
		launchMetadata,
		input.model,
		input.thinking,
		runtime.modelRegistry,
	);
	const shouldPersistInvocationMetadata = invocationMetadata && invocationMetadata !== launchMetadata;
	const name = invocationMetadata?.name ?? metadata.name ?? input.name ?? "Resume";
	const displayName = input.name ?? name;

	if (metadata.mode === "interactive" && !runtime.isMuxAvailable()) {
		throw new Error(
			`Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
		);
	}

	// Guard: reject duplicate resume of the same session file
	const normalizedFile = resolve(sessionFile);
	for (const existing of runtime.runningSubagents.values()) {
		if (
			existing.sessionFile &&
			resolve(existing.sessionFile) === normalizedFile
		) {
			throw new Error(
				`Session "${existing.name}" (${existing.agent ?? "subagent"}) is already running with id ${existing.id}. ` +
					"Use subagent_kill first or wait for it to complete.",
			);
		}
	}

	const entryCountBefore = getEntryCount(sessionFile);
	clearSubagentExitSidecar(sessionFile);
	const subagentDonePath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"tools",
		"subagent-done.ts",
	);
	const savedExtensions =
		invocationMetadata?.extensions ?? readSubagentExtensionEntry(sessionFile);
	const extensionArgs = savedExtensions
		? getExtensionLaunchArgs(savedExtensions, subagentDonePath)
		: ["--no-extensions", "-e", subagentDonePath];
	const parityArgs = [
		...getPersistedPromptLaunchArgs(invocationMetadata),
		...(await getPersistedSessionParityArgs(invocationMetadata, metadata.mode)),
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
		Object.assign(resumeEnvVars, parseEnvString(invocationMetadata.env));
	}
	if (invocationMetadata?.agentConfigDir) {
		resumeEnvVars.PI_CODING_AGENT_DIR = invocationMetadata.agentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		resumeEnvVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	if (invocationMetadata?.denyTools?.length) {
		resumeEnvVars.PI_DENY_TOOLS = invocationMetadata.denyTools.join(",");
	} else if (process.env.PI_DENY_TOOLS) {
		resumeEnvVars.PI_DENY_TOOLS = process.env.PI_DENY_TOOLS;
	}
	if (savedExtensions !== undefined) {
		resumeEnvVars.PI_SUBAGENT_EXTENSIONS = savedExtensions.join(",");
	} else if (process.env.PI_SUBAGENT_EXTENSIONS) {
		resumeEnvVars.PI_SUBAGENT_EXTENSIONS = process.env.PI_SUBAGENT_EXTENSIONS;
	}
	if (process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE === "1") {
		resumeEnvVars.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
	}
	resumeEnvVars.PI_SUBAGENT_NAME = invocationMetadata?.name ?? name;
	if (resumedAgent) resumeEnvVars.PI_SUBAGENT_AGENT = resumedAgent;
	resumeEnvVars.PI_SUBAGENT_SESSION = sessionFile;

	const resumedAsync = invocationMetadata?.async ?? metadata.async ?? true;
	const resumedAutoExit =
		invocationMetadata?.autoExit ?? metadata.autoExit ?? true;
	if (resumedAutoExit) resumeEnvVars.PI_SUBAGENT_AUTO_EXIT = "1";
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
		parentClosePolicy:
			invocationMetadata?.parentClosePolicy ??
			metadata.parentClosePolicy ??
			"terminate",
		async: resumedAsync,
		blocking: resumedAsync === false,
		autoExit: resumedAutoExit,
		startTime: Date.now(),
		sessionFile,
		launchEntryCount: entryCountBefore,
		modelContextWindow: runtime.getContextWindow(invocationMetadata?.modelRef),
		modelRef: invocationMetadata?.modelRef,
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
			env: getSubagentChildProcessEnv(invocation, resumeEnvVars),
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
		const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
		const configuredZellijPolicy = resolveResumeZellijPlacementPolicy(
			invocationMetadata,
			process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT,
		);
		const surface = createSurface(surfaceName, {
			...(invocationMetadata?.zellijPlacementGroupKey &&
			Number.isInteger(parentPaneId)
				? {
						zellij: {
							groupKey: invocationMetadata.zellijPlacementGroupKey,
							parentPaneId,
							policy: configuredZellijPolicy,
						},
					}
				: {}),
		});
		await new Promise<void>((resolve) =>
			setTimeout(resolve, runtime.getShellReadyDelayMs()),
		);
		const doneSentinelFile = getDoneSentinelFile(sessionFile, id);
		const parts = getPiShellParts(
			buildResumePiArgs(sessionFile, "interactive"),
		);
		for (const arg of [...extensionArgs, ...parityArgs]) {
			parts.push(shellEscape(arg));
		}
		if (expandedTask !== undefined) {
			const taskPath = writeResumeTaskArtifact(
				name,
				expandedTask,
				sessionFile,
				resumeCwd ?? process.cwd(),
			);
			parts.push(shellEscape(`@${taskPath}`));
		}
		resumeEnvVars.PI_SUBAGENT_SURFACE = surface;
		const resumeEnvPrefix = `${Object.entries(resumeEnvVars)
			.map(([key, value]) => `${key}=${shellEscape(value)}`)
			.join(" ")} `;
		const sentinel = buildInteractiveSentinelShellCommands(doneSentinelFile);
		const command = `trap ${shellEscape(sentinel.exitTrap)} EXIT; ${buildShellChangeDirectoryPrefix(resumeCwd)}${resumeEnvPrefix}${parts.join(" ")}; ${sentinel.direct}`;
		sendShellCommand(surface, command);
		running.surface = surface;
		running.doneSentinelFile = doneSentinelFile;
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
			? runtime.watchBackgroundSubagent(
					running,
					runtime.getWatcherSignal(running, watcherAbort),
				)
			: runtime.watchSubagent(
					running,
					runtime.getWatcherSignal(running, watcherAbort),
				);

	return running;
}

function rememberTail(
	current: string | undefined,
	chunk: Buffer | string,
): string {
	return `${current ?? ""}${chunk.toString()}`.slice(-4000);
}
