import { buildChildContextBoundary, isChildContextBoundaryDisabled } from "./context-boundary.ts";
import type { SubagentLaunchContext, PreparedSubagentLaunch } from "./prep.ts";
import type { SubagentParamsInput } from "../types.ts";
import {
	seedSubagentSessionFile,
	type SubagentSessionMode,
	writeChildContextBoundaryEntry,
	writeSubagentExtensionEntry,
} from "../session/session-files.ts";

export function getNoSessionSeedMode(
	sessionMode: SubagentSessionMode,
): Exclude<SubagentSessionMode, "standalone"> | null {
	if (sessionMode === "standalone") return null;
	return "fork";
}

function getChildSeedMode(
	sessionMode: SubagentSessionMode,
	noSession: boolean,
): Exclude<SubagentSessionMode, "standalone"> | null {
	if (noSession) return getNoSessionSeedMode(sessionMode);
	return sessionMode === "standalone" ? null : sessionMode;
}

function shouldWriteChildContextBoundary(
	seedMode: Exclude<SubagentSessionMode, "standalone"> | null,
): boolean {
	return seedMode === "fork" && !isChildContextBoundaryDisabled();
}

export function seedPreparedSubagentSession(
	prepared: PreparedSubagentLaunch,
	params: Pick<SubagentParamsInput, "name">,
	ctx: Pick<SubagentLaunchContext, "cwd" | "sessionManager">,
	sessionMode: SubagentSessionMode,
	noSession: boolean,
): {
	seedMode: Exclude<SubagentSessionMode, "standalone"> | null;
	boundarySystemPrompt: boolean;
} {
	const seedMode = getChildSeedMode(sessionMode, noSession);
	const boundarySystemPrompt = shouldWriteChildContextBoundary(seedMode);
	if (seedMode) {
		if (!prepared.sessionFile) {
			throw new Error(
				`Cannot launch ${seedMode} subagent: no parent session file. ` +
					`Use session-mode: standalone in the agent frontmatter, ` +
					`or start pi with a persistent session (--session or --session-dir).`,
			);
		}
		seedSubagentSessionFile(
			seedMode,
			prepared.sessionFile,
			prepared.subagentSessionFile,
			prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
			{
				...(prepared.sessionTitle ? { sessionName: prepared.sessionTitle } : {}),
				activeLeafId: ctx.sessionManager.getLeafId?.(),
			},
		);
		if (boundarySystemPrompt) {
			const boundaryOptions = {
				name: params.name,
				spawningAllowed: prepared.agentDefs?.spawning === true,
			};
			writeChildContextBoundaryEntry(
				prepared.subagentSessionFile,
				boundaryOptions,
				buildChildContextBoundary(boundaryOptions),
			);
		}
	}
	writeSubagentExtensionEntry(
		prepared.subagentSessionFile,
		prepared.effectiveExtensions,
	);
	return { seedMode, boundarySystemPrompt };
}
