import type { SubagentParamsInput } from "../types.ts";
import { parseEnvString } from "./env.ts";
import type { PreparedSubagentLaunch } from "./prep.ts";
import { resolveSubagentCwd } from "./runtime-paths.ts";

/**
 * Internal, runtime-only launch overrides applied ON TOP of the frozen launch
 * blueprint. They never take part in blueprint resolution: definitions,
 * capabilities, skills, and session paths are always resolved against the
 * SOURCE cwd so every candidate of a fan-out shares one blueprint.
 */
export interface LaunchRuntimeOverrides {
	/** Absolute or source-relative directory the child process runs in. */
	forcedCwd?: string;
	/** Env additions that win over frontmatter `env` on collision (warned). */
	launchEnv?: Record<string, string>;
}

/**
 * Remove the internal override fields from model-callable tool input. The
 * subagent tool schema does not advertise them, but a caller that smuggles
 * extra JSON properties through must not reach the privileged launch path.
 */
export function stripInternalLaunchOverrides<T extends Partial<SubagentParamsInput>>(params: T): T {
	if (params.forcedCwd === undefined && params.launchEnv === undefined) return params;
	const { forcedCwd: _forcedCwd, launchEnv: _launchEnv, ...rest } = params;
	return rest as T;
}

/**
 * Resolve the forced child cwd against the SOURCE cwd. Internal callers pass
 * absolute worktree paths; relative values are still resolved defensively.
 */
export function resolveForcedChildCwd(overrides: LaunchRuntimeOverrides, sourceCwd: string): string | undefined {
	if (!overrides.forcedCwd) return undefined;
	return resolveSubagentCwd(overrides.forcedCwd, sourceCwd);
}

/** Frontmatter env keys that a launchEnv override replaces. */
export function getLaunchEnvCollisions(
	launchEnv: Record<string, string> | undefined,
	frontmatterEnv: string | undefined,
): string[] {
	if (!launchEnv || Object.keys(launchEnv).length === 0) return [];
	const frontmatterKeys = new Set(Object.keys(parseEnvString(frontmatterEnv)));
	return Object.keys(launchEnv)
		.filter((key) => frontmatterKeys.has(key))
		.sort();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze(value: unknown): void {
	if (!isPlainObject(value) && !Array.isArray(value)) return;
	if (Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) {
		if (isPlainObject(child) || Array.isArray(child)) deepFreeze(child);
	}
}

/**
 * Freeze a resolved launch so later runtime overrides cannot mutate the
 * blueprint every candidate of a fan-out must share. Sets and Maps are frozen
 * shallowly (their container); nested plain objects and arrays are frozen
 * recursively.
 */
export function freezeLaunchBlueprint(prepared: PreparedSubagentLaunch): PreparedSubagentLaunch {
	deepFreeze(prepared);
	return prepared;
}
