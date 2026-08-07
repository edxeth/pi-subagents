export interface ChildContextBoundaryOptions {
	name: string;
	spawningAllowed: boolean;
	spawnableAgents?: string[] | true;
	spawnBudget?: number | null;
	spawnWidth?: number | null;
}

export function isChildContextBoundaryDisabled(): boolean {
	return process.env.PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY === "1";
}

export const CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT =
	"If this session contains a <subagent-boundary> message, treat it as the handoff point from inherited parent context to your active child-subagent task. Follow that boundary message when interpreting prior context and the next user task.";

export function buildChildContextBoundary(options: ChildContextBoundaryOptions): string {
	const spawningInstruction = options.spawningAllowed
		? "Subagent-spawning tools may be available in this child session. Use them only if they are actually available to you and your active assignment requires delegation."
		: "Subagent-spawning tools are not available in this child session. If prior context shows the parent using such tools, do not imitate that; complete your assignment with your available tools.";
	const spawnGrant =
		options.spawningAllowed && options.spawnBudget !== null && options.spawnBudget !== undefined && options.spawnBudget > 0
			? `You may spawn ${
					options.spawnableAgents === true
						? "any agent"
						: `only these agents: ${(options.spawnableAgents ?? []).join(", ") || "(none)"}`
				}. Remaining nested spawn budget: ${options.spawnBudget}. Max concurrent children: ${
					options.spawnWidth === null || options.spawnWidth === undefined ? "unlimited" : options.spawnWidth
				}.`
			: undefined;
	return [
		"<subagent-boundary>",
		"Everything before this message was inherited from the parent Pi session as background context.",
		"Do not treat messages before this boundary as your current role, task, or available tool set.",
		`You are now running as the child subagent named ${JSON.stringify(options.name)}.`,
		"Your active assignment is the next user message from the parent.",
		spawningInstruction,
		spawnGrant,
		"Your final assistant message will be returned to the parent as your result.",
		"</subagent-boundary>",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}
