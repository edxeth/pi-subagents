import type { AgentDefaults } from "../agents/definitions.ts";
import { getEffectiveAgentDefinitions } from "../agents/definitions.ts";

import {
	CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT,
	buildChildContextBoundary,
	type ChildContextBoundaryOptions,
} from "../launch/context-boundary.ts";
import {
	getPiInvocation,
	getPiShellParts,
	getSubagentChildProcessEnv,
	parseCommandWords,
} from "../launch/child-command.ts";
import { parseEnvString } from "../launch/env.ts";
import {
	buildPersistedSubagentLaunchMetadata,
	getApprovalLaunchArgs,
	getBaseSubagentEnvVars,
	getExtensionLaunchArgs,
	getPersistedApprovalLaunchArgs,
	getPersistedSessionParityArgs,
	getPreparedSessionLaunchArgs,
	resolveAvailableModelRef,
	splitModelRefThinking,
	type PreparedSubagentLaunch,
} from "../launch/prep.ts";
import { resolveResumeLaunchMetadataForInvocation } from "../runtime/resume-service.ts";
import {
	enforceAgentFrontmatter,
	getSubagentAgentOverrideError,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	resolveSubagentExtensions,
	resolveSubagentNoContextFiles,
	resolveSubagentNoSession,
	resolveSubagentReportContextUsage,
} from "../launch/policy.ts";
import {
	getAgentListEntries,
	getAgentListSignature,
	renderAgentListReminder,
	type AgentListEntry,
} from "../agents/agent-list.ts";
import {
	buildResumePiArgs,
	buildShellChangeDirectoryPrefix,
	getResumeCwd,
	resolveResumeLaunchMetadata,
	type ResumeMode,
} from "../launch/resume.ts";
import {
	resolveSubagentRuntimePaths,
} from "../launch/runtime-paths.ts";
import type {
	RunningSubagent,
	SessionEntryLike,
	SubagentParamsInput,
} from "../types.ts";
import {
	getNoSessionSeedMode,
} from "../launch/seed-child-session.ts";
import {
	buildPiPromptArgs,
	readSubagentLaunchMetadata,
	resolveEffectiveSessionMode,
	resolveTaskSessionMode,
	type PersistedSubagentLaunchMetadata,
	type SubagentSessionMode,
	writeSubagentLaunchMetadataEntryWhenReady,
	writeSubagentModelStateEntries,
} from "../session/session-files.ts";
import { ChildSessionStorage } from "../session/child-session-storage.ts";
import {
	writeResumeTaskArtifact,
	writeSystemPromptArtifact,
} from "../launch/prompt-artifacts.ts";
import {
	addToolModeDeniedNames,
	getSubagentToolAllowlist,
	getSubagentToolLaunchArgs,
	getSubagentToolsWarning,
	resolveDenyTools,
} from "../tools/policy.ts";
import { getSubagentNameError, isInitialPromptInvocation, isOneShotPromptInvocation, shouldForceSynchronousLaunch, withToolWarning } from "../tools/subagent-tools.ts";
import {
	buildSubagentSessionTitle,
	getSubagentDisplayTitle,
	getTerminalAssistantSummary,
	shouldReapStableTerminalSummary,
	type SubagentTitleParams,
} from "../agents/titles.ts";

export function resolveDenyToolsForTest(agentDefs: AgentDefaults | null) {
	return resolveDenyTools(agentDefs);
}

export function getEffectiveAgentDefinitionsForTest(baseCwd = process.cwd()) {
	return getEffectiveAgentDefinitions(baseCwd);
}

export function getAgentListEntriesForTest(baseCwd = process.cwd()) {
	return getAgentListEntries(baseCwd, (agentDefs) =>
		resolveTaskSessionMode(agentDefs, resolveSubagentNoSession, getNoSessionSeedMode),
	);
}

export function renderAgentListReminderForTest(
	entries: AgentListEntry[],
) {
	return renderAgentListReminder(entries);
}

export function getAgentListSignatureForTest(
	entries: AgentListEntry[],
) {
	return getAgentListSignature(entries);
}

export function buildChildContextBoundaryForTest(
	options: ChildContextBoundaryOptions,
) {
	return buildChildContextBoundary(options);
}

export function buildChildContextBoundarySystemPromptForTest() {
	return CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT;
}

export function buildSubagentSessionTitleForTest(params: SubagentTitleParams) {
	return buildSubagentSessionTitle(params);
}

export function getSubagentDisplayTitleForTest(
	params: Pick<SubagentParamsInput, "title" | "task">,
) {
	return getSubagentDisplayTitle(params);
}

export function getSubagentNameErrorForTest(name: string | undefined) {
	return getSubagentNameError(name);
}

export function isOneShotPromptInvocationForTest(argv: string[]) {
	return isOneShotPromptInvocation(argv);
}

export function isInitialPromptInvocationForTest(argv: string[]) {
	return isInitialPromptInvocation(argv);
}

export function shouldForceSynchronousLaunchForTest(hasUI: boolean, argv: string[]) {
	return shouldForceSynchronousLaunch(hasUI, argv);
}

export function getTerminalAssistantSummaryForTest(entries: SessionEntryLike[]) {
	return getTerminalAssistantSummary(entries);
}

export function getTerminalAssistantSummaryAfterLaunchForTest(
	entries: SessionEntryLike[],
	launchEntryCount: number,
) {
	return getTerminalAssistantSummary(entries.slice(launchEntryCount));
}

export function shouldReapStableTerminalSummaryForTest(
	running: Pick<RunningSubagent, "autoExit">,
) {
	return shouldReapStableTerminalSummary(running);
}

export function getPiInvocationForTest(args: string[]) {
	return getPiInvocation(args);
}

export function getPiShellPartsForTest(args: string[]) {
	return getPiShellParts(args);
}

export function getSubagentChildProcessEnvForTest(
	invocation: { command: string; args: string[] },
	envVars: Record<string, string>,
) {
	return getSubagentChildProcessEnv(invocation, envVars);
}

export function seedSubagentSessionFileForTest(
	mode: Exclude<SubagentSessionMode, "standalone">,
	parentSessionFile: string,
	childSessionFile: string,
	cwd = process.cwd(),
	seedOptions?: {
		sessionName?: string;
		activeLeafId?: string | null;
	},
) {
	new ChildSessionStorage(childSessionFile).seed(mode, parentSessionFile, cwd, seedOptions);
}

export function resolveTaskSessionModeForTest(agentDefs: AgentDefaults | null) {
	return resolveTaskSessionMode(
		agentDefs,
		resolveSubagentNoSession,
		getNoSessionSeedMode,
	);
}

export async function writeSubagentLaunchMetadataEntryForTest(
	path: string,
	metadata: PersistedSubagentLaunchMetadata,
) {
	await writeSubagentLaunchMetadataEntryWhenReady(path, metadata, 0);
}

export function writeSubagentModelStateEntriesForTest(
	path: string,
	metadata: Pick<PersistedSubagentLaunchMetadata, "model" | "thinking">,
) {
	writeSubagentModelStateEntries(path, metadata);
}

export function readSubagentLaunchMetadataForTest(path: string) {
	return readSubagentLaunchMetadata(path);
}

export function buildPersistedSubagentLaunchMetadataForTest(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	mode: ResumeMode,
	sessionMode: SubagentSessionMode,
	boundarySystemPrompt: boolean,
	systemPrompt?: string,
) {
	return buildPersistedSubagentLaunchMetadata(
		prepared,
		params,
		mode,
		sessionMode,
		boundarySystemPrompt,
		systemPrompt,
	);
}

export function getPersistedSessionParityArgsForTest(
	metadata: PersistedSubagentLaunchMetadata | undefined,
	modeOverride?: ResumeMode,
) {
	return getPersistedSessionParityArgs(metadata, modeOverride);
}

export function resolveResumeLaunchMetadataForInvocationForTest(
	metadata: PersistedSubagentLaunchMetadata | undefined,
	requestedModel: string | undefined,
	modelRegistry?: Parameters<typeof resolveResumeLaunchMetadataForInvocation>[3],
	requestedThinking?: string,
) {
	return resolveResumeLaunchMetadataForInvocation(metadata, requestedModel, requestedThinking, modelRegistry);
}

export function splitModelRefThinkingForTest(
	model: string | undefined,
	fallbackThinking: string | undefined,
) {
	return splitModelRefThinking(model, fallbackThinking);
}

export function resolveAvailableModelRefForTest(
	model: string | undefined,
	thinking: string | undefined,
	explicitThinking: boolean,
	parentModelRef?: string,
) {
	return resolveAvailableModelRef(
		model,
		thinking,
		explicitThinking,
		{
			getAvailable: () => [
				{ provider: "zai-messages", id: "glm-5-turbo", thinkingLevelMap: { high: null } },
				{ provider: "zai-messages", id: "glm-5.1", thinkingLevelMap: { high: "high" } },
				{ provider: "other", id: "glm-5.1", thinkingLevelMap: { high: "high" } },
			],
		},
		parentModelRef,
	);
}

export function resolveEffectiveSessionModeForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return resolveEffectiveSessionMode(params, agentDefs);
}

export function buildPiPromptArgsForTest(
	skills: string[],
	taskArg: string,
	directTask: boolean,
) {
	return buildPiPromptArgs(skills, taskArg, directTask);
}

export function writeSystemPromptArtifactForTest(
	name: string,
	systemPrompt: string,
	ctx: { sessionManager: { getSessionId(): string }; cwd: string },
) {
	return writeSystemPromptArtifact(name, systemPrompt, ctx);
}

export function writeResumeTaskArtifactForTest(
	name: string,
	task: string,
	sessionFile: string,
	cwd: string,
) {
	return writeResumeTaskArtifact(name, task, sessionFile, cwd);
}

export function resolveSubagentRuntimePathsForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
	parentCwd: string,
	parentSessionDir: string,
) {
	return resolveSubagentRuntimePaths(params, agentDefs, parentCwd, parentSessionDir);
}

export function getSubagentAgentRequirementErrorForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return getSubagentAgentRequirementError(params, agentDefs);
}

export function getSubagentToolsWarningForTest(tools?: string) {
	return getSubagentToolsWarning(tools);
}

export function withToolWarningForTest(result: unknown, warningPrefix: string) {
	return withToolWarning(result as never, warningPrefix);
}

export function getSubagentAgentOverrideErrorForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return getSubagentAgentOverrideError(params, agentDefs);
}

export function resolveSubagentBlockingForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return resolveSubagentBlocking(params, agentDefs);
}

export function enforceAgentFrontmatterForTest(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
) {
	return enforceAgentFrontmatter(params, agentDefs);
}

export function resolveSubagentNoContextFilesForTest(
	agentDefs: AgentDefaults | null,
) {
	return resolveSubagentNoContextFiles(agentDefs);
}

export function resolveSubagentNoSessionForTest(agentDefs: AgentDefaults | null) {
	return resolveSubagentNoSession(agentDefs);
}

export function resolveSubagentReportContextUsageForTest(
	agentDefs: AgentDefaults | null,
) {
	return resolveSubagentReportContextUsage(agentDefs);
}

export function resolveSubagentExtensionsForTest(agentDefs: AgentDefaults | null) {
	return resolveSubagentExtensions(agentDefs);
}

export function getSubagentToolAllowlistForTest(
	tools?: string,
	deniedTools: Iterable<string> = [],
) {
	return getSubagentToolAllowlist(tools, new Set(deniedTools));
}

export function getSubagentToolLaunchArgsForTest(
	tools?: string,
	deniedTools: Iterable<string> = [],
) {
	return getSubagentToolLaunchArgs(tools, new Set(deniedTools));
}

export function getSubagentToolDeniedNamesForTest(
	tools?: string,
	deniedTools: Iterable<string> = [],
) {
	return [...addToolModeDeniedNames(new Set(deniedTools), tools)];
}

export function getExtensionLaunchArgsForTest(
	extensionSpecs: string[] | undefined,
	mandatoryExtensionPath: string,
) {
	return getExtensionLaunchArgs(extensionSpecs, mandatoryExtensionPath);
}

export function getFlagsLaunchArgs(flags: string | undefined) {
	if (!flags?.trim()) return [];
	return parseCommandWords(flags);
}

export function getApprovalLaunchArgsForTest(
	agentDefs: Pick<AgentDefaults, "trustProject"> | null | undefined,
	mode: ResumeMode,
) {
	return getApprovalLaunchArgs(agentDefs, mode);
}

export function getPersistedApprovalLaunchArgsForTest(
	metadata: Pick<PersistedSubagentLaunchMetadata, "trustProject"> | undefined,
	mode: ResumeMode,
) {
	return getPersistedApprovalLaunchArgs(metadata, mode);
}

export function parseEnvStringForTest(env: string | undefined) {
	return parseEnvString(env);
}

export function getPreparedSessionLaunchArgsForTest(
	agentDefs: AgentDefaults | null | Pick<PreparedSubagentLaunch, "agentDefs" | "subagentSessionFile" | "sessionTitle">,
) {
	return getPreparedSessionLaunchArgs(
		agentDefs && "subagentSessionFile" in agentDefs
			? agentDefs
			: {
				agentDefs,
				subagentSessionFile: "child.jsonl",
			} as PreparedSubagentLaunch,
	);
}

export function getBaseSubagentEnvVarsForTest(
	agentDefs: AgentDefaults | null,
) {
	return getBaseSubagentEnvVars(
		{
			agentDefs,
			denySet: new Set<string>(),
			runtimePaths: {},
			subagentSessionFile: "child.jsonl",
			sessionFile: "parent.jsonl",
		} as PreparedSubagentLaunch,
		{ agent: "tester", name: "child", title: "Child task", task: "Task" },
		() => "lineage-only",
	);
}

export function getResumeCwdForTest(
	metadata: PersistedSubagentLaunchMetadata | undefined,
) {
	return getResumeCwd(metadata);
}

export function buildShellChangeDirectoryPrefixForTest(cwd: string | undefined) {
	return buildShellChangeDirectoryPrefix(cwd);
}

export function resolveResumeLaunchMetadataForTest(
	sessionFile: string,
	explicitMode?: ResumeMode,
) {
	return resolveResumeLaunchMetadata(sessionFile, explicitMode);
}

export function buildResumePiArgsForTest(
	sessionFile: string,
	mode: ResumeMode = "background",
) {
	return buildResumePiArgs(sessionFile, mode);
}

export function getNoSessionSeedModeForTest(sessionMode: SubagentSessionMode) {
	return getNoSessionSeedMode(sessionMode);
}
