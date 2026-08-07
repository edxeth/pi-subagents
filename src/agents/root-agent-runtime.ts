import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "./definitions.ts";
import {
	getAgentConfigDir,
	loadAgentDefaults,
} from "./definitions.ts";
import {
	ROOT_AGENT_FLAG,
	buildRootSystemPrompt,
	getRootAgentDiagnostic,
	resolveRootAgentName,
	resolveRootModel,
	resolveRootToolNames,
} from "./root-agent.ts";
import { buildSkillLaunchPlan, formatInjectedSkills } from "../launch/skills.ts";
import { resolveSubagentCwd } from "../launch/runtime-paths.ts";

export type RootAgentRuntime = {
	name: string;
	definition: AgentDefaults;
	injectedSkills?: string;
};

function getRootAgentCliValue(pi: ExtensionAPI): string | boolean | undefined {
	try {
		return typeof pi.getFlag === "function" ? pi.getFlag(ROOT_AGENT_FLAG) : undefined;
	} catch {
		return undefined;
	}
}

export function getRequestedRootAgentName(
	pi: ExtensionAPI,
): string | undefined {
	return resolveRootAgentName(getRootAgentCliValue(pi));
}

function notifyRootAgent(
	ctx: ExtensionContext,
	message: string,
	type: "warning" | "error" = "warning",
): void {
	if (typeof ctx.ui?.notify === "function") ctx.ui.notify(message, type);
}

function getCurrentModelRef(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

export async function prepareRootAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	name: string,
): Promise<RootAgentRuntime | null> {
	const definition = loadAgentDefaults(
		name,
		undefined,
		ctx.cwd,
		resolveSubagentCwd,
		pi.events,
	);
	if (!definition) {
		notifyRootAgent(
			ctx,
			getRootAgentDiagnostic(name, `${getAgentConfigDir()}/agents`),
		);
		return null;
	}

	let injectedSkills: string | undefined;
	if (definition.injectSkills?.trim()) {
		try {
			const skillPlan = await buildSkillLaunchPlan(
				definition.skills,
				definition.injectSkills,
				ctx.cwd,
				definition.cwdBase,
			);
			injectedSkills = formatInjectedSkills(
				skillPlan.injectSkills,
				ctx.cwd,
				skillPlan.betterSkillsActive,
			);
		} catch (error) {
			notifyRootAgent(
				ctx,
				`Root agent ${JSON.stringify(name)} skills were not injected: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { name, definition, injectedSkills };
}

export async function applyRootAgentPolicy(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RootAgentRuntime | null,
	orchestratorMode: boolean,
): Promise<void> {
	if (!runtime || orchestratorMode) return;
	const { definition } = runtime;

	if (definition.model) {
		const resolved = resolveRootModel(
			definition,
			ctx.modelRegistry,
			getCurrentModelRef(ctx),
		);
		if (resolved && typeof pi.setModel === "function") {
			try {
				if (!(await pi.setModel(resolved.model))) {
					notifyRootAgent(
						ctx,
						`Root agent ${JSON.stringify(runtime.name)} could not activate model ${JSON.stringify(resolved.modelRef)}; keeping Pi's current model.`,
					);
				}
			} catch (error) {
				notifyRootAgent(
					ctx,
					`Root agent ${JSON.stringify(runtime.name)} model selection failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else {
			notifyRootAgent(
				ctx,
				`Root agent ${JSON.stringify(runtime.name)} requested unavailable model ${JSON.stringify(definition.model)}; keeping Pi's current model.`,
			);
		}
	}
	if (definition.thinking && typeof pi.setThinkingLevel === "function") {
		try {
			pi.setThinkingLevel(definition.thinking as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
		} catch (error) {
			notifyRootAgent(
				ctx,
				`Root agent ${JSON.stringify(runtime.name)} thinking selection failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (typeof pi.getAllTools === "function" && typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
		const toolNames = resolveRootToolNames(
			pi.getAllTools().map((tool) => tool.name),
			pi.getActiveTools(),
			definition,
		);
		pi.setActiveTools(toolNames);
	}
}

export function buildRootPrompt(
	event: { systemPrompt: string; systemPromptOptions?: { appendSystemPrompt?: string } },
	runtime: RootAgentRuntime,
): string {
	return buildRootSystemPrompt(
		event.systemPrompt,
		event.systemPromptOptions?.appendSystemPrompt,
		runtime.definition,
		runtime.injectedSkills,
	);
}
