import type { ResolvedAgentDefinition } from "./definitions.ts";
import { getEffectiveAgentDefinitions } from "./definitions.ts";
import { buildModelRef, parseAllowedModels } from "./model-refs.ts";
import { formatTimeoutSeconds } from "../runtime/timeout-budget.ts";
import { resolveVerifierCandidateCount } from "../vf/criteria.ts";
import {
	getContextReminderThresholds,
	parseContextWarnStep,
	parseContextWarnThreshold,
} from "../tools/context-reminders.ts";

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
	spawning: true | string[] | false;
	spawnDepth?: number;
	spawnWidth?: number;
	timeout?: number;
	idleTimeout?: number;
	/** `llm-as-a-verifier` marker: launches fan out to ranked candidates. */
	llmAsVerifier?: boolean;
	/** Explicit `llm-as-a-verifier-candidates` count, when set. */
	llmAsVerifierCandidates?: number;
	contextWarnThreshold?: string;
	contextWarnStep?: string;
	reportContextUsage?: boolean;
	visibleTo: string[];
}

export interface AgentListOptions {
	callerAgent: string | null;
	callerSpawnable: string[] | true;
}

export type ResolveSubagentSessionMode = (agent: ResolvedAgentDefinition) => SubagentSessionMode;

export function getAgentListEntries(
	baseCwd: string,
	resolveSessionMode: ResolveSubagentSessionMode,
	options: AgentListOptions = { callerAgent: null, callerSpawnable: true },
): AgentListEntry[] {
	return getEffectiveAgentDefinitions(baseCwd)
		.filter((agent) => agent.description?.trim())
		.filter(
			(agent) =>
				(options.callerAgent === null ||
					options.callerSpawnable === true ||
					options.callerSpawnable.includes(agent.name)) &&
				(agent.visibleTo?.includes("all") ||
					(options.callerAgent === null
						? agent.visibleTo?.includes("root")
						: options.callerAgent !== "root" && agent.visibleTo?.includes(options.callerAgent))),
		)
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
			spawning: agent.spawning ?? false,
			...(agent.spawnDepth !== undefined ? { spawnDepth: agent.spawnDepth } : {}),
			...(agent.spawnWidth !== undefined ? { spawnWidth: agent.spawnWidth } : {}),
			...(agent.timeout !== undefined ? { timeout: agent.timeout } : {}),
			...(agent.idleTimeout !== undefined ? { idleTimeout: agent.idleTimeout } : {}),
			...(agent.llmAsVerifier !== undefined ? { llmAsVerifier: agent.llmAsVerifier } : {}),
			...(agent.llmAsVerifierCandidates !== undefined
				? { llmAsVerifierCandidates: agent.llmAsVerifierCandidates }
				: {}),
			...(agent.contextWarnThreshold !== undefined ? { contextWarnThreshold: agent.contextWarnThreshold } : {}),
			...(agent.contextWarnStep !== undefined ? { contextWarnStep: agent.contextWarnStep } : {}),
			...(agent.reportContextUsage !== undefined ? { reportContextUsage: agent.reportContextUsage } : {}),
			visibleTo: agent.visibleTo ?? ["all"],
		}));
}

function getToolReturn(entry: AgentListEntry): "wait_here" | "later_message" {
	return entry.async === false ? "wait_here" : "later_message";
}

function getRunsAs(entry: AgentListEntry): "visible_terminal" | "hidden_process" {
	return entry.mode === "background" ? "hidden_process" : "visible_terminal";
}

function getContext(entry: AgentListEntry): "fresh_chat_needs_full_brief" | "copy_of_this_chat" {
	return entry.sessionMode === "fork" ? "copy_of_this_chat" : "fresh_chat_needs_full_brief";
}

function getCompletion(entry: AgentListEntry): "exits_automatically" | "human_or_agent_must_finish" {
	if (entry.autoExit === true) return "exits_automatically";
	if (entry.autoExit === false) return "human_or_agent_must_finish";
	// Undefined `auto-exit` resolves to manual lifecycle at launch: interactive
	// children are told to stay open for the operator and never receive
	// `subagent_done`, so their result only arrives once a human (or
	// subagent_kill) closes the pane. Background children must call
	// `subagent_done` themselves and keep the exits_automatically contract.
	return entry.mode === "background" ? "exits_automatically" : "human_or_agent_must_finish";
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

function renderSpawningLines(entry: AgentListEntry): string[] {
	if (entry.spawning === false || (Array.isArray(entry.spawning) && entry.spawning.length === 0)) return [];
	return [
		`  spawning: ${entry.spawning === true ? "true" : entry.spawning.join(", ")}`,
		...(entry.spawnDepth !== undefined ? [`  spawn-depth: ${entry.spawnDepth}`] : []),
		...(entry.spawnWidth !== undefined ? [`  spawn-width: ${entry.spawnWidth}`] : []),
	];
}

/**
 * The starting percentage of a schedule that reaches the final "stop" stage,
 * or undefined when the policy is off or the schedule collapsed to fewer than
 * three distinct thresholds — a collapsed schedule warns the child but never
 * instructs it to stop, so no parent-facing stop behavior exists.
 */
function getContextWarnPercent(entry: AgentListEntry): number | undefined {
	if (entry.contextWarnThreshold === undefined) return undefined;
	const percent = parseContextWarnThreshold(entry.contextWarnThreshold);
	if (percent === null) return undefined;
	const step = parseContextWarnStep(entry.contextWarnStep);
	return getContextReminderThresholds(percent, step).length === 3 ? percent : undefined;
}

function renderVerifiedFanOutLine(entry: AgentListEntry): string | undefined {
	if (entry.llmAsVerifier !== true) return undefined;
	// Resolved N: explicit field > PI_SUBAGENT_LLM_VERIFIER_CANDIDATES > 3.
	// The roster is advisory, so a bad env value surfaces inline here; the
	// same error fails the actual launch closed at pre-flight.
	try {
		return `  llm-as-a-verifier: true (${resolveVerifierCandidateCount(entry.llmAsVerifierCandidates)} attempts)`;
	} catch (error) {
		return `  llm-as-a-verifier: true (${(error as Error).message})`;
	}
}

function renderLimitLines(entry: AgentListEntry): string[] {
	const contextWarnPercent = getContextWarnPercent(entry);
	return [
		entry.timeout !== undefined ? `  timeout: ${formatTimeoutSeconds(entry.timeout)}` : undefined,
		entry.idleTimeout !== undefined ? `  idle-timeout: ${formatTimeoutSeconds(entry.idleTimeout)}` : undefined,
		contextWarnPercent !== undefined ? `  context-warn: ${contextWarnPercent}%` : undefined,
		entry.reportContextUsage === false ? "  report-context-usage: false" : undefined,
	].filter((line): line is string => line !== undefined);
}

export function renderAgentListReminder(entries: AgentListEntry[]): string {
	const hasModelInfo = entries.some(
		(entry) => buildModelRef(entry.model, entry.thinking) || entry.allowModelOverride !== false,
	);
	const hasIdleTimeout = entries.some((entry) => entry.idleTimeout !== undefined);
	const hasTimeLimits = entries.some((entry) => entry.timeout !== undefined || entry.idleTimeout !== undefined);
	const hasContextWarn = entries.some((entry) => getContextWarnPercent(entry) !== undefined);
	const hasForkedContextWarn = entries.some(
		(entry) => entry.sessionMode === "fork" && getContextWarnPercent(entry) !== undefined,
	);
	const hasHiddenContextReport = entries.some((entry) => entry.reportContextUsage === false);
	const hasVerifiedFanOut = entries.some((entry) => entry.llmAsVerifier === true);
	const agentLines =
		entries.length === 0
			? ["No agents are spawnable in this session."]
			: entries.map((entry) => {
					return [
						`- \`${entry.name}\`: ${entry.description}`,
						`  tool_return: ${getToolReturn(entry)}`,
						`  runs_as: ${getRunsAs(entry)}`,
						`  context: ${getContext(entry)}`,
						`  completion: ${getCompletion(entry)}`,
						renderDefaultModelLine(entry),
						renderModelsLine(entry),
						...renderSpawningLines(entry),
						renderVerifiedFanOutLine(entry),
						...renderLimitLines(entry),
					]
						.filter(Boolean)
						.join("\n");
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
			? [
					"- `default_model:` runs when model/thinking are omitted. `models:` lists accepted overrides; `models: any model ref` accepts any available model. An agent with no `models:` line ignores model and thinking overrides. For a listed ref, copy it exactly and split `provider/model:thinking` into model=`provider/model`, thinking=`thinking`. Never use an unlisted model when an explicit list is present.",
				]
			: []),
		...(hasTimeLimits
			? [
					"- `timeout: X` stops this agent when its whole run reaches X. `idle-timeout: X` stops it when it makes no output for X." +
						(hasIdleTimeout ? " A steer you send is not its output." : "") +
						" A stop is not a failure. The result holds the partial work, or it says that the agent made no output. Read the result text. It tells you what to do next.",
				]
			: []),
		...(hasContextWarn
			? [
					"- `context-warn: Y%` makes this agent wrap up and report before its own context window fills, so its work is not lost to compaction. When a result says the agent stopped early, the stop saved the report. Do not resume an agent that stopped this way. Start a new agent for the unfinished work.",
				]
			: []),
		...(hasForkedContextWarn
			? [
					"- A `copy_of_this_chat` agent with `context-warn` starts with this conversation already using part of its window, so it has less room for its own work.",
				]
			: []),
		...(hasHiddenContextReport
			? [
					"- `report-context-usage: false` hides the token counts in the result. When this agent stops early, the result still reports it.",
				]
			: []),
		...(hasVerifiedFanOut
			? [
					"- `llm-as-a-verifier: true` means one launch runs several independent attempts of the task and an LLM verifier picks the best one; you receive exactly one result. Wait for that result before you launch this agent again. It needs a clean Git tree — the launch fails immediately otherwise.",
				]
			: []),
		"- If the user names an agent that is not listed, say it was not found and stop; do not suggest a different listed agent.",
		"</subagent-rules>",
	].join("\n");
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

export function getAgentListSignature(entries: AgentListEntry[]): string {
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
			spawning: entry.spawning,
			spawnDepth: entry.spawnDepth,
			spawnWidth: entry.spawnWidth,
			timeout: entry.timeout,
			idleTimeout: entry.idleTimeout,
			llmAsVerifier: entry.llmAsVerifier,
			llmAsVerifierCandidates: entry.llmAsVerifierCandidates,
			contextWarn: entry.contextWarnThreshold !== undefined ? getContextWarnPercent(entry) ?? null : undefined,
			reportContextUsage: entry.reportContextUsage,
			visibleTo: entry.visibleTo,
		})),
	);
}
