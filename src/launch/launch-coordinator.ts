import { existsSync } from "node:fs";
import { getMuxBackend, resolveHerdrPlacementPolicy, resolveZellijPlacementPolicy } from "../mux.ts";
import { ChildSessionStorage } from "../session/child-session-storage.ts";
import { getEntryCount } from "../session/session.ts";
import {
	type PersistedSubagentLaunchMetadata,
	type ResumeMode,
	resolveEffectiveSessionMode,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import type { SubagentParamsInput } from "../types.ts";
import { buildAppendSystemInheritancePlan } from "./append-system.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import { parseEnvString } from "./env.ts";
import { resolveSubagentNoSession } from "./policy.ts";
import {
	buildPersistedSubagentLaunchMetadata,
	getBaseSubagentEnvVars,
	type PreparedSubagentLaunch,
	prepareSubagentLaunch,
	type SubagentLaunchContext,
} from "./prep.ts";
import { getNoSessionSeedMode, seedPreparedSubagentSession } from "./seed-child-session.ts";

interface CoordinatedSystemPrompt {
	flag: "--system-prompt" | "--append-system-prompt";
	text: string;
}

export interface CoordinatedSubagentLaunch {
	prepared: PreparedSubagentLaunch;
	sessionMode: SubagentSessionMode;
	noSession: boolean;
	directTask: boolean;
	seedMode: Exclude<SubagentSessionMode, "standalone"> | null;
	boundarySystemPrompt: boolean;
	systemPrompt?: CoordinatedSystemPrompt;
	launchMetadata: PersistedSubagentLaunchMetadata;
	envVars: Record<string, string>;
	launchEntryCount: number;
}

export async function coordinateSubagentLaunch(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	options: { mode: ResumeMode; systemPrompt?: string },
): Promise<CoordinatedSubagentLaunch> {
	const prepared = await prepareSubagentLaunch(params, ctx, options.mode);
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	const noSession = resolveSubagentNoSession(prepared.agentDefs);
	const noSessionSeedMode = noSession ? getNoSessionSeedMode(sessionMode) : null;
	const directTask = sessionMode === "fork" || noSessionSeedMode === "fork";
	const { seedMode, boundarySystemPrompt } = seedPreparedSubagentSession(prepared, params, ctx, sessionMode, noSession);
	const systemPrompt = getCoordinatedSystemPrompt(prepared);
	const agentEnv = parseEnvString(prepared.agentDefs?.env);
	const herdrPlacementPolicy =
		options.mode === "interactive" && getMuxBackend() === "herdr"
			? resolveHerdrPlacementPolicy(agentEnv.PI_SUBAGENT_HERDR_PLACEMENT ?? process.env.PI_SUBAGENT_HERDR_PLACEMENT)
			: undefined;
	const zellijPlacementPolicy =
		options.mode === "interactive" && process.env.ZELLIJ_PANE_ID
			? resolveZellijPlacementPolicy(agentEnv.PI_SUBAGENT_ZELLIJ_PLACEMENT ?? process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT)
			: undefined;
	const zellijPlacement = zellijPlacementPolicy
		? {
				zellijPlacementPolicy,
				zellijPlacementGroupKey: prepared.sessionFile ?? `session:${ctx.sessionManager.getSessionId()}`,
			}
		: undefined;
	const launchMetadata = buildPersistedSubagentLaunchMetadata(
		prepared,
		params,
		options.mode,
		sessionMode,
		boundarySystemPrompt,
		systemPrompt?.text ?? (prepared.identityInSystemPrompt ? prepared.identity : options.systemPrompt),
		{
			...(herdrPlacementPolicy ? { herdrPlacementPolicy } : {}),
			...zellijPlacement,
		},
	);
	const storage = new ChildSessionStorage(prepared.subagentSessionFile);
	if (existsSync(prepared.subagentSessionFile)) {
		if (seedMode === "fork") storage.writeModelState(launchMetadata);
		await storage.writeLaunchMetadataWhenReady(launchMetadata, 0);
	}
	const envVars = getBaseSubagentEnvVars(prepared, params, resolveEffectiveSessionMode);
	const appendSystemPlan = buildAppendSystemInheritancePlan({
		inheritAppendSystem: launchMetadata.inheritAppendSystem === true,
		systemPromptMode: launchMetadata.systemPromptMode,
		systemPrompt: launchMetadata.systemPrompt,
		boundarySystemPrompt: launchMetadata.boundarySystemPrompt ? CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT : undefined,
	});
	Object.assign(envVars, appendSystemPlan.env);
	envVars.PI_SUBAGENT_AUTO_EXIT = prepared.agentDefs?.autoExit ? "1" : "";
	envVars.PI_SUBAGENT_SESSION = prepared.subagentSessionFile;
	const launchEntryCount = existsSync(prepared.subagentSessionFile) ? getEntryCount(prepared.subagentSessionFile) : 0;

	return {
		prepared,
		sessionMode,
		noSession,
		directTask,
		seedMode,
		boundarySystemPrompt,
		systemPrompt,
		launchMetadata,
		envVars,
		launchEntryCount,
	};
}

function getCoordinatedSystemPrompt(prepared: PreparedSubagentLaunch): CoordinatedSystemPrompt | undefined {
	if (!prepared.identityInSystemPrompt || !prepared.identity) return undefined;
	if (prepared.agentDefs?.systemPromptMode === "append" && prepared.agentDefs.inheritAppendSystem) {
		return undefined;
	}
	return {
		flag: prepared.agentDefs?.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
		text: prepared.identity,
	};
}
