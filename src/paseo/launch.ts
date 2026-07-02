import { parseEnvString } from "../launch/env.ts";
import {
	getPreparedRoleBlock,
	getPreparedSkillInjection,
	prepareSubagentLaunch,
	type PreparedSubagentLaunch,
	type SubagentLaunchContext,
} from "../launch/prep.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentNoSession,
	resolveSubagentParentClosePolicy,
} from "../launch/policy.ts";
import { expandSubagentTask } from "../launch/task-expansion.ts";
import { getSubagentDisplayTitle } from "../agents/titles.ts";
import {
	resolveEffectiveSessionMode,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import type { PaseoBackendResolution } from "../backend/types.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { createPaseoClient, type PaseoCreateAgentOptions } from "./client.ts";

const PASEO_PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface PaseoLaunchRuntime {
	getContextWindow(modelRef: string | undefined): number | undefined;
}

export const PASEO_CREATE_THEN_SEND_PROMPT_REASON =
	"Create Paseo child agents before sending their initial prompt so the parent subagents track can show them while the provider is still loading.";

function buildPaseoInitialMessageId(runId: string): string {
	return `pi-subagents-${runId}-initial`;
}

function isExplicitToolRestriction(tools: string | undefined): boolean {
	if (!tools?.trim()) return false;
	return tools.trim().toLowerCase() !== "all";
}

function getPaseoUnsupportedReasons(
	prepared: PreparedSubagentLaunch,
	sessionMode: SubagentSessionMode,
): string[] {
	const reasons: string[] = [];
	const defs = prepared.agentDefs;
	if (defs?.sessionMode && sessionMode !== "standalone") {
		reasons.push(`session-mode: ${sessionMode}`);
	}
	if (defs?.fork) reasons.push("fork: true");
	if (resolveSubagentNoSession(defs)) reasons.push("no-session: true");
	if (resolveSubagentNoContextFiles(defs)) {
		reasons.push("no-context-files: true");
	}
	if (prepared.effectiveExtensions !== undefined) reasons.push("extensions");
	if (prepared.skillLaunchPlan.availability.mode !== "all") {
		reasons.push(`skills: ${prepared.skillLaunchPlan.availability.mode}`);
	}
	if (isExplicitToolRestriction(defs?.tools)) reasons.push("tools");
	if (defs?.denyTools?.trim()) reasons.push("deny-tools");
	if (defs?.flags?.trim()) reasons.push("flags");
	if (defs?.systemPromptMode === "replace") {
		reasons.push("system-prompt: replace");
	}
	return reasons;
}

function assertPaseoLaunchSupported(
	prepared: PreparedSubagentLaunch,
	sessionMode: SubagentSessionMode,
): void {
	const reasons = getPaseoUnsupportedReasons(prepared, sessionMode);
	if (reasons.length === 0) return;
	throw new Error(
		`The Paseo backend does not support this subagent definition yet (${reasons.join(", ")}). ` +
			"Set PI_SUBAGENT_BACKEND=local to use the existing local pi-subagents launcher for this agent.",
	);
}

function buildPaseoTask(
	params: SubagentParamsInput,
	prepared: PreparedSubagentLaunch,
	expandedTask: string,
): string {
	const roleBlock = getPreparedRoleBlock(prepared);
	const modeHint =
		"You are a Paseo-managed pi-subagents child agent. Complete this task autonomously in this Paseo agent session.";
	const summaryInstruction =
		"When finished, make your final assistant message satisfy the task's requested output format. If the task does not specify an output format, use a concise summary of what you accomplished and any important findings.";
	let fullTask = `${roleBlock}\n\n${modeHint}\n\n${expandedTask}\n\n${summaryInstruction}`;
	const skillInjection = getPreparedSkillInjection(prepared);
	if (skillInjection) fullTask = `${skillInjection}\n\n${fullTask}`;
	return fullTask;
}

function buildPaseoEnv(
	params: SubagentParamsInput,
	prepared: PreparedSubagentLaunch,
	parentAgentId: string,
): Record<string, string> {
	return {
		...parseEnvString(prepared.agentDefs?.env),
		PI_SUBAGENT_BACKEND: "paseo",
		PI_SUBAGENT_NAME: params.name,
		PI_SUBAGENT_PARENT_PASEO_AGENT_ID: parentAgentId,
		...(params.agent ? { PI_SUBAGENT_AGENT: params.agent } : {}),
	};
}

function buildPaseoCreateAgentOptions(input: {
	params: SubagentParamsInput;
	prepared: PreparedSubagentLaunch;
	parentAgentId: string;
	workspaceId?: string;
	cwd: string;
	runId: string;
}): PaseoCreateAgentOptions {
	const { params, prepared, parentAgentId, workspaceId, cwd, runId } = input;
	const config: PaseoCreateAgentOptions["config"] = {
		provider: "pi",
		cwd,
		title: getSubagentDisplayTitle(params),
	};
	if (prepared.effectiveModel) config.model = prepared.effectiveModel;
	if (prepared.effectiveThinking) config.thinkingOptionId = prepared.effectiveThinking;
	if (prepared.identityInSystemPrompt && prepared.identity) {
		config.systemPrompt = prepared.identity;
	}

	return {
		config,
		env: buildPaseoEnv(params, prepared, parentAgentId),
		...(workspaceId ? { workspaceId } : {}),
		labels: {
			[PASEO_PARENT_AGENT_ID_LABEL]: parentAgentId,
			"pi-subagents.id": runId,
			"pi-subagents.name": params.name,
			...(params.agent ? { "pi-subagents.agent": params.agent } : {}),
		},
	};
}

export async function launchPaseoSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: PaseoLaunchRuntime,
	backend: PaseoBackendResolution,
): Promise<RunningSubagent> {
	const parentAgentId = backend.parentAgentId;
	if (!parentAgentId) {
		throw new Error(
			"The Paseo backend requires PASEO_AGENT_ID so the child can be attached to its parent agent.",
		);
	}

	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const prepared = await prepareSubagentLaunch(params, ctx);
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	assertPaseoLaunchSupported(prepared, sessionMode);

	const cwd = prepared.runtimePaths.effectiveCwd ?? ctx.cwd;
	const expandedTask = await expandSubagentTask(params.task, {
		enabled: prepared.agentDefs?.taskExpansion === "shell",
		cwd,
	});
	const initialPrompt = buildPaseoTask(params, prepared, expandedTask);

	const client = await createPaseoClient();
	try {
		const parent = await client.fetchAgent(parentAgentId);
		if (!parent?.agent) {
			throw new Error(`Paseo parent agent ${parentAgentId} was not found.`);
		}
		const workspaceId = parent.agent.workspaceId;
		const child = await client.createAgent(
			buildPaseoCreateAgentOptions({
				params,
				prepared,
				parentAgentId,
				workspaceId,
				cwd,
				runId: id,
			}),
		);
		try {
			await client.sendAgentMessage(child.id, initialPrompt, {
				messageId: buildPaseoInitialMessageId(id),
			});
		} catch (error) {
			await client.cancelAgent(child.id).catch(() => {});
			throw error;
		}

		return {
			id,
			name: params.name,
			task: params.task,
			title: getSubagentDisplayTitle(params),
			agent: params.agent,
			mode: "background",
			backend: "paseo",
			paseoAgentId: child.id,
			paseoWorkspaceId: child.workspaceId ?? workspaceId,
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
			blocking: params.blocking ?? false,
			async: params.async ?? !(params.blocking ?? false),
			autoExit: prepared.agentDefs?.autoExit ?? false,
			noSession: true,
			startTime,
			sessionFile: prepared.subagentSessionFile,
			launchEntryCount: 0,
			modelContextWindow: runtime.getContextWindow(prepared.effectiveModelRef),
			modelRef: prepared.effectiveModelRef,
			activity: "running in Paseo…",
		};
	} finally {
		await client.close().catch(() => {});
	}
}
