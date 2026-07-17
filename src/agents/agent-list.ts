import type { ResolvedAgentDefinition } from "./definitions.ts";
import { getEffectiveAgentDefinitions } from "./definitions.ts";
import { buildModelRef, parseAllowedModels } from "./model-refs.ts";

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentListEntry {
	name: string;
	source: "project" | "global";
	mode?: "interactive" | "background";
	sessionMode: SubagentSessionMode;
	async?: boolean;
	autoExit?: boolean;
	description?: string;
	model?: string;
	thinking?: string;
	allowedModels?: string;
	allowModelOverride?: boolean;
}

export type ResolveSubagentSessionMode = (
	agent: ResolvedAgentDefinition,
) => SubagentSessionMode;

export function getAgentListEntries(
	baseCwd: string,
	resolveSessionMode: ResolveSubagentSessionMode,
): AgentListEntry[] {
	return getEffectiveAgentDefinitions(baseCwd)
		.filter((agent) => agent.description?.trim())
		.map((agent) => ({
			name: agent.name,
			source: agent.source,
			mode: agent.mode,
			sessionMode: resolveSessionMode(agent),
			async: agent.async,
			autoExit: agent.autoExit,
			description: agent.description,
			model: agent.model,
			thinking: agent.thinking,
			allowedModels: agent.allowedModels,
			allowModelOverride: agent.allowModelOverride,
		}));
}

function getToolReturn(entry: AgentListEntry): "wait_here" | "later_message" {
	return entry.async === false ? "wait_here" : "later_message";
}

function getRunsAs(entry: AgentListEntry): "visible_terminal" | "hidden_process" {
	return entry.mode === "background" ? "hidden_process" : "visible_terminal";
}

function getContext(
	entry: AgentListEntry,
): "fresh_chat_needs_full_brief" | "copy_of_this_chat" {
	return entry.sessionMode === "fork" ? "copy_of_this_chat" : "fresh_chat_needs_full_brief";
}

function getCompletion(
	entry: AgentListEntry,
): "exits_automatically" | "human_or_agent_must_finish" {
	return entry.autoExit === false ? "human_or_agent_must_finish" : "exits_automatically";
}

function renderDefaultModelLine(entry: AgentListEntry): string | undefined {
	const ref = buildModelRef(entry.model, entry.thinking);
	return ref ? `  default_model: ${ref}` : undefined;
}

function renderModelsLine(entry: AgentListEntry): string | undefined {
	if (entry.allowModelOverride === false) return undefined;
	const allowed = parseAllowedModels(entry.allowedModels);
	if (allowed.length === 0) return "  models: any model ref";
	const defaultModel = buildModelRef(entry.model, entry.thinking);
	const choices = [...new Set([defaultModel, ...allowed].filter((ref): ref is string => !!ref))];
	return `  models: ${choices.join(" | ")}`;
}

export function renderAgentListReminder(
	entries: AgentListEntry[],
): string {
	const hasModelInfo = entries.some((entry) => buildModelRef(entry.model, entry.thinking) || entry.allowModelOverride !== false);
	const agentLines = entries.map((entry) => {
		return [
			`- \`${entry.name}\`: ${entry.description}`,
			`  tool_return: ${getToolReturn(entry)}`,
			`  runs_as: ${getRunsAs(entry)}`,
			`  context: ${getContext(entry)}`,
			`  completion: ${getCompletion(entry)}`,
			renderDefaultModelLine(entry),
			renderModelsLine(entry),
		].filter(Boolean).join("\n");
	});
	const body = [
		"You can launch separate helper agents with the subagent tool. Use this roster to choose exact agent names and to understand how each launched agent behaves.",
		"<subagent-roster>",
		agentLines.join("\n\n"),
		"</subagent-roster>",
		"<subagent-rules>",
		"- Agent names are exact values for subagent.agent or children[].agent.",
		"- tool_return=wait_here means the subagent tool call waits until the helper finishes.",
		"- tool_return=later_message means the tool call starts the helper and returns before the work is done; do not invent its findings.",
		"- runs_as=visible_terminal means a human can watch or type into the helper session. runs_as=hidden_process means no visible terminal is opened.",
		"- context=fresh_chat_needs_full_brief means write a self-contained task with objective, files, constraints, and expected output.",
		"- context=copy_of_this_chat means the helper starts from this conversation; give scope, boundary, and expected output without repeating all background.",
		"- completion=exits_automatically means the helper should finish and close itself. completion=human_or_agent_must_finish means the session stays open until the human or helper explicitly completes it.",
		...(hasModelInfo
			? ["- `default_model:` runs when model/thinking are omitted. `models:` lists accepted overrides; `models: any model ref` accepts any available model. An agent with no `models:` line ignores model and thinking overrides. For a listed ref, copy it exactly and split `provider/model:thinking` into model=`provider/model`, thinking=`thinking`. Never use an unlisted model when an explicit list is present."]
			: []),
		"- If the user names an agent that is not listed, say it was not found and stop; do not suggest a different listed agent.",
		"</subagent-rules>",
	].join("\n");
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

export function getAgentListSignature(
	entries: AgentListEntry[],
): string {
	return JSON.stringify(
		entries.map((entry) => ({
			name: entry.name,
			source: entry.source,
			mode: entry.mode,
			sessionMode: entry.sessionMode,
			async: entry.async,
			autoExit: entry.autoExit,
			description: entry.description,
			model: entry.model,
			thinking: entry.thinking,
			allowedModels: entry.allowedModels,
			allowModelOverride: entry.allowModelOverride,
		})),
	);
}
