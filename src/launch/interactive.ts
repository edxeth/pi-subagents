import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import {
	getPiShellParts,
} from "./child-command.ts";
import {
	getPreparedExtensionLaunchArgs,
	getPreparedModel,
	getPreparedRoleBlock,
	getPreparedSessionLaunchArgs,
	getPreparedSkillInjection,
	getPreparedSkillLaunchArgs,
	getPreparedSkillList,
	getFlagsLaunchArgs,
	type SubagentLaunchContext,
} from "./prep.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentParentClosePolicy,
} from "./policy.ts";
import {
	createSurface,
	exitStatusVar,
	sendShellCommand,
	shellEscape,
} from "../mux.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import {
	buildPiPromptArgs,
	getDoneSentinelFile,
} from "../session/session-files.ts";
import { coordinateSubagentLaunch } from "./launch-coordinator.ts";
import { writeSystemPromptArtifact, writeTaskArtifact } from "./prompt-artifacts.ts";
import { traceSubagentLaunch } from "./trace.ts";
import {
	getSubagentDisplayTitle,
	isSetTabTitleToolEnabled,
} from "../agents/titles.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import { SET_TAB_TITLE_TOOL_NAME } from "../tools/tool-names.ts";

export interface InteractiveLaunchRuntime {
	getContextWindow(modelRef: string | undefined): number | undefined;
	getShellReadyDelayMs(): number;
	waitForInteractivePrompt(surface: string): Promise<void>;
}

export async function launchInteractiveSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: InteractiveLaunchRuntime,
	options?: { surface?: string },
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const launch = await coordinateSubagentLaunch(params, ctx, { mode: "interactive" });
	const { prepared, sessionMode, noSession, directTask } = launch;
	traceSubagentLaunch("interactive.prepared", {
		id,
		name: params.name,
		agent: params.agent,
		sessionMode,
		sessionFile: prepared.subagentSessionFile,
		cwd: prepared.runtimePaths.effectiveCwd,
		model: prepared.effectiveModelRef,
		skills: prepared.effectiveSkills,
		injectSkills: prepared.effectiveInjectSkills,
	});
	const surfacePreCreated = !!options?.surface;
	const surface = options?.surface ?? createSurface(params.name);
	traceSubagentLaunch("interactive.surface", {
		id,
		name: params.name,
		surface,
		surfacePreCreated,
	});
	const doneSentinelFile = getDoneSentinelFile(prepared.subagentSessionFile, id);
	if (!surfacePreCreated) {
		await new Promise<void>((resolve) =>
			setTimeout(resolve, runtime.getShellReadyDelayMs()),
		);
		await runtime.waitForInteractivePrompt(surface);
	}
	const modeHint = prepared.agentDefs?.autoExit
		? "Complete your task autonomously."
		: "Manual lifecycle: the operator must close this foreground pane when done. Stay in this pane and wait for the operator to interact with you. Do not exit on your own. The operator can interact with you at any time.";
	const summaryInstruction = prepared.agentDefs?.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "After writing your response, stay in this pane for operator interaction. Do not exit. The operator will close the pane when finished.";
	const agentType = params.agent ?? params.name;
	const tabTitleInstruction =
		!isSetTabTitleToolEnabled() || prepared.denySet.has(SET_TAB_TITLE_TOOL_NAME)
			? ""
			: `As your FIRST action, set the tab title using set_tab_title. ` +
			`The title MUST start with [${agentType}] followed by a short description of your current task. ` +
			`Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
	const roleBlock = getPreparedRoleBlock(prepared);
	let fullTask = directTask
		? params.task
		: `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}\n\n${summaryInstruction}`;
	const skillInjection = getPreparedSkillInjection(prepared);
	if (skillInjection) fullTask = `${skillInjection}\n\n${fullTask}`;

	const parts = getPiShellParts(getPreparedSessionLaunchArgs(prepared));
	const subagentDonePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "tools", "subagent-done.ts");
	for (const arg of getPreparedExtensionLaunchArgs(prepared, subagentDonePath)) {
		parts.push(shellEscape(arg));
	}

	const model = getPreparedModel(prepared);
	if (model) parts.push("--model", shellEscape(model));
	if (resolveSubagentNoContextFiles(prepared.agentDefs)) {
		parts.push("--no-context-files");
	}

	if (launch.systemPrompt) {
		const systemPromptPath = writeSystemPromptArtifact(params.name, launch.systemPrompt.text, ctx);
		parts.push(launch.systemPrompt.flag, shellEscape(systemPromptPath));
	}
	if (launch.boundarySystemPrompt) {
		parts.push("--append-system-prompt", shellEscape(CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT));
	}
	for (const arg of getSubagentToolLaunchArgs(prepared.effectiveTools, prepared.denySet)) {
		parts.push(shellEscape(arg));
	}
	for (const arg of getPreparedSkillLaunchArgs(prepared)) {
		parts.push(shellEscape(arg));
	}
	for (const flag of getFlagsLaunchArgs(prepared.agentDefs?.flags)) {
		parts.push(shellEscape(flag));
	}

	const envVars = { ...launch.envVars, PI_SUBAGENT_SURFACE: surface };
	const envPrefix = `${Object.entries(envVars)
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ")} `;

	const taskArg = `@${writeTaskArtifact(params.name, fullTask, ctx)}`;
	const promptArgs = buildPiPromptArgs(
		getPreparedSkillList(prepared),
		taskArg,
		directTask,
	);
	traceSubagentLaunch("interactive.promptArgs", {
		id,
		name: params.name,
		directTask,
		taskArg,
		promptArgs,
	});
	for (const promptArg of promptArgs) parts.push(shellEscape(promptArg));

	const cdPrefix = prepared.runtimePaths.effectiveCwd
		? `cd ${shellEscape(prepared.runtimePaths.effectiveCwd)} && `
		: "";
	const { launchEntryCount } = launch;
	clearSubagentExitSidecar(prepared.subagentSessionFile);
	const sentinelPath = shellEscape(doneSentinelFile);
	const exitVar = exitStatusVar();
	const exitTrap = shellEscape(`printf "__SUBAGENT_DONE_${exitVar}__\\n" | tee ${sentinelPath}`);
	const command = `trap ${exitTrap} EXIT; ${cdPrefix}${envPrefix}${parts.join(" ")}`;
	traceSubagentLaunch("interactive.send", {
		id,
		name: params.name,
		surface,
		sessionFile: prepared.subagentSessionFile,
		doneSentinelFile,
		commandParts: parts,
		envKeys: Object.keys(envVars).sort(),
	});
	sendShellCommand(surface, command);
	return {
		id,
		name: params.name,
		task: params.task,
		title: getSubagentDisplayTitle(params),
		agent: params.agent,
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		blocking: params.blocking ?? false,
		async: params.async ?? !(params.blocking ?? false),
		autoExit: prepared.agentDefs?.autoExit ?? false,
		noSession,
		surface,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		launchEntryCount,
		modelContextWindow: runtime.getContextWindow(prepared.effectiveModelRef),
		doneSentinelFile,
	};
}
