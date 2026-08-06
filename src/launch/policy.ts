import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentDefaults } from "../agents/definitions.ts";
import { getAgentConfigDir } from "../agents/definitions.ts";
import type { ParentClosePolicy, SubagentParamsInput } from "../types.ts";

export function getSubagentAgentRequirementError(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	if (!params.agent) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Error: agent is required for subagent launches.",
				},
			],
			details: { error: "agent_required" },
		};
	}
	if (!agentDefs) {
		const globalDir = join(getAgentConfigDir(), "agents");
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: agent "${params.agent}" was not found in .pi/agents/ or ${globalDir}.`,
				},
			],
			details: { error: "agent_not_found", agent: params.agent },
		};
	}
	return null;
}

export function getSubagentAgentOverrideError(
	_params: Partial<SubagentParamsInput>,
	_agentDefs: AgentDefaults | null,
) {
	// Named-agent frontmatter is authoritative by default. Call-time model and
	// thinking overrides are allowed unless the definition opts out with
	// allow-model-override: false; other call-time runtime fields are ignored
	// instead of rejected.
	return null;
}

export function resolveSubagentBlocking(
	_params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): boolean {
	return agentDefs?.async === false;
}

function resolveSubagentAsync(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): boolean {
	return !resolveSubagentBlocking(params, agentDefs);
}

export function resolveSubagentNoContextFiles(
	agentDefs: AgentDefaults | null,
): boolean {
	return agentDefs?.noContextFiles ?? false;
}

export function resolveSubagentNoSession(
	agentDefs: AgentDefaults | null,
): boolean {
	return agentDefs?.noSession ?? false;
}

export function resolveSubagentReportContextUsage(
	agentDefs: AgentDefaults | null,
): boolean {
	return agentDefs?.reportContextUsage ?? true;
}

export function resolveSubagentParentClosePolicy(
	agentDefs: AgentDefaults | null,
): ParentClosePolicy {
	return agentDefs?.parentClosePolicy ?? "terminate";
}

function isSchemeLikePath(value: string): boolean {
	return (
		/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)
	);
}

function resolveSubagentExtensionSource(
	source: string,
	baseDir: string,
): string {
	const trimmed = source.trim();
	if (!trimmed) return trimmed;
	if (isSchemeLikePath(trimmed)) return trimmed;
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	if (trimmed.startsWith("~\\")) return join(homedir(), trimmed.slice(2));
	return resolve(baseDir, trimmed);
}

export function resolveSubagentExtensions(
	agentDefs: AgentDefaults | null,
): string[] | undefined {
	if (!agentDefs?.extensions) return undefined;
	const raw = agentDefs.extensions.trim().toLowerCase();
	if (raw === "all") return undefined;
	if (raw === "none") return [];
	if (raw === "false" || raw === "off" || raw === "[]") {
		throw new Error(
			`Invalid extensions value "${agentDefs.extensions}". Use "all", "none", or a comma-separated extension allowlist.`,
		);
	}
	const baseDir = agentDefs.cwdBase ?? process.cwd();
	const resolved = agentDefs.extensions
		.split(",")
		.map((source) => source.trim())
		.filter(Boolean)
		.map((source) => resolveSubagentExtensionSource(source, baseDir));
	return resolved.length > 0 ? [...new Set(resolved)] : [];
}

export function enforceAgentFrontmatter(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
): SubagentParamsInput {
	return {
		name: params.name,
		task: params.task,
		title: params.title,
		agent: params.agent,
		...(agentDefs?.allowModelOverride !== false && params.model
			? { model: params.model }
			: {}),
		...(agentDefs?.allowModelOverride !== false && params.thinking
			? { thinking: params.thinking }
			: {}),
		async: resolveSubagentAsync(params, agentDefs),
		blocking: resolveSubagentBlocking(params, agentDefs),
	};
}
