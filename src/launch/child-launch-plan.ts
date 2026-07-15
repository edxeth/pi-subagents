import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefaults } from "../agents/definitions.ts";
import { assertModelAllowed } from "../agents/model-refs.ts";
import { buildSubagentSessionTitle } from "../agents/titles.ts";
import {
	generateSubagentSessionFile,
	type ResumeMode,
} from "../session/session-files.ts";
import type { SubagentParamsInput } from "../types.ts";
import {
	addToolModeDeniedNames,
	resolveDenyTools,
} from "../tools/policy.ts";
import {
	resolveSubagentExtensions,
	resolveSubagentNoSession,
} from "./policy.ts";
import {
	resolveSubagentRuntimePaths,
	type ResolvedSubagentRuntimePaths,
} from "./runtime-paths.ts";
import { resolveConfiguredExtensionSources } from "./extensions.ts";
import {
	buildSkillLaunchPlan,
	type SkillLaunchPlan,
} from "./skills.ts";

export interface ModelRegistryLike {
	getAvailable(): Array<{
		provider: string;
		id: string;
		thinkingLevelMap?: Record<string, string | null | undefined>;
	}>;
}

interface ChildCapabilityPlan {
	tools?: string;
	skills?: string;
	injectSkills?: string;
	extensions?: string[];
	denySet: Set<string>;
	skillLaunchPlan: SkillLaunchPlan;
}

export interface ChildLaunchPlan {
	agentDefs: AgentDefaults | null;
	effectiveModel?: string;
	effectiveThinking?: string;
	effectiveModelRef?: string;
	runtimePaths: ResolvedSubagentRuntimePaths;
	subagentSessionFile: string;
	sessionTitle?: string;
	capability: ChildCapabilityPlan;
}

export interface ChildLaunchPlanOptions {
	params: SubagentParamsInput;
	agentDefs: AgentDefaults | null;
	parentCwd: string;
	parentSessionDir: string;
	modelRegistry?: ModelRegistryLike;
	parentModelRef?: string;
	parentThinking?: string;
	mode?: ResumeMode;
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

/**
 * Normalize model and thinking into a safe model ref.
 *
 * Handles two edge cases:
 * 1. When the model string already carries a `:thinking` suffix and an
 *    explicit thinking level is also set, strip the embedded suffix.
 * 2. When no model is available at all, suppress both thinking and modelRef.
 */
export function normalizeModelRef(
	model: string | undefined,
	thinking: string | undefined,
): { effectiveModel: string | undefined; effectiveThinking: string | undefined; effectiveModelRef: string | undefined } {
	if (!model) {
		return { effectiveModel: undefined, effectiveThinking: undefined, effectiveModelRef: undefined };
	}
	let baseModel = model;
	if (thinking) {
		const idx = model.lastIndexOf(":");
		if (idx !== -1) {
			const suffix = model.slice(idx + 1);
			if (THINKING_LEVELS.has(suffix)) baseModel = model.slice(0, idx);
		}
	}
	const ref = thinking ? `${baseModel}:${thinking}` : baseModel;
	return { effectiveModel: baseModel, effectiveThinking: thinking, effectiveModelRef: ref };
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

export async function buildChildLaunchPlan(
	options: ChildLaunchPlanOptions,
): Promise<ChildLaunchPlan> {
	const { params, agentDefs, parentCwd, parentSessionDir } = options;
	const hasAllowedModels = !!agentDefs?.allowedModels?.trim();
	const resolveRef = (
		model: string | undefined,
		fallbackThinking: string | undefined,
		opts: { resolveAlways: boolean; explicitThinking: boolean },
	): { effectiveModel?: string; effectiveThinking?: string; effectiveModelRef?: string } => {
		const split = splitModelRefThinking(model, fallbackThinking);
		const explicit = split.explicitThinking || opts.explicitThinking;
		// Resolve a bare id (no provider) through the registry only when this is a
		// launch override or when this agent opts into allowed-models; otherwise
		// pass it through untouched so agents without the feature keep Pi's native
		// model resolution.
		const shouldResolve = !!split.model && (opts.resolveAlways || (hasAllowedModels && !split.model.includes("/")));
		const available = shouldResolve
			? resolveAvailableModelRef(split.model, split.thinking, explicit, options.modelRegistry, options.parentModelRef)
			: split;
		return normalizeModelRef(available.model, available.thinking);
	};

	const requestedModel = params.model ?? agentDefs?.model ?? options.parentModelRef;
	const { effectiveModel, effectiveThinking, effectiveModelRef } = resolveRef(
		requestedModel,
		params.thinking ?? agentDefs?.thinking ?? options.parentThinking,
		{ resolveAlways: params.model != null, explicitThinking: params.thinking != null },
	);
	if (hasAllowedModels) {
		const defaultModelRef = resolveRef(
			agentDefs?.model ?? options.parentModelRef,
			agentDefs?.thinking ?? options.parentThinking,
			{ resolveAlways: false, explicitThinking: false },
		).effectiveModelRef;
		assertModelAllowed(
			effectiveModelRef,
			agentDefs?.allowedModels,
			params.agent,
			defaultModelRef ? [defaultModelRef] : [],
		);
	}

	const runtimePaths = resolveSubagentRuntimePaths(
		params,
		agentDefs,
		parentCwd,
		parentSessionDir,
	);
	const subagentSessionFile = generateSubagentSessionFile(
		resolveSubagentNoSession(agentDefs)
			? join(tmpdir(), "pi-subagents", "sessions")
			: runtimePaths.sessionDir,
	);
	const tools = params.tools ?? agentDefs?.tools;
	const skills = params.skills ?? agentDefs?.skills;
	const injectSkills = agentDefs?.injectSkills;
	const extensionSources = resolveSubagentExtensions(agentDefs);
	const extensions = resolveConfiguredExtensionSources(extensionSources, {
		cwd: runtimePaths.effectiveCwd ?? parentCwd,
		agentDir: runtimePaths.effectiveAgentConfigDir,
		agentDefs,
		mode: options.mode ?? "background",
	});
	const denySet = addToolModeDeniedNames(resolveDenyTools(agentDefs), tools);
	const skillLaunchPlan = await buildSkillLaunchPlan(
		skills,
		injectSkills,
		runtimePaths.effectiveCwd ?? parentCwd,
		runtimePaths.effectiveAgentConfigDir,
		extensions,
	);

	return {
		agentDefs,
		effectiveModel,
		effectiveThinking,
		effectiveModelRef,
		runtimePaths,
		subagentSessionFile,
		sessionTitle: buildSubagentSessionTitle(params),
		capability: {
			tools,
			skills,
			injectSkills,
			extensions,
			denySet,
			skillLaunchPlan,
		},
	};
}
