import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefaults } from "../agents/definitions.ts";
import { loadAgentDefaults as loadAgentDefaultsFromDefinitions } from "../agents/definitions.ts";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import {
	buildIdentityBlock,
	type PersistedSubagentLaunchMetadata,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import { PI_SUBAGENT_CONTEXT_WARN_STEP, PI_SUBAGENT_CONTEXT_WARN_THRESHOLD } from "../tools/context-reminders.ts";
import {
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
} from "../tools/timeout-reminders.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import { SPAWNING_TOOL_NAMES } from "../tools/tool-names.ts";
import { parseSpawnEnv, resolveSpawnPolicy, type SpawnPolicyResult } from "../spawn/policy.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { buildAppendSystemInheritancePlan } from "./append-system.ts";
import { parseCommandWords } from "./child-command.ts";
import { buildChildLaunchPlan, type ModelRegistryLike } from "./child-launch-plan.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import { parseEnvString } from "./env.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentNoSession,
	resolveSubagentParentClosePolicy,
	resolveSubagentReportContextUsage,
} from "./policy.ts";
import type { ResumeMode } from "./resume.ts";
import { type ResolvedSubagentRuntimePaths, resolveSubagentCwd } from "./runtime-paths.ts";
import { buildSkillLaunchPlan, formatInjectedSkills, type SkillLaunchPlan } from "./skills.ts";

export {
	normalizeModelRef,
	resolveAvailableModelRef,
	splitModelRefThinking,
} from "./child-launch-plan.ts";

export interface SubagentLaunchContext {
	sessionManager: {
		getSessionFile(): string | null | undefined;
		getSessionId(): string;
		getLeafId?(): string | null;
	};
	cwd: string;
	modelRegistry?: ModelRegistryLike;

	launchToolCallId?: string;
	/** Override for auto-exit (used in headless mode to force auto-exit on). */
	autoExit?: boolean;
	/** Parent model ref to inherit when the agent frontmatter doesn't define a model. */
	parentModelRef?: string;
	/** Parent thinking level to inherit when the agent frontmatter doesn't define thinking. */
	parentThinking?: string;
}

export interface PreparedSubagentLaunch {
	agentDefs: AgentDefaults | null;
	effectiveModel?: string;
	effectiveThinking?: string;
	effectiveModelRef?: string;
	effectiveTools?: string;
	effectiveSkills?: string;
	effectiveInjectSkills?: string;
	skillLaunchPlan: SkillLaunchPlan;
	sessionFile: string | null;
	runtimePaths: ResolvedSubagentRuntimePaths;
	subagentSessionFile: string;
	sessionTitle?: string;
	denySet: Set<string>;
	effectiveExtensions?: string[];
	identity: string;
	identityInSystemPrompt: boolean;
	/** Original agent-level auto-exit, preserved before any headless-mode override. */
	agentAutoExit?: boolean;
	spawnPolicy?: SpawnPolicyResult;
}

function loadAgentDefaults(
	agentName: string,
	cwdHint: string | null | undefined,
	baseCwd: string,
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(agentName, cwdHint, baseCwd, resolveSubagentCwd);
}

function resolvePreparedSpawnPolicy(params: SubagentParamsInput, agentDefs: AgentDefaults | null): SpawnPolicyResult {
	const callerEnv = parseSpawnEnv(process.env);
	return resolveSpawnPolicy({
		callerAgent: callerEnv.callerAgent,
		targetAgent: params.agent,
		callerBudget: callerEnv.callerBudget,
		callerSpawnable: callerEnv.callerSpawnable,
		targetSpawning: agentDefs?.spawning ?? false,
		targetSpawnDepth: agentDefs?.spawnDepth,
		targetSpawnWidth: agentDefs?.spawnWidth,
		targetVisibleTo: agentDefs?.visibleTo ?? ["all"],
		envDepthCeiling: callerEnv.envDepthCeiling,
		envWidthCeiling: callerEnv.envWidthCeiling,
	});
}

export async function prepareSubagentLaunch(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	mode: ResumeMode = "background",
): Promise<PreparedSubagentLaunch> {
	const agentDefs = params.agent ? loadAgentDefaults(params.agent, params.cwd, ctx.cwd) : null;
	const spawnPolicy = resolvePreparedSpawnPolicy(params, agentDefs);
	// Preserve the original agent-level auto-exit before any headless-mode override
	// so that persisted metadata always reflects the agent file, not the runtime override.
	const agentAutoExit = agentDefs?.autoExit;
	// Apply headless-mode auto-exit override so downstream consumers (mode hint,
	// env vars, running state) all see the effective runtime value.
	if (ctx.autoExit !== undefined && agentDefs) {
		agentDefs.autoExit = ctx.autoExit;
	}
	const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
	// When there is no parent session file (pi --no-session), standalone
	// no-session children can still launch with a tmpdir fallback.
	// Lineage-tracked children (lineage-only / fork) will fail later in
	// seedSubagentSessionFile with a clear error.
	const parentSessionDir = sessionFile !== null ? dirname(sessionFile) : join(tmpdir(), "pi-subagents", "parentless");
	const childLaunchPlan = await buildChildLaunchPlan({
		params,
		agentDefs,
		parentCwd: ctx.cwd,
		parentSessionDir,
		modelRegistry: ctx.modelRegistry,
		parentModelRef: ctx.parentModelRef,
		parentThinking: ctx.parentThinking,
		mode,
	});
	const { effectiveModel, effectiveThinking, effectiveModelRef, runtimePaths, subagentSessionFile, sessionTitle } =
		childLaunchPlan;
	const {
		tools: effectiveTools,
		skills: effectiveSkills,
		injectSkills: effectiveInjectSkills,
		denySet,
		extensions: effectiveExtensions,
		skillLaunchPlan,
	} = childLaunchPlan.capability;
	const identity = buildIdentityBlock(agentDefs, params.systemPrompt);
	const identityInSystemPrompt = !!(agentDefs?.systemPromptMode && identity);

	return {
		agentDefs,
		effectiveModel,
		effectiveThinking,
		effectiveModelRef,
		effectiveTools,
		effectiveSkills,
		effectiveInjectSkills,
		skillLaunchPlan,
		sessionFile,
		runtimePaths,
		subagentSessionFile,
		sessionTitle,
		denySet,
		effectiveExtensions,
		identity,
		identityInSystemPrompt,
		agentAutoExit,
		spawnPolicy,
	};
}

export function getPreparedModel(prepared: PreparedSubagentLaunch): string | undefined {
	if (!prepared.effectiveModel) return undefined;
	return prepared.effectiveThinking
		? `${prepared.effectiveModel}:${prepared.effectiveThinking}`
		: prepared.effectiveModel;
}

/**
 * Whether the child actually holds a spawn grant. Mirrors the rule the env
 * builder uses for PI_DENY_TOOLS: a null child budget means no spawning tools.
 */
export function isPreparedChildSpawningAllowed(prepared: PreparedSubagentLaunch): boolean {
	return (prepared.spawnPolicy?.childBudget ?? null) !== null;
}

export function getPreparedSkillList(_prepared: PreparedSubagentLaunch): string[] {
	return [];
}

export function getPreparedSkillInjection(prepared: PreparedSubagentLaunch): string {
	return formatInjectedSkills(
		prepared.skillLaunchPlan.injectSkills,
		prepared.runtimePaths.effectiveCwd ?? process.cwd(),
		prepared.skillLaunchPlan.betterSkillsActive,
	);
}

export function getPreparedSkillLaunchArgs(prepared: PreparedSubagentLaunch): string[] {
	return prepared.skillLaunchPlan.launchArgs;
}

/**
 * Entry point of this extension, used to force-load pi-subagents into a child
 * whose `extensions:` list replaced the inherited set.
 */
export function getSubagentsExtensionPath(): string {
	return join(dirname(dirname(fileURLToPath(import.meta.url))), "index.ts");
}

/**
 * Whether an `extensions:` list already brings in pi-subagents, in which case
 * force-loading it again would register its tools twice.
 */
function includesSubagentsExtension(extensionSpecs: string[]): boolean {
	return extensionSpecs.some((spec) => /(^|[/@:])pi-subagents(\b|[/@])/.test(spec.trim()));
}

export function getExtensionLaunchArgs(
	extensionSpecs: string[] | undefined,
	mandatoryExtensionPath: string,
	spawningAllowed = false,
): string[] {
	const args: string[] = [];
	if (extensionSpecs !== undefined) args.push("--no-extensions");
	args.push("-e", mandatoryExtensionPath);
	for (const extension of extensionSpecs ?? []) args.push("-e", extension);
	// `extensions:` replaces the inherited extension set, which would otherwise
	// drop pi-subagents itself and leave a granted child without the tools that
	// `spawning` promised. Load it after the child's selected extensions so a
	// later extension cannot replace the active tool set and silently drop the
	// spawning tools that this extension registers.
	if (spawningAllowed && extensionSpecs !== undefined && !includesSubagentsExtension(extensionSpecs)) {
		args.push("-e", getSubagentsExtensionPath());
	}
	return args;
}

export function getFlagsLaunchArgs(flags: string | undefined): string[] {
	if (!flags?.trim()) return [];
	return parseCommandWords(flags);
}

export function getApprovalLaunchArgs(
	agentDefs: Pick<AgentDefaults, "trustProject"> | null | undefined,
	mode: ResumeMode,
): string[] {
	if (mode === "background") return ["--no-approve"];
	return agentDefs?.trustProject === true ? ["--approve"] : ["--no-approve"];
}

export function getPersistedApprovalLaunchArgs(
	metadata: Pick<PersistedSubagentLaunchMetadata, "trustProject"> | undefined,
	mode: ResumeMode,
): string[] {
	if (mode === "background") return ["--no-approve"];
	return metadata?.trustProject === true ? ["--approve"] : ["--no-approve"];
}

export function getPreparedExtensionLaunchArgs(
	prepared: PreparedSubagentLaunch,
	mandatoryExtensionPath: string,
): string[] {
	return getExtensionLaunchArgs(
		prepared.effectiveExtensions,
		mandatoryExtensionPath,
		isPreparedChildSpawningAllowed(prepared),
	);
}

export function getPreparedSessionLaunchArgs(
	prepared: Pick<PreparedSubagentLaunch, "agentDefs" | "subagentSessionFile" | "sessionTitle">,
): string[] {
	const args = resolveSubagentNoSession(prepared.agentDefs)
		? ["--session", prepared.subagentSessionFile, "--no-session"]
		: ["--session", prepared.subagentSessionFile];
	if (prepared.sessionTitle) args.push("--name", prepared.sessionTitle);
	return args;
}

export function getPersistedPromptLaunchArgs(metadata: PersistedSubagentLaunchMetadata | undefined): string[] {
	return buildAppendSystemInheritancePlan({
		inheritAppendSystem: metadata?.inheritAppendSystem === true,
		systemPromptMode: metadata?.systemPromptMode,
		systemPrompt: metadata?.systemPrompt,
		boundarySystemPrompt: metadata?.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
	}).promptArgs;
}

export async function getPersistedSessionParityArgs(
	metadata: PersistedSubagentLaunchMetadata | undefined,
	modeOverride?: ResumeMode,
	spawningAllowed = false,
): Promise<string[]> {
	const args: string[] = [];
	if (!metadata) return args;
	if (metadata.modelRef) args.push("--model", metadata.modelRef);
	if (metadata.noContextFiles) args.push("--no-context-files");
	args.push(...getSubagentToolLaunchArgs(metadata.tools, new Set(metadata.denyTools), spawningAllowed));
	args.push(
		...(
			await buildSkillLaunchPlan(metadata.skills, undefined, metadata.cwd, metadata.agentConfigDir, metadata.extensions)
		).launchArgs,
	);
	args.push(...getPersistedApprovalLaunchArgs(metadata, modeOverride ?? metadata.mode));
	args.push(...getFlagsLaunchArgs(metadata.flags));
	return args;
}

export function cleanupNoSessionSessionFile(running: Pick<RunningSubagent, "noSession" | "sessionFile">): void {
	if (!running.noSession || !existsSync(running.sessionFile)) return;
	try {
		rmSync(running.sessionFile, { force: true });
	} catch {}
}

export function getPreparedRoleBlock(prepared: PreparedSubagentLaunch): string {
	return prepared.identity && !prepared.identityInSystemPrompt ? `\n\n${prepared.identity}` : "";
}

export function buildPersistedSubagentLaunchMetadata(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	mode: ResumeMode,
	sessionMode: SubagentSessionMode,
	boundarySystemPrompt: boolean,
	systemPrompt?: string,
	placement?: Pick<
		PersistedSubagentLaunchMetadata,
		"herdrPlacementPolicy" | "zellijPlacementPolicy" | "zellijPlacementGroupKey"
	>,
): PersistedSubagentLaunchMetadata {
	const allowModelOverride = prepared.agentDefs?.allowModelOverride !== false;
	const modelSource =
		params.model || params.thinking
			? "launch-override"
			: prepared.agentDefs?.model
				? "agent"
				: prepared.effectiveModel
					? "parent"
					: undefined;

	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: params.name,
		...(params.title ? { title: params.title } : {}),
		...(prepared.sessionTitle ? { sessionTitle: prepared.sessionTitle } : {}),
		...(params.agent ? { agent: params.agent } : {}),
		mode,
		sessionMode,
		...(prepared.agentAutoExit !== undefined ? { autoExit: prepared.agentAutoExit } : {}),
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		reportContextUsage: resolveSubagentReportContextUsage(prepared.agentDefs),
		async: params.async !== false,
		...(prepared.effectiveModel ? { model: prepared.effectiveModel } : {}),
		...(prepared.effectiveThinking ? { thinking: prepared.effectiveThinking } : {}),
		...(prepared.effectiveModelRef ? { modelRef: prepared.effectiveModelRef } : {}),
		...(prepared.agentDefs?.model ? { definitionModel: prepared.agentDefs.model } : {}),
		...(prepared.agentDefs?.thinking ? { definitionThinking: prepared.agentDefs.thinking } : {}),
		...(prepared.agentDefs?.allowedModels ? { allowedModels: prepared.agentDefs.allowedModels } : {}),
		allowModelOverride,
		...(modelSource ? { modelSource } : {}),
		...(params.model ? { requestedModelOverride: params.model } : {}),
		...(params.thinking ? { requestedThinkingOverride: params.thinking } : {}),
		...(prepared.effectiveTools ? { tools: prepared.effectiveTools } : {}),
		...(prepared.effectiveSkills ? { skills: prepared.effectiveSkills } : {}),
		...(prepared.effectiveInjectSkills ? { injectSkills: prepared.effectiveInjectSkills } : {}),
		denyTools: [...prepared.denySet],
		...(prepared.spawnPolicy
			? {
					spawnableAgents: prepared.spawnPolicy.spawnableAgents,
					spawnBudget: prepared.spawnPolicy.childBudget,
				}
			: {}),
		...(prepared.effectiveExtensions !== undefined ? { extensions: prepared.effectiveExtensions } : {}),
		noContextFiles: resolveSubagentNoContextFiles(prepared.agentDefs),
		inheritAppendSystem: prepared.agentDefs?.inheritAppendSystem === true,
		noSession: resolveSubagentNoSession(prepared.agentDefs),
		trustProject: prepared.agentDefs?.trustProject === true,
		agentConfigDir: prepared.runtimePaths.effectiveAgentConfigDir,
		cwd: prepared.runtimePaths.targetCwdForSession,
		...(prepared.agentDefs?.systemPromptMode ? { systemPromptMode: prepared.agentDefs.systemPromptMode } : {}),
		...(systemPrompt ? { systemPrompt } : {}),
		boundarySystemPrompt,
		...(prepared.agentDefs?.taskExpansion ? { taskExpansion: prepared.agentDefs.taskExpansion } : {}),
		...(prepared.agentDefs?.timeout ? { timeout: prepared.agentDefs.timeout } : {}),
		...(prepared.agentDefs?.idleTimeout ? { idleTimeout: prepared.agentDefs.idleTimeout } : {}),
		...(prepared.agentDefs?.timeoutWarnThreshold
			? { timeoutWarnThreshold: prepared.agentDefs.timeoutWarnThreshold }
			: {}),
		...(prepared.agentDefs?.onTimeout ? { onTimeout: prepared.agentDefs.onTimeout } : {}),
		...(prepared.agentDefs?.contextWarnThreshold
			? {
					contextWarnThreshold: prepared.agentDefs.contextWarnThreshold,
					...(prepared.agentDefs.contextWarnStep ? { contextWarnStep: prepared.agentDefs.contextWarnStep } : {}),
				}
			: {}),
		...(placement?.herdrPlacementPolicy ? { herdrPlacementPolicy: placement.herdrPlacementPolicy } : {}),
		...(placement?.zellijPlacementPolicy ? { zellijPlacementPolicy: placement.zellijPlacementPolicy } : {}),
		...(placement?.zellijPlacementGroupKey ? { zellijPlacementGroupKey: placement.zellijPlacementGroupKey } : {}),

		...(prepared.agentDefs?.flags ? { flags: prepared.agentDefs.flags } : {}),
		...(prepared.agentDefs?.env ? { env: prepared.agentDefs.env } : {}),
	};
}

export function getBaseSubagentEnvVars(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	resolveEffectiveSessionMode: (params: SubagentParamsInput, agentDefs: AgentDefaults | null) => SubagentSessionMode,
): Record<string, string> {
	const envVars: Record<string, string> = { PI_PACKAGE_DIR: "" };
	// Merge user-configured env vars from frontmatter first,
	// so internal PI vars below can override them if needed.
	if (prepared.agentDefs?.env) {
		const configuredEnv = parseEnvString(prepared.agentDefs.env);
		for (const key of [
			"PI_SUBAGENT_SPAWN_DEPTH",
			"PI_SUBAGENT_SPAWN_WIDTH",
			"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
			"PI_SUBAGENT_SPAWN_BUDGET",
			"PI_SUBAGENT_SPAWNABLE",
		]) {
			delete configuredEnv[key];
		}
		Object.assign(envVars, configuredEnv);
	}
	if (prepared.runtimePaths.localAgentConfigDir) {
		envVars.PI_CODING_AGENT_DIR = prepared.runtimePaths.localAgentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		envVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	if (prepared.effectiveExtensions !== undefined) {
		envVars.PI_SUBAGENT_EXTENSIONS = prepared.effectiveExtensions.join(",");
	}
	if (process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE === "1") {
		envVars.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
	}
	envVars[PI_SUBAGENT_CONTEXT_WARN_THRESHOLD] = prepared.agentDefs?.contextWarnThreshold ?? "";
	envVars[PI_SUBAGENT_CONTEXT_WARN_STEP] = prepared.agentDefs?.contextWarnStep ?? "";
	envVars[PI_SUBAGENT_TIMEOUT] = prepared.agentDefs?.timeout ? String(prepared.agentDefs.timeout) : "";
	envVars[PI_SUBAGENT_IDLE_TIMEOUT] = prepared.agentDefs?.idleTimeout ? String(prepared.agentDefs.idleTimeout) : "";
	envVars[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = prepared.agentDefs?.timeoutWarnThreshold ?? "";
	envVars.PI_SUBAGENT_NAME = params.name;
	if (params.agent) envVars.PI_SUBAGENT_AGENT = params.agent;
	const spawnPolicy = prepared.spawnPolicy ?? resolvePreparedSpawnPolicy(params, prepared.agentDefs);
	envVars.PI_SUBAGENT_SPAWN_BUDGET = String(spawnPolicy.childBudget ?? 0);
	envVars.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE =
		spawnPolicy.effectiveWidth === null ? "" : String(spawnPolicy.effectiveWidth);
	envVars.PI_SUBAGENT_SPAWNABLE =
		spawnPolicy.spawnableAgents === true ? "true" : spawnPolicy.spawnableAgents.join(",");
	const deniedTools = new Set(prepared.denySet);
	if (spawnPolicy.childBudget === null) {
		for (const toolName of SPAWNING_TOOL_NAMES) deniedTools.add(toolName);
	}
	if (deniedTools.size > 0) envVars.PI_DENY_TOOLS = [...deniedTools].join(",");
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	if (sessionMode !== "standalone") if (prepared.sessionFile) envVars.PI_SUBAGENT_PARENT_SESSION = prepared.sessionFile;
	envVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
	return envVars;
}
