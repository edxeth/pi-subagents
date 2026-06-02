import { existsSync } from "node:fs";
import {
	buildPersistedSubagentLaunchMetadata,
	getBaseSubagentEnvVars,
	prepareSubagentLaunch,
	type PreparedSubagentLaunch,
	type SubagentLaunchContext,
} from "./prep.ts";
import { resolveSubagentNoSession } from "./policy.ts";
import { getNoSessionSeedMode, seedPreparedSubagentSession } from "./seed-child-session.ts";
import type { SubagentParamsInput } from "../types.ts";
import {
	resolveEffectiveSessionMode,
	type PersistedSubagentLaunchMetadata,
	type ResumeMode,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import { ChildSessionStorage } from "../session/child-session-storage.ts";
import { getEntryCount } from "../session/session.ts";

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
	const prepared = await prepareSubagentLaunch(params, ctx);
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	const noSession = resolveSubagentNoSession(prepared.agentDefs);
	const noSessionSeedMode = noSession ? getNoSessionSeedMode(sessionMode) : null;
	const directTask = sessionMode === "fork" || noSessionSeedMode === "fork";
	const { seedMode, boundarySystemPrompt } = seedPreparedSubagentSession(
		prepared,
		params,
		ctx,
		sessionMode,
		noSession,
	);
	const systemPrompt = getCoordinatedSystemPrompt(prepared);
	const launchMetadata = buildPersistedSubagentLaunchMetadata(
		prepared,
		params,
		options.mode,
		sessionMode,
		boundarySystemPrompt,
		systemPrompt?.text ?? options.systemPrompt,
	);
	const storage = new ChildSessionStorage(prepared.subagentSessionFile);
	if (existsSync(prepared.subagentSessionFile)) {
		if (seedMode === "fork") storage.writeModelState(launchMetadata);
		await storage.writeLaunchMetadataWhenReady(launchMetadata, 0);
	}
	const envVars = getBaseSubagentEnvVars(prepared, params, resolveEffectiveSessionMode);
	if (prepared.agentDefs?.autoExit) envVars.PI_SUBAGENT_AUTO_EXIT = "1";
	envVars.PI_SUBAGENT_SESSION = prepared.subagentSessionFile;
	const launchEntryCount = existsSync(prepared.subagentSessionFile)
		? getEntryCount(prepared.subagentSessionFile)
		: 0;

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

function getCoordinatedSystemPrompt(
	prepared: PreparedSubagentLaunch,
): CoordinatedSystemPrompt | undefined {
	if (!prepared.identityInSystemPrompt || !prepared.identity) return undefined;
	return {
		flag: prepared.agentDefs?.systemPromptMode === "replace"
			? "--system-prompt"
			: "--append-system-prompt",
		text: prepared.identity,
	};
}
