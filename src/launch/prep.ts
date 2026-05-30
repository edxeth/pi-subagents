import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import type { AgentDefaults } from "../agents/definitions.ts";
import { loadAgentDefaults as loadAgentDefaultsFromDefinitions } from "../agents/definitions.ts";

import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import { parseCommandWords } from "./child-command.ts";
import { parseEnvString } from "./env.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentNoSession,
	resolveSubagentParentClosePolicy,
	resolveSubagentExtensions,
} from "./policy.ts";
import type { ResumeMode } from "./resume.ts";
import { resolveSubagentCwd, resolveSubagentRuntimePaths, type ResolvedSubagentRuntimePaths } from "./runtime-paths.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import {
	buildIdentityBlock,
	generateSubagentSessionFile,
	type PersistedSubagentLaunchMetadata,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import { buildSubagentSessionTitle } from "../agents/titles.ts";
import { addToolModeDeniedNames, getSubagentToolLaunchArgs, resolveDenyTools } from "../tools/policy.ts";
import { buildSkillLaunchPlan, formatInjectedSkills, type SkillLaunchPlan } from "./skills.ts";

export interface ModelRegistryLike {
	getAvailable(): Array<{
		provider: string;
		id: string;
		thinkingLevelMap?: Record<string, string | null | undefined>;
	}>;
}

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
}

function loadAgentDefaults(
	agentName: string,
	cwdHint: string | null | undefined,
	baseCwd: string,
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(
		agentName,
		cwdHint,
		baseCwd,
		resolveSubagentCwd,
	);
}

/**
 * Normalize model and thinking into a safe model ref.
 *
 * Handles two edge cases:
 * 1. When the model string already carries a `:thinking` suffix (e.g.
 *    `provider/model:high`) and an explicit thinking level is also set,
 *    strip the embedded suffix to avoid double suffixes like `:high:low`.
 * 2. When no model is available at all (undefined), suppress both thinking
 *    and modelRef — persisting `undefined:<thinking>` would break resume.
 */
export function normalizeModelRef(
	model: string | undefined,
	thinking: string | undefined,
): { effectiveModel: string | undefined; effectiveThinking: string | undefined; effectiveModelRef: string | undefined } {
	if (!model) {
		return { effectiveModel: undefined, effectiveThinking: undefined, effectiveModelRef: undefined };
	}
	// Strip any embedded :thinking suffix when we also have an explicit thinking
	// level, so the combined ref doesn't double up: "provider/model:high:low".
	let baseModel = model;
	if (thinking) {
		const idx = model.lastIndexOf(":");
		if (idx !== -1) {
			const suffix = model.slice(idx + 1);
			if (["minimal", "low", "medium", "high", "xhigh"].includes(suffix)) {
				baseModel = model.slice(0, idx);
			}
		}
	}
	const ref = thinking ? `${baseModel}:${thinking}` : baseModel;
	return { effectiveModel: baseModel, effectiveThinking: thinking, effectiveModelRef: ref };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function splitModelRefThinking(
	model: string | undefined,
	fallbackThinking: string | undefined,
): { model: string | undefined; thinking: string | undefined; explicitThinking: boolean } {
	if (!model) return { model, thinking: fallbackThinking, explicitThinking: false };
	const idx = model.lastIndexOf(":");
	if (idx === -1) return { model, thinking: fallbackThinking, explicitThinking: false };
	const suffix = model.slice(idx + 1);
	if (!THINKING_LEVELS.has(suffix)) return { model, thinking: fallbackThinking, explicitThinking: false };
	return { model: model.slice(0, idx), thinking: suffix, explicitThinking: true };
}

export function resolveAvailableModelRef(
	model: string | undefined,
	thinking: string | undefined,
	explicitThinking: boolean,
	modelRegistry: ModelRegistryLike | undefined,
	parentModelRef?: string,
): { model: string | undefined; thinking: string | undefined } {
	if (!model || !modelRegistry) return { model, thinking };
	const available = modelRegistry.getAvailable();
	if (available.length === 0) return { model, thinking };
	const [parentProvider] = parentModelRef?.split("/") ?? [];
	let resolved = model;
	let provider: string | undefined;
	let id: string;
	const slash = model.indexOf("/");
	if (slash === -1) {
		id = model;
		const matches = available.filter((candidate) => candidate.id === id);
		if (matches.length === 1) {
			provider = matches[0]?.provider;
			resolved = `${provider}/${id}`;
		} else if (matches.length > 1 && parentProvider) {
			const parentProviderMatch = matches.find((candidate) => candidate.provider === parentProvider);
			if (parentProviderMatch) {
				provider = parentProviderMatch.provider;
				resolved = `${provider}/${id}`;
			} else {
				throw new Error(`Ambiguous model override '${model}'. Use provider/model.`);
			}
		} else if (matches.length > 1) {
			throw new Error(`Ambiguous model override '${model}'. Use provider/model.`);
		} else {
			throw new Error(`Unknown model override '${model}'.`);
		}
	} else {
		provider = model.slice(0, slash);
		id = model.slice(slash + 1);
		const match = available.find((candidate) => candidate.provider === provider && candidate.id === id);
		if (!match) throw new Error(`Unknown model override '${model}'.`);
	}
	const match = available.find((candidate) => `${candidate.provider}/${candidate.id}` === resolved);
	if (thinking && match?.thinkingLevelMap?.[thinking] === null) {
		if (!explicitThinking) return { model: resolved, thinking: undefined };
		throw new Error(`Model '${resolved}' does not support thinking level '${thinking}'.`);
	}
	return { model: resolved, thinking };
}

export async function prepareSubagentLaunch(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
): Promise<PreparedSubagentLaunch> {
	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, params.cwd, ctx.cwd)
		: null;
	// Preserve the original agent-level auto-exit before any headless-mode override
	// so that persisted metadata always reflects the agent file, not the runtime override.
	const agentAutoExit = agentDefs?.autoExit;
	// Apply headless-mode auto-exit override so downstream consumers (mode hint,
	// env vars, running state) all see the effective runtime value.
	if (ctx.autoExit !== undefined && agentDefs) {
		agentDefs.autoExit = ctx.autoExit;
	}
	const requestedModel = params.model ?? agentDefs?.model ?? ctx.parentModelRef;
	const requested = splitModelRefThinking(requestedModel, params.thinking ?? agentDefs?.thinking ?? ctx.parentThinking);
	const explicitThinking = requested.explicitThinking || params.thinking != null;
	const availableRequested = params.model
		? resolveAvailableModelRef(
			requested.model,
			requested.thinking,
			explicitThinking,
			ctx.modelRegistry,
			ctx.parentModelRef,
		)
		: requested;
	const { effectiveModel, effectiveThinking, effectiveModelRef } = normalizeModelRef(
		availableRequested.model,
		availableRequested.thinking,
	);
	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const effectiveInjectSkills = agentDefs?.injectSkills;

	const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
	// When there is no parent session file (pi --no-session), standalone
	// no-session children can still launch with a tmpdir fallback.
	// Lineage-tracked children (lineage-only / fork) will fail later in
	// seedSubagentSessionFile with a clear error.
	const parentSessionDir =
		sessionFile !== null ? dirname(sessionFile) : join(tmpdir(), "pi-subagents", "parentless");
	const runtimePaths = resolveSubagentRuntimePaths(
		params,
		agentDefs,
		ctx.cwd,
		parentSessionDir,
	);
	const subagentSessionFile = generateSubagentSessionFile(
		resolveSubagentNoSession(agentDefs)
			? join(tmpdir(), "pi-subagents", "sessions")
			: runtimePaths.sessionDir,
	);
	const sessionTitle = buildSubagentSessionTitle(params);
	const denySet = addToolModeDeniedNames(
		resolveDenyTools(agentDefs),
		effectiveTools,
	);
	const effectiveExtensions = resolveSubagentExtensions(agentDefs);
	const skillLaunchPlan = await buildSkillLaunchPlan(
		effectiveSkills,
		effectiveInjectSkills,
		runtimePaths.effectiveCwd ?? ctx.cwd,
		runtimePaths.effectiveAgentConfigDir,
		effectiveExtensions,
	);
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
	};
}

export function getPreparedModel(
	prepared: PreparedSubagentLaunch,
): string | undefined {
	if (!prepared.effectiveModel) return undefined;
	return prepared.effectiveThinking
		? `${prepared.effectiveModel}:${prepared.effectiveThinking}`
		: prepared.effectiveModel;
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

export function getExtensionLaunchArgs(
	extensionSpecs: string[] | undefined,
	mandatoryExtensionPath: string,
): string[] {
	const args: string[] = [];
	if (extensionSpecs !== undefined) args.push("--no-extensions");
	args.push("-e", mandatoryExtensionPath);
	for (const extension of extensionSpecs ?? []) args.push("-e", extension);
	return args;
}

export function getFlagsLaunchArgs(flags: string | undefined): string[] {
	if (!flags?.trim()) return [];
	return parseCommandWords(flags);
}


export function getPreparedExtensionLaunchArgs(
	prepared: PreparedSubagentLaunch,
	mandatoryExtensionPath: string,
): string[] {
	return getExtensionLaunchArgs(
		prepared.effectiveExtensions,
		mandatoryExtensionPath,
	);
}

export function getPreparedSessionLaunchArgs(
	prepared: Pick<PreparedSubagentLaunch, "agentDefs" | "subagentSessionFile">,
): string[] {
	return resolveSubagentNoSession(prepared.agentDefs)
		? ["--session", prepared.subagentSessionFile, "--no-session"]
		: ["--session", prepared.subagentSessionFile];
}

export function getPersistedPromptLaunchArgs(
	metadata: PersistedSubagentLaunchMetadata | undefined,
): string[] {
	const args: string[] = [];
	if (metadata?.systemPromptMode && metadata.systemPrompt) {
		args.push(
			metadata.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			metadata.systemPrompt,
		);
	}
	if (metadata?.boundarySystemPrompt) {
		args.push("--append-system-prompt", CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT);
	}
	return args;
}

export async function getPersistedSessionParityArgs(
	metadata: PersistedSubagentLaunchMetadata | undefined,
): Promise<string[]> {
	const args: string[] = [];
	if (!metadata) return args;
	if (metadata.modelRef) args.push("--model", metadata.modelRef);
	if (metadata.noContextFiles) args.push("--no-context-files");
	args.push(
		...getSubagentToolLaunchArgs(metadata.tools, new Set(metadata.denyTools)),
	);
	args.push(
		...(await buildSkillLaunchPlan(
			metadata.skills,
			undefined,
			metadata.cwd,
			metadata.agentConfigDir,
			metadata.extensions,
		)).launchArgs,
	);
	args.push(...getFlagsLaunchArgs(metadata.flags));
	return args;
}

export function cleanupNoSessionSessionFile(
	running: Pick<RunningSubagent, "noSession" | "sessionFile">,
): void {
	if (!running.noSession || !existsSync(running.sessionFile)) return;
	try {
		rmSync(running.sessionFile, { force: true });
	} catch {}
}

export function getPreparedRoleBlock(prepared: PreparedSubagentLaunch): string {
	return prepared.identity && !prepared.identityInSystemPrompt
		? `\n\n${prepared.identity}`
		: "";
}

export function buildPersistedSubagentLaunchMetadata(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	mode: ResumeMode,
	sessionMode: SubagentSessionMode,
	boundarySystemPrompt: boolean,
	systemPrompt?: string,
): PersistedSubagentLaunchMetadata {
	const allowModelOverride = prepared.agentDefs?.allowModelOverride !== false;
	const modelSource = params.model || params.thinking
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
		...(prepared.agentAutoExit !== undefined
			? { autoExit: prepared.agentAutoExit }
			: {}),
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		async: params.async !== false,
		...(prepared.effectiveModel ? { model: prepared.effectiveModel } : {}),
		...(prepared.effectiveThinking
			? { thinking: prepared.effectiveThinking }
			: {}),
		...(prepared.effectiveModelRef
			? { modelRef: prepared.effectiveModelRef }
			: {}),
		...(prepared.agentDefs?.model ? { definitionModel: prepared.agentDefs.model } : {}),
		...(prepared.agentDefs?.thinking ? { definitionThinking: prepared.agentDefs.thinking } : {}),
		allowModelOverride,
		...(modelSource ? { modelSource } : {}),
		...(params.model ? { requestedModelOverride: params.model } : {}),
		...(params.thinking ? { requestedThinkingOverride: params.thinking } : {}),
		...(prepared.effectiveTools ? { tools: prepared.effectiveTools } : {}),
		...(prepared.effectiveSkills ? { skills: prepared.effectiveSkills } : {}),
		...(prepared.effectiveInjectSkills
			? { injectSkills: prepared.effectiveInjectSkills }
			: {}),
		denyTools: [...prepared.denySet],
		...(prepared.effectiveExtensions !== undefined
			? { extensions: prepared.effectiveExtensions }
			: {}),
		noContextFiles: resolveSubagentNoContextFiles(prepared.agentDefs),
		noSession: resolveSubagentNoSession(prepared.agentDefs),
		agentConfigDir: prepared.runtimePaths.effectiveAgentConfigDir,
		cwd: prepared.runtimePaths.targetCwdForSession,
		...(prepared.agentDefs?.systemPromptMode
			? { systemPromptMode: prepared.agentDefs.systemPromptMode }
			: {}),
		...(systemPrompt ? { systemPrompt } : {}),
		boundarySystemPrompt,

		...(prepared.agentDefs?.flags ? { flags: prepared.agentDefs.flags } : {}),
		...(prepared.agentDefs?.env ? { env: prepared.agentDefs.env } : {}),
	};
}

export function getBaseSubagentEnvVars(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	resolveEffectiveSessionMode: (
		params: SubagentParamsInput,
		agentDefs: AgentDefaults | null,
	) => SubagentSessionMode,
): Record<string, string> {
	const envVars: Record<string, string> = { PI_PACKAGE_DIR: "" };
	// Merge user-configured env vars from frontmatter first,
	// so internal PI vars below can override them if needed.
	if (prepared.agentDefs?.env) {
		Object.assign(envVars, parseEnvString(prepared.agentDefs.env));
	}
	if (prepared.runtimePaths.localAgentConfigDir) {
		envVars.PI_CODING_AGENT_DIR = prepared.runtimePaths.localAgentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		envVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	if (prepared.denySet.size > 0)
		envVars.PI_DENY_TOOLS = [...prepared.denySet].join(",");
	if (prepared.effectiveExtensions !== undefined) {
		envVars.PI_SUBAGENT_EXTENSIONS = prepared.effectiveExtensions.join(",");
	}
	envVars.PI_SUBAGENT_NAME = params.name;
	if (params.agent) envVars.PI_SUBAGENT_AGENT = params.agent;
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	if (sessionMode !== "standalone")
		if (prepared.sessionFile) envVars.PI_SUBAGENT_PARENT_SESSION = prepared.sessionFile;
	if (prepared.sessionTitle) envVars.PI_SUBAGENT_SESSION_TITLE = prepared.sessionTitle;

	envVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
	return envVars;
}
