import type { ResolvedAgentDefinition } from "./definitions.ts";
import { getEffectiveAgentDefinitions } from "./definitions.ts";

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentListEntry {
	name: string;
	source: "project" | "global";
	mode?: "interactive" | "background";
	sessionMode: SubagentSessionMode;
	async?: boolean;
	autoExit?: boolean;
	description?: string;
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

export function renderAgentListReminder(
	entries: AgentListEntry[],
): string {
	const agentLines = entries.map((entry) => {
		return [
			`- \`${entry.name}\`: ${entry.description}`,
			`  tool_return: ${getToolReturn(entry)}`,
			`  runs_as: ${getRunsAs(entry)}`,
			`  context: ${getContext(entry)}`,
			`  completion: ${getCompletion(entry)}`,
		].join("\n");
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
		})),
	);
}

/**
 * Renders a clean roster of available sub-agents suitable for inclusion
 * directly in a system prompt. Focused on name + description + key behavioral
 * flags so the main orchestrator agent knows exactly what it can delegate to.
 */
export function renderAgentRosterForSystemPrompt(
	entries: AgentListEntry[],
): string {
	if (entries.length === 0) return "";

	const agentLines = entries.map((entry) => {
		const desc = entry.description?.trim() || "(no description)";
		return [
			"- `" + entry.name + "`: " + desc,
			"  tool_return: " + getToolReturn(entry),
			"  runs_as: " + getRunsAs(entry),
			"  context: " + getContext(entry),
			"  completion: " + getCompletion(entry),
		].join("\n");
	});

	return [
		"You can launch separate helper agents with the subagent tool. Use this roster to choose exact agent names and to understand how each launched agent behaves.",
		"<subagent-roster>",
		agentLines.join("\n\n"),
		"</subagent-roster>",
		"<subagent-rules>",
		"- Agent names are exact values for subagent.agent or children[].agent.",
		"- tool_return=wait_here means the subagent tool call waits until the helper finishes.",
		"- tool_return=later_message means the tool call starts the helper and returns before the work is done; do not invent its findings.",
		"- runs_as=visible_terminal means a human can watch or type into the helper session.",
		"- context=fresh_chat_needs_full_brief means write a self-contained task with objective, files, constraints, and expected output.",
		"- context=copy_of_this_chat means the helper starts from this conversation; give scope, boundary, and expected output without repeating all background.",
		"- completion=exits_automatically means the helper should finish and close itself.",
		"- If the user names an agent that is not listed, say it was not found and stop; do not suggest a different listed agent.",
		"</subagent-rules>",
	].join("\n");
}
