import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefaults } from "../agents/definitions.ts";
import { getAgentConfigDir } from "../agents/definitions.ts";
import type { SubagentParamsInput } from "../types.ts";
import { getEnvAgentConfigDir } from "./env.ts";

export function resolveSubagentCwd(
	rawCwd: string | null,
	baseCwd = process.cwd(),
): string {
	if (!rawCwd) return baseCwd;
	return rawCwd.startsWith("/") ? rawCwd : join(baseCwd, rawCwd);
}

export function resolveSubagentConfigDir(
	rawCwd: string | null,
	baseCwd = process.cwd(),
): string | null {
	const localAgentDir = join(
		resolveSubagentCwd(rawCwd, baseCwd),
		".pi",
		"agent",
	);
	return existsSync(localAgentDir) ? localAgentDir : null;
}

export interface ResolvedSubagentRuntimePaths {
	rawCwd: string | null;
	cwdBase: string;
	effectiveCwd: string | null;
	localAgentConfigDir: string | null;
	effectiveAgentConfigDir: string;
	targetCwdForSession: string;
	sessionDir: string;
}

function getDefaultSessionDirFor(cwd: string, agentConfigDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentConfigDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

export function resolveSubagentRuntimePaths(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
	parentCwd: string,
	parentSessionDir: string,
): ResolvedSubagentRuntimePaths {
	const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
	const cwdBase = params.cwd ? parentCwd : (agentDefs?.cwdBase ?? parentCwd);
	const effectiveCwd = rawCwd ? resolveSubagentCwd(rawCwd, cwdBase) : null;
	const localAgentConfigDir = getEnvAgentConfigDir(agentDefs?.env) ?? resolveSubagentConfigDir(rawCwd, cwdBase);
	const effectiveAgentConfigDir = localAgentConfigDir ?? getAgentConfigDir();
	const targetCwdForSession = effectiveCwd ?? parentCwd;
	return {
		rawCwd,
		cwdBase,
		effectiveCwd,
		localAgentConfigDir,
		effectiveAgentConfigDir,
		targetCwdForSession,
		sessionDir: localAgentConfigDir
			? getDefaultSessionDirFor(targetCwdForSession, localAgentConfigDir)
			: parentSessionDir,
	};
}
