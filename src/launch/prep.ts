import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
} from "./policy.ts";
import type { ResumeMode } from "./resume.ts";
import { resolveSubagentCwd, type ResolvedSubagentRuntimePaths } from "./runtime-paths.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import {
	buildIdentityBlock,
	type PersistedSubagentLaunchMetadata,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import { buildSkillLaunchPlan, formatInjectedSkills, type SkillLaunchPlan } from "./skills.ts";
import {
	buildChildLaunchPlan,
	type ModelRegistryLike,
} from "./child-launch-plan.ts";
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
	const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
	// When there is no parent session file (pi --no-session), standalone
	// no-session children can still launch with a tmpdir fallback.
	// Lineage-tracked children (lineage-only / fork) will fail later in
	// seedSubagentSessionFile with a clear error.
	const parentSessionDir =
		sessionFile !== null ? dirname(sessionFile) : join(tmpdir(), "pi-subagents", "parentless");
	const childLaunchPlan = await buildChildLaunchPlan({
		params,
		agentDefs,
		parentCwd: ctx.cwd,
		parentSessionDir,
		modelRegistry: ctx.modelRegistry,
		parentModelRef: ctx.parentModelRef,
		parentThinking: ctx.parentThinking,
	});
	const {
		effectiveModel,
		effectiveThinking,
		effectiveModelRef,
		runtimePaths,
		subagentSessionFile,
		sessionTitle,
	} = childLaunchPlan;
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
	prepared: Pick<PreparedSubagentLaunch, "agentDefs" | "subagentSessionFile" | "sessionTitle">,
): string[] {
	const args = resolveSubagentNoSession(prepared.agentDefs)
		? ["--session", prepared.subagentSessionFile, "--no-session"]
		: ["--session", prepared.subagentSessionFile];
	if (prepared.sessionTitle) args.push("--name", prepared.sessionTitle);
	return args;
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
	envVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
	return envVars;
}
