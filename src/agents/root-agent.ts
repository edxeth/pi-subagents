import type { AgentDefaults } from "./definitions.ts";
import {
	resolveAvailableModelRef,
	splitModelRefThinking,
} from "../launch/child-launch-plan.ts";
import type { ModelRegistryLike } from "../launch/child-launch-plan.ts";
import type { Model } from "@earendil-works/pi-ai";

export const ROOT_AGENT_FLAG = "agent";
export const ROOT_AGENT_ENV = "PI_MAIN_AGENT";

/**
 * Resolve the named root agent. An explicit CLI flag wins over the environment
 * variable; blank values are treated as unset so `PI_MAIN_AGENT=` is harmless.
 */
export function resolveRootAgentName(
	cliValue: string | boolean | undefined,
	envValue = process.env[ROOT_AGENT_ENV],
): string | undefined {
	const cli = typeof cliValue === "string" ? cliValue.trim() : "";
	if (cli) return cli;
	const env = envValue?.trim();
	return env || undefined;
}

export function parseRootToolNames(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

/**
 * Resolve the active main-session tool names from a named definition.
 *
 * An omitted `tools` field starts from Pi's current tool set, rather than a
 * guessed built-in list. Explicit `all`, `none`, and lists are authoritative.
 * The spawning switch independently removes launch tools when off. When on,
 * it may add launch tools only to an otherwise inherited (omitted) tool set;
 * explicit allowlists remain authoritative.
 */
export function resolveRootToolNames(
	allToolNames: readonly string[],
	currentToolNames: readonly string[],
	agent: Pick<AgentDefaults, "tools" | "denyTools" | "spawning">,
): string[] {
	const all = [...new Set(allToolNames)];
	const current = [...new Set(currentToolNames)];
	const configured = agent.tools?.trim().toLowerCase();
	let active: string[];

	if (!configured) {
		active = current;
	} else if (configured === "all") {
		active = all;
	} else if (configured === "none") {
		active = [];
	} else {
		const known = new Set(all);
		active = parseRootToolNames(agent.tools).filter((tool) => known.has(tool));
	}

	const launchTools = new Set(["subagent", "subagent_resume"]);
	if (agent.spawning !== true) {
		// Spawning is an independent safety switch, including for tools: all or
		// an allowlist that happens to contain a launch tool.
		active = active.filter((tool) => !launchTools.has(tool));
	} else if (!configured) {
		for (const tool of launchTools) {
			if (all.includes(tool) && !active.includes(tool)) active.push(tool);
		}
	}

	const denied = new Set(parseRootToolNames(agent.denyTools));
	return active.filter((tool) => !denied.has(tool));
}

function rootModelRef(
	model: string,
	thinking: string | undefined,
	modelRegistry: ModelRegistryLike | undefined,
	parentModelRef: string | undefined,
): { model: string; thinking?: string; modelRef: string } | null {
	const split = splitModelRefThinking(model, thinking);
	if (!split.model) return null;
	const resolved = resolveAvailableModelRef(
		split.model,
		split.thinking,
		split.explicitThinking,
		modelRegistry,
		parentModelRef,
	);
	if (!resolved.model) return null;
	return {
		model: resolved.model,
		...(resolved.thinking ? { thinking: resolved.thinking } : {}),
		modelRef: resolved.thinking
			? `${resolved.model}:${resolved.thinking}`
			: resolved.model,
	};
}

/**
 * Find a model for the root definition without throwing in test/fake contexts.
 * A real Pi registry resolves provider/model refs; an unavailable model simply
 * leaves the current model in place and lets the caller report a warning.
 */
export function resolveRootModel(
	definition: Pick<AgentDefaults, "model" | "thinking">,
	modelRegistry: ModelRegistryLike | undefined,
	parentModelRef?: string,
): { model: Model<any>; thinking?: string; modelRef: string } | null {
	if (!definition.model || !modelRegistry) return null;
	let resolved: ReturnType<typeof rootModelRef>;
	try {
		resolved = rootModelRef(
			definition.model,
			definition.thinking,
			modelRegistry,
			parentModelRef,
		);
	} catch {
		return null;
	}
	if (!resolved) return null;
	const slash = resolved.model.indexOf("/");
	if (slash === -1) return null;
	const model = modelRegistry.getAvailable().find(
		(candidate) =>
			candidate.provider === resolved.model.slice(0, slash) &&
			candidate.id === resolved.model.slice(slash + 1),
	);
	return model
		? { model: model as Model<any>, thinking: resolved.thinking, modelRef: resolved.modelRef }
		: null;
}

/**
 * Build the main agent's system prompt. Pi's `systemPrompt` already includes
 * the normal prompt and APPEND_SYSTEM content. For `replace`, use the named
 * body as the base but append APPEND_SYSTEM explicitly from the structured
 * system-prompt options so replacement never drops that user configuration.
 */
export function buildRootSystemPrompt(
	baseSystemPrompt: string,
	appendSystemPrompt: string | undefined,
	definition: Pick<AgentDefaults, "body" | "systemPromptMode">,
	injectedSkills?: string,
): string {
	const identity = [definition.body, injectedSkills]
		.map((part) => part?.trim())
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
	const append = appendSystemPrompt?.trim() ?? "";
	if (definition.systemPromptMode === "replace") {
		return [identity || baseSystemPrompt, append]
			.filter(Boolean)
			.join("\n\n");
	}
	return [baseSystemPrompt, identity].filter(Boolean).join("\n\n");
}

export function getRootAgentDiagnostic(
	name: string,
	configHint: string,
): string {
	return `Named root agent ${JSON.stringify(name)} was not found. Continuing with the normal Pi agent. Check ${configHint} or unset ${ROOT_AGENT_ENV}.`;
}