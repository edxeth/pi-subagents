import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSubagentDisplayTitle } from "../agents/titles.ts";
import { clearSubagentExitSidecar } from "../session/exit-sidecar.ts";
import { buildPiPromptArgs } from "../session/session-files.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { buildAppendSystemInheritancePlan } from "./append-system.ts";
import { getPiInvocation, getSubagentChildProcessEnv } from "./child-command.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
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
import { writeTaskArtifact } from "./prompt-artifacts.ts";
import { expandSubagentTask } from "./task-expansion.ts";

export interface BackgroundLaunchRuntime {
	getContextWindow(modelRef: string | undefined): number | undefined;
}

export async function launchBackgroundSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: BackgroundLaunchRuntime,
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const launch = await coordinateSubagentLaunch(params, ctx, {
		mode: "background",
	});
	const { prepared, noSession, directTask } = launch;
	const subagentDonePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "tools", "subagent-done.ts");
	const roleBlock = getPreparedRoleBlock(prepared);
	const modeHint = prepared.agentDefs?.autoExit
		? "Complete your task autonomously."
		: "Manual lifecycle: do not stop after your final text. After completing the task, you MUST call the subagent_done tool unless you intentionally need the human operator to terminate this session. If operator close is required, say exactly `MANUAL CLOSE REQUIRED:` followed by the reason and wait.";
	const summaryInstruction = prepared.agentDefs?.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message before calling subagent_done, or before asking for manual close, should summarize what you accomplished. After that final message, immediately call subagent_done.";
	const expandedTask = await expandSubagentTask(params.task, {
		enabled: prepared.agentDefs?.taskExpansion === "shell",
		cwd: prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
	});
	let fullTask = directTask ? expandedTask : `${roleBlock}\n\n${modeHint}\n\n${expandedTask}\n\n${summaryInstruction}`;
	const skillInjection = getPreparedSkillInjection(prepared);
	if (skillInjection) fullTask = `${skillInjection}\n\n${fullTask}`;

	const args: string[] = [
		"-p",
		...getPreparedSessionLaunchArgs(prepared),
		...getPreparedExtensionLaunchArgs(prepared, subagentDonePath),
	];
	const model = getPreparedModel(prepared);
	if (model) args.push("--model", model);
	if (resolveSubagentNoContextFiles(prepared.agentDefs)) args.push("--no-context-files");

	const appendSystemPlan = buildAppendSystemInheritancePlan({
		inheritAppendSystem: launch.launchMetadata.inheritAppendSystem === true,
		systemPromptMode: launch.launchMetadata.systemPromptMode,
		systemPrompt: launch.launchMetadata.systemPrompt,
		boundarySystemPrompt: launch.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
	});
	args.push(...appendSystemPlan.promptArgs);
	args.push(...getApprovalLaunchArgs(prepared.agentDefs, "background"));
	args.push(
		...getSubagentToolLaunchArgs(prepared.effectiveTools, prepared.denySet, isPreparedChildSpawningAllowed(prepared)),
	);
	args.push(...getPreparedSkillLaunchArgs(prepared));
	args.push(...getFlagsLaunchArgs(prepared.agentDefs?.flags));

	const taskArg = `@${writeTaskArtifact(params.name, fullTask, ctx)}`;
	for (const promptArg of buildPiPromptArgs(getPreparedSkillList(prepared), taskArg, directTask)) {
		args.push(promptArg);
	}

	const { envVars, launchEntryCount } = launch;
	// The child warns against the parent's clock so its "seconds remaining"
	// matches the deadline the parent will actually enforce.
	if (prepared.agentDefs?.timeout || prepared.agentDefs?.idleTimeout) {
		envVars[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(startTime);
	}
	clearSubagentExitSidecar(prepared.subagentSessionFile);

	const invocation = getPiInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd: prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
		detached: true,
		stdio:
			resolveSubagentParentClosePolicy(prepared.agentDefs) === "continue"
				? ["ignore", "ignore", "ignore"]
				: ["ignore", "pipe", "pipe"],
		env: getSubagentChildProcessEnv(invocation, envVars),
	});
	child.unref();
	const running: RunningSubagent = {
		id,
		name: params.name,
		task: params.task,
		title: getSubagentDisplayTitle(params),
		agent: params.agent,
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		blocking: params.blocking ?? false,
		async: params.async ?? !(params.blocking ?? false),
		autoExit: prepared.agentDefs?.autoExit ?? false,
		noSession,
		reportContextUsage: resolveSubagentReportContextUsage(prepared.agentDefs),
		...resolveSubagentTimeoutState(prepared.agentDefs),
		childProcess: child,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		launchEntryCount,
		modelContextWindow: runtime.getContextWindow(prepared.effectiveModelRef),
		modelRef: prepared.effectiveModelRef,
	};
	const rememberTail = (current: string | undefined, chunk: Buffer | string) =>
		`${current ?? ""}${chunk.toString()}`.slice(-4000);
	child.stdout?.on("data", (chunk) => {
		running.stdoutTail = rememberTail(running.stdoutTail, chunk);
	});
	child.stderr?.on("data", (chunk) => {
		running.stderrTail = rememberTail(running.stderrTail, chunk);
	});
	return running;
}
