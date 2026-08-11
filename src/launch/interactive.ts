import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSubagentDisplayTitle, isSetTabTitleToolEnabled } from "../agents/titles.ts";
import { createZellijCommandSurface } from "../mux/zellij-placement.ts";
import { getZellijShellCommand, resolveZellijTarget } from "../mux/zellij-runtime.ts";
import { createSurface, getMuxBackend, sendShellCommand, shellEscape } from "../mux.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { buildPiPromptArgs, getDoneSentinelFile } from "../session/session-files.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import { SET_TAB_TITLE_TOOL_NAME } from "../tools/tool-names.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { buildAppendSystemInheritancePlan } from "./append-system.ts";
import { getPiShellParts } from "./child-command.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import { buildInteractiveSentinelShellCommands } from "./interactive-sentinel.ts";
import { coordinateSubagentLaunch } from "./launch-coordinator.ts";
import { PI_SUBAGENT_TIMEOUT_STARTED_AT } from "../tools/timeout-reminders.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentParentClosePolicy,
	resolveSubagentReportContextUsage,
	resolveSubagentTimeoutState,
} from "./policy.ts";
import {
	getApprovalLaunchArgs,
	getFlagsLaunchArgs,
	getPreparedExtensionLaunchArgs,
	getPreparedModel,
	getPreparedRoleBlock,
	getPreparedSessionLaunchArgs,
	getPreparedSkillInjection,
	getPreparedSkillLaunchArgs,
	getPreparedSkillList,
	isPreparedChildSpawningAllowed,
	type SubagentLaunchContext,
} from "./prep.ts";
import { writeSystemPromptArtifact, writeTaskArtifact } from "./prompt-artifacts.ts";
import { expandSubagentTask } from "./task-expansion.ts";
import { traceSubagentLaunch } from "./trace.ts";

export interface InteractiveLaunchRuntime {
	getContextWindow(modelRef: string | undefined): number | undefined;
	getShellReadyDelayMs(): number;
}

export async function launchInteractiveSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: InteractiveLaunchRuntime,
	options?: { surface?: string },
): Promise<RunningSubagent> {
	const id = Math.random().toString(16).slice(2, 10);
	const launch = await coordinateSubagentLaunch(params, ctx, {
		mode: "interactive",
	});
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
	const surfaceName = prepared.sessionTitle ?? params.name;
	const herdrContext = {
		policy: launch.launchMetadata.herdrPlacementPolicy,
	};
	const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
	const zellijContext =
		launch.launchMetadata.zellijPlacementGroupKey && Number.isInteger(parentPaneId)
			? {
					groupKey: launch.launchMetadata.zellijPlacementGroupKey,
					parentPaneId,
					policy: launch.launchMetadata.zellijPlacementPolicy,
				}
			: undefined;
	const doneSentinelFile = getDoneSentinelFile(prepared.subagentSessionFile, id);
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
	const expandedTask = await expandSubagentTask(params.task, {
		enabled: prepared.agentDefs?.taskExpansion === "shell",
		cwd: prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
	});
	let fullTask = directTask
		? expandedTask
		: `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${expandedTask}\n\n${summaryInstruction}`;
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

	const appendSystemPlan = buildAppendSystemInheritancePlan({
		inheritAppendSystem: launch.launchMetadata.inheritAppendSystem === true,
		systemPromptMode: launch.launchMetadata.systemPromptMode,
		systemPrompt: launch.launchMetadata.systemPrompt,
		boundarySystemPrompt: launch.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
	});
	for (let i = 0; i < appendSystemPlan.promptArgs.length; i += 2) {
		const flag = appendSystemPlan.promptArgs[i];
		const text = appendSystemPlan.promptArgs[i + 1] ?? "";
		const value = flag === "--system-prompt" ? writeSystemPromptArtifact(params.name, text, ctx) : text;
		parts.push(flag, shellEscape(value));
	}
	for (const arg of getApprovalLaunchArgs(prepared.agentDefs, "interactive")) {
		parts.push(shellEscape(arg));
	}
	for (const arg of getSubagentToolLaunchArgs(
		prepared.effectiveTools,
		prepared.denySet,
		isPreparedChildSpawningAllowed(prepared),
	)) {
		parts.push(shellEscape(arg));
	}
	for (const arg of getPreparedSkillLaunchArgs(prepared)) {
		parts.push(shellEscape(arg));
	}
	for (const flag of getFlagsLaunchArgs(prepared.agentDefs?.flags)) {
		parts.push(shellEscape(flag));
	}

	const startTime = Date.now();
	const zellijTarget = !surfacePreCreated && getMuxBackend() === "zellij" ? await resolveZellijTarget() : undefined;
	const ordinarySurface = zellijTarget
		? undefined
		: (options?.surface ??
			(await createSurface(surfaceName, {
				herdr: herdrContext,
				zellij: zellijContext,
			})));
	const envVars = {
		...launch.envVars,
		...(zellijTarget ? { ZELLIJ_SESSION_NAME: zellijTarget.sessionName } : {}),
		...(ordinarySurface ? { PI_SUBAGENT_SURFACE: ordinarySurface } : {}),
		// The child receives the parent's clock, not its own: pane startup time
		// belongs to the same deadline the watcher enforces.
		...(prepared.agentDefs?.timeout || prepared.agentDefs?.idleTimeout
			? { [PI_SUBAGENT_TIMEOUT_STARTED_AT]: String(startTime) }
			: {}),
	};
	const envPrefix = `${Object.entries(envVars)
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ")} `;

	const taskArg = `@${writeTaskArtifact(params.name, fullTask, ctx)}`;
	const promptArgs = buildPiPromptArgs(getPreparedSkillList(prepared), taskArg, directTask);
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
	const sentinel = buildInteractiveSentinelShellCommands(doneSentinelFile);
	const surfacePrefix = zellijTarget ? "PI_SUBAGENT_SURFACE=pane:$ZELLIJ_PANE_ID " : "";
	const command = `trap ${shellEscape(sentinel.exitTrap)} EXIT; ${cdPrefix}${envPrefix}${surfacePrefix}${parts.join(" ")}; ${sentinel.direct}`;
	const surface =
		ordinarySurface ??
		(await createZellijCommandSurface(surfaceName, zellijTarget!, getZellijShellCommand(command), zellijContext));
	traceSubagentLaunch("interactive.surface", {
		id,
		name: params.name,
		surface,
		surfacePreCreated,
	});
	if (!surfacePreCreated && !zellijTarget) {
		await new Promise<void>((resolve) => setTimeout(resolve, runtime.getShellReadyDelayMs()));
	}
	traceSubagentLaunch("interactive.send", {
		id,
		name: params.name,
		surface,
		sessionFile: prepared.subagentSessionFile,
		doneSentinelFile,
		commandParts: parts,
		envKeys: Object.keys(envVars).sort(),
	});
	if (!zellijTarget) sendShellCommand(surface, command);
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
		reportContextUsage: resolveSubagentReportContextUsage(prepared.agentDefs),
		...resolveSubagentTimeoutState(prepared.agentDefs),
		surface,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		launchEntryCount,
		modelContextWindow: runtime.getContextWindow(prepared.effectiveModelRef),
		modelRef: prepared.effectiveModelRef,
		launchMetadata: launch.launchMetadata,
		doneSentinelFile,
		zellijTarget,
	};
}
