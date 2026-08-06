import type { AgentDefaults } from "../agents/definitions.ts";
import { resolveSubagentBlocking } from "../launch/policy.ts";
import {
	PI_SUBAGENTS_INTERNAL_TOOL_NAMES,
	SUBAGENT_LAUNCH_TOOL_NAMES,
	SUBAGENT_RESUME_TOOL_NAME,
	SUBAGENT_TOOL_NAME,
} from "../tools/tool-names.ts";
import type { SubagentParamsInput } from "../types.ts";
import { markSubagentBatchBlocking } from "./state.ts";

type ToolCallLike = {
	type: "toolCall";
	name: string;
	arguments: Record<string, unknown>;
};

type AssistantMessageLike = {
	role?: string;
	content?: unknown;
};

type AgentDefaultsLoader = (agent: string | undefined, cwd: string | undefined) => AgentDefaults | null;

function isCoordinatorOnlyTurnDisabled(): boolean {
	return process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN === "1";
}

function getToolCalls(message: AssistantMessageLike): ToolCallLike[] {
	if (!message || message.role !== "assistant") return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is ToolCallLike =>
			!!part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "toolCall" &&
			typeof (part as { name?: unknown }).name === "string",
	);
}

type SubagentChildLike = {
	agent?: unknown;
	cwd?: unknown;
	async?: unknown;
	blocking?: unknown;
};

/**
 * Mirror getRequestedChildren in src/tools/subagent-tools.ts: when a
 * `children: [...]` array is provided, treat each entry as a separate
 * launch; otherwise the top-level params are the single launch.
 */
function getRequestedSubagentChildren(args: Record<string, unknown>): SubagentChildLike[] {
	const children = args.children;
	if (Array.isArray(children) && children.length > 0) {
		return children.filter((c): c is SubagentChildLike => !!c && typeof c === "object");
	}
	return [args as SubagentChildLike];
}

function isAsyncSubagentChildLaunch(child: SubagentChildLike, loadAgentDefaults: AgentDefaultsLoader): boolean {
	const agent = typeof child.agent === "string" ? child.agent : undefined;
	const cwd = typeof child.cwd === "string" ? child.cwd : undefined;
	const agentDefs = agent ? loadAgentDefaults(agent, cwd) : null;
	// Unknown/missing agent: not a valid launch; existing tool_call validation
	// will surface the error. Don't classify it as a launch for our purposes.
	if (!agentDefs) return false;
	return !resolveSubagentBlocking(child as Partial<SubagentParamsInput>, agentDefs);
}

function isAsyncSubagentLaunch(call: ToolCallLike, loadAgentDefaults: AgentDefaultsLoader): boolean {
	if (call.name === SUBAGENT_TOOL_NAME) {
		// A `subagent` call is async-launching if ANY of its children
		// (or its single top-level launch) resolves async. One async child
		// in the batch is enough to create the race the barrier prevents.
		const args = call.arguments ?? {};
		const children = getRequestedSubagentChildren(args);
		for (const child of children) {
			if (isAsyncSubagentChildLaunch(child, loadAgentDefaults)) return true;
		}
		return false;
	}
	if (call.name === SUBAGENT_RESUME_TOOL_NAME) {
		const input = call.arguments as { async?: unknown };
		// Resume defaults to async unless caller passed async: false.
		return input?.async !== false;
	}
	return false;
}

/**
 * Inspect an assistant message's tool batch and, when it contains both an
 * async subagent launch (subagent or subagent_resume) AND a non-subagent tool,
 * mark the current subagent batch blocking so the existing await path in
 * running-registry/resume-tool returns a completed result instead of a started
 * one. This sidesteps Pi's `every()` batch-termination contract for mixed
 * batches without forging `terminate` on built-in tool results.
 *
 * No-op when PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1, matching the kill-
 * switch for the existing coordinator-only-turn behavior.
 */
export function classifyAssistantMessageForMixedBatch(
	message: AssistantMessageLike,
	loadAgentDefaults: AgentDefaultsLoader,
): void {
	if (isCoordinatorOnlyTurnDisabled()) return;
	const calls = getToolCalls(message);
	if (calls.length < 2) return;

	let hasAsyncLaunch = false;
	let hasNonSubagentSibling = false;
	for (const call of calls) {
		if (SUBAGENT_LAUNCH_TOOL_NAMES.has(call.name)) {
			if (!hasAsyncLaunch && isAsyncSubagentLaunch(call, loadAgentDefaults)) {
				hasAsyncLaunch = true;
			}
		} else if (!PI_SUBAGENTS_INTERNAL_TOOL_NAMES.has(call.name)) {
			hasNonSubagentSibling = true;
		}
		if (hasAsyncLaunch && hasNonSubagentSibling) break;
	}

	if (hasAsyncLaunch && hasNonSubagentSibling) {
		markSubagentBatchBlocking();
	}
}
