import type { AgentDefaults } from "../agents/definitions.ts";
import {
	SPAWNING_TOOL_NAMES,
	SUBAGENT_PROTOCOL_TOOL_NAMES,
} from "./tool-names.ts";

const BUILTIN_TOOL_NAMES = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning` defaults to false; only `spawning: true` allows spawning tools.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
	const denied = new Set<string>();
	if (!agentDefs) return denied;

	// spawning defaults to false → deny all spawning tools unless explicitly enabled
	if (agentDefs.spawning !== true) {
		for (const t of SPAWNING_TOOL_NAMES) denied.add(t);
	}

	// deny-tools: explicit list
	if (agentDefs.denyTools) {
		for (const t of agentDefs.denyTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			denied.add(t);
		}
	}

	return denied;
}

export function getSubagentToolsConfigError(tools?: string, agent?: string) {
	const invalid = getInvalidSubagentToolNames(tools);
	if (invalid.length === 0) return null;
	const allowed = ["all", "none", ...BUILTIN_TOOL_NAMES].join(", ");
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Error: invalid tools value${agent ? ` for agent "${agent}"` : ""}: ${invalid.join(", ")}. ` +
					`Use all, none, or a comma-separated list of built-in tools: ${allowed}.`,
			},
		],
		details: {
			error: "invalid_tools",
			invalid,
			allowed: ["all", "none", ...BUILTIN_TOOL_NAMES],
		},
	};
}

function parseToolNames(tools: string): string[] {
	return tools
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

function normalizeToolMode(
	tools?: string,
): "default" | "all" | "none" | "list" {
	if (!tools) return "default";
	const normalized = tools.trim().toLowerCase();
	if (normalized === "all") return "all";
	if (normalized === "none") return "none";
	return "list";
}

function getInvalidSubagentToolNames(tools?: string): string[] {
	if (normalizeToolMode(tools) !== "list" || !tools) return [];
	return parseToolNames(tools).filter((tool) => !BUILTIN_TOOL_NAMES.has(tool));
}

export function getSubagentToolAllowlist(
	tools?: string,
	deniedTools = new Set<string>(),
): string[] {
	if (normalizeToolMode(tools) !== "list" || !tools) return [];
	const allowlist = parseToolNames(tools).filter((tool) =>
		BUILTIN_TOOL_NAMES.has(tool),
	);
	if (allowlist.length === 0) return [];
	for (const tool of SUBAGENT_PROTOCOL_TOOL_NAMES) {
		if (!deniedTools.has(tool)) allowlist.push(tool);
	}
	return [...new Set(allowlist)];
}

export function addToolModeDeniedNames(
	deniedTools: Set<string>,
	tools?: string,
) {
	if (normalizeToolMode(tools) !== "none") return deniedTools;
	for (const tool of BUILTIN_TOOL_NAMES) deniedTools.add(tool);
	return deniedTools;
}

export function getSubagentToolLaunchArgs(
	tools?: string,
	deniedTools = new Set<string>(),
): string[] {
	const args: string[] = [];
	if (normalizeToolMode(tools) === "none") {
		args.push("--no-builtin-tools");
	} else {
		const allowlist = getSubagentToolAllowlist(tools, deniedTools);
		if (allowlist.length > 0) args.push("--tools", allowlist.join(","));
	}
	if (deniedTools.size > 0) args.push("--exclude-tools", [...deniedTools].join(","));
	return args;
}
