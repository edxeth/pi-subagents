import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "./definitions.ts";
import {
	getAgentConfigDir,
	getEffectiveAgentDefinitions,
	loadAgentDefaults,
} from "./definitions.ts";
import {
	ROOT_AGENT_FLAG,
	buildRootSystemPrompt,
	getRootAgentCommandSelection,
	getRootAgentDeferredFields,
	getRootAgentDiagnostic,
	readRootAgentConfig,
	resolveRootAgentSelection,
	setRootAgentCommandSelection,
	resolveRootModel,
	resolveRootToolNames,
	type RootAgentSelection,
} from "./root-agent.ts";
import { buildSkillLaunchPlan, formatInjectedSkills } from "../launch/skills.ts";
import { resolveSubagentCwd } from "../launch/runtime-paths.ts";

export type RootAgentRuntime = {
	name: string;
	definition: AgentDefaults;
	injectedSkills?: string;
	selection?: RootAgentSelection;
};

function getRootAgentCliValue(pi: ExtensionAPI): string | boolean | undefined {
	try {
		return typeof pi.getFlag === "function" ? pi.getFlag(ROOT_AGENT_FLAG) : undefined;
	} catch {
		return undefined;
	}
}

export function getRequestedRootAgentSelection(
	pi: ExtensionAPI,
	baseCwd = process.cwd(),
): RootAgentSelection & { diagnostics: string[] } {
	// Child Pi processes inherit the user/project filesystem. Do not let a
	// parent's persistent mainAgent default silently reconfigure child sessions;
	// child launch behavior remains governed by the existing child plan.
	const isSubagentProcess = Boolean(
		process.env.PI_SUBAGENT_NAME?.trim() ||
		process.env.PI_SUBAGENT_SESSION?.trim() ||
		process.env.PI_SUBAGENT_PARENT_SESSION?.trim(),
	);
	if (isSubagentProcess) return { diagnostics: [] };
	const config = readRootAgentConfig(baseCwd);
	return {
		...resolveRootAgentSelection(
			getRootAgentCliValue(pi),
			process.env.PI_MAIN_AGENT,
			{
				commandValue: getRootAgentCommandSelection(),
				projectValue: config.projectName,
				userValue: config.userName,
			},
		),
		diagnostics: config.diagnostics,
	};
}

export function getRequestedRootAgentName(
	pi: ExtensionAPI,
	baseCwd = process.cwd(),
): string | undefined {
	return getRequestedRootAgentSelection(pi, baseCwd).name;
}

function notifyRootAgent(
	ctx: ExtensionContext,
	message: string,
	type: "info" | "warning" | "error" = "warning",
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
	selection?: RootAgentSelection,
): Promise<RootAgentRuntime | null> {
	const definition = loadAgentDefaults(
		name,
		undefined,
		ctx.cwd,
		resolveSubagentCwd,
		pi.events,
	);
	if (!definition) {
		const configHint = selection?.source === "project-config"
			? `${ctx.cwd}/.pi/subagents.json`
			: selection?.source === "user-config"
			? `${getAgentConfigDir()}/subagents.json`
			: `${getAgentConfigDir()}/agents`;
		notifyRootAgent(
			ctx,
			getRootAgentDiagnostic(name, configHint),
			"warning",
		);
		return null;
	}

	const deferredFields = getRootAgentDeferredFields(definition);
	if (deferredFields.length > 0) {
		notifyRootAgent(
			ctx,
			`Root agent ${JSON.stringify(name)} selected. Child-only fields are deferred for the main session and were not applied: ${deferredFields.join(", ")}.`,
			"warning",
		);
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
				"warning",
			);
		}
	}
	return { name, definition, injectedSkills, selection };
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
						"warning",
					);
				}
			} catch (error) {
				notifyRootAgent(
					ctx,
					`Root agent ${JSON.stringify(runtime.name)} model selection failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		} else {
			notifyRootAgent(
				ctx,
				`Root agent ${JSON.stringify(runtime.name)} requested unavailable model ${JSON.stringify(definition.model)}; keeping Pi's current model.`,
				"warning",
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
				"warning",
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

function sessionHasUserMessage(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		if (!entry || typeof entry !== "object") return false;
		const value = entry as { role?: unknown; message?: { role?: unknown } };
		return value.role === "user" || value.message?.role === "user";
	});
}

/** Initial prompts apply once to an empty fresh root session, never on reload/resume. */
export function shouldSubmitRootInitialPrompt(
	runtime: RootAgentRuntime | null,
	reason: "startup" | "reload" | "new" | "resume" | "fork",
	entries: readonly unknown[],
): boolean {
	return Boolean(
		runtime?.definition.initialPrompt?.trim() &&
		reason !== "reload" &&
		reason !== "resume" &&
		!sessionHasUserMessage(entries),
	);
}

export function registerRootAgentCommand(pi: ExtensionAPI): void {
	if (
		process.env.PI_SUBAGENT_NAME?.trim() ||
		process.env.PI_SUBAGENT_SESSION?.trim() ||
		process.env.PI_SUBAGENT_PARENT_SESSION?.trim()
	) return;
	if (typeof pi.registerCommand !== "function") return;
	try {
		pi.registerCommand("agent", {
			description: "Inspect or select a named root agent for the next root session",
			handler: async (args, ctx) => {
				const requested = args.trim();
				const definitions = getEffectiveAgentDefinitions(ctx.cwd, pi.events);
				if (!requested) {
					const selection = getRequestedRootAgentSelection(pi, ctx.cwd);
					const current = selection.name ? `${selection.name} (${selection.source})` : "none";
					const names = definitions.map((definition) => definition.name);
					const diagnostics = selection.diagnostics.length
						? ` Diagnostics: ${selection.diagnostics.join(" ")}`
						: "";
					notifyRootAgent(
						ctx,
						`Root agent: ${current}. Available: ${names.length > 0 ? names.join(", ") : "none"}.${diagnostics}`,
						"info",
					);
					return;
				}
				const match = definitions.find((definition) => definition.name === requested);
				if (!match) {
					notifyRootAgent(
						ctx,
						getRootAgentDiagnostic(requested, `${getAgentConfigDir()}/agents or ${ctx.cwd}/.pi/agents`),
						"error",
					);
					return;
				}
				const explicitCli = getRootAgentCliValue(pi);
				const explicitEnv = process.env.PI_MAIN_AGENT?.trim();
				if (typeof explicitCli === "string" && explicitCli.trim() || explicitEnv) {
					notifyRootAgent(
						ctx,
						`Cannot override the explicit --agent/PI_MAIN_AGENT selector in this session. ${JSON.stringify(requested)} is valid; remove the explicit selector and restart Pi to use it.`,
						"warning",
					);
					return;
				}
				setRootAgentCommandSelection(match.name);
				notifyRootAgent(
					ctx,
					`Selected root agent ${JSON.stringify(match.name)} for the next root session. The current session is unchanged; start a new session or restart Pi to apply it.`,
					"info",
				);
			},
		});
	} catch {
		// A host-owned /agent command wins. Do not make extension startup fail.
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
