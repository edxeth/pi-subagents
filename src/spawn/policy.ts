import { SPAWNING_TOOL_NAMES } from "../tools/tool-names.ts";
import { MAX_SPAWN_WIDTH } from "../runtime/spawn-width.ts";

export interface SpawnPolicyInput {
	callerAgent: string | null;
	targetAgent: string;
	callerBudget: number | null;
	callerSpawnable: string[] | true;
	targetSpawning: true | string[] | false;
	targetSpawnDepth: number | undefined;
	targetSpawnWidth: number | undefined;
	targetVisibleTo: string[];
	envDepthCeiling: number | null;
	envWidthCeiling: number | null;
}

export interface SpawnPolicyResult {
	allowed: boolean;
	reason?: string;
	failingSide?: "whitelist" | "visible-to" | "budget";
	childBudget: number | null;
	spawnableAgents: string[] | true;
	effectiveWidth: number | null;
}

export interface ParsedSpawnEnv {
	callerAgent: string | null;
	callerBudget: number | null;
	envDepthCeiling: number | null;
	envWidthCeiling: number | null;
	callerSpawnable: string[] | true;
}

export interface PersistedSpawnGrant {
	spawnableAgents?: string[] | true;
	spawnBudget?: number | null;
}

export interface ResumeSpawnEnv {
	PI_SUBAGENT_SPAWN_BUDGET: string;
	PI_SUBAGENT_SPAWNABLE: string;
	PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE: string;
	denyToolsToAdd: string[];
}

const SPAWNABLE_ANY = "true";

function parseNonNegativeInteger(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	// A non-safe-integer depth would make `budget - 1` a no-op and break termination,
	// so treat it as absent (fail to the default/ceiling) rather than honor it.
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse a spawn budget. Absent (undefined) means the root default (unbounded), but a
 * present-but-malformed value fails closed to 0 so a bad budget never widens a grant.
 */
function parseSpawnBudget(value: string | undefined): number | null {
	if (value === undefined) return null;
	const parsed = parseNonNegativeInteger(value);
	return parsed === null ? 0 : parsed;
}

function parseSpawnable(value: string | undefined): string[] | true {
	// Missing is the root-session default; an explicit empty value is a deny-all grant.
	if (value === undefined) return true;
	if (value.trim() === SPAWNABLE_ANY || value.trim() === "all") return true;
	return value
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

function isVisibleToCaller(callerAgent: string | null, targetVisibleTo: string[]): boolean {
	if (targetVisibleTo.includes("all")) return true;
	if (callerAgent === null) return targetVisibleTo.includes("root");
	return callerAgent !== "root" && targetVisibleTo.includes(callerAgent);
}

function isCallerAllowedToSpawn(callerSpawnable: string[] | true, targetAgent: string): boolean {
	return callerSpawnable === true || callerSpawnable.includes(targetAgent);
}

function getChildBudget(input: SpawnPolicyInput): number | null {
	if (input.targetSpawning === false) return null;
	const callerBudget = input.callerBudget ?? Number.POSITIVE_INFINITY;
	const budget = Math.min(
		input.targetSpawnDepth ?? 1,
		callerBudget - 1,
		input.envDepthCeiling ?? Number.POSITIVE_INFINITY,
	);
	return budget > 0 ? budget : null;
}

function getEffectiveWidth(input: SpawnPolicyInput): number | null {
	const width = Math.min(
		input.targetSpawnWidth ?? Number.POSITIVE_INFINITY,
		input.envWidthCeiling ?? Number.POSITIVE_INFINITY,
		MAX_SPAWN_WIDTH,
	);
	return Number.isFinite(width) ? width : null;
}

export function resolveSpawnPolicy(input: SpawnPolicyInput): SpawnPolicyResult {
	const childBudget = getChildBudget(input);
	const spawnableAgents =
		input.targetSpawning === false
			? []
			: input.targetSpawning === true
				? true
				: [...input.targetSpawning];
	const effectiveWidth = getEffectiveWidth(input);

	if (!isCallerAllowedToSpawn(input.callerSpawnable, input.targetAgent)) {
		return {
			allowed: false,
			reason: `Spawn whitelist does not include target agent "${input.targetAgent}".`,
			failingSide: "whitelist",
			childBudget,
			spawnableAgents,
			effectiveWidth,
		};
	}

	if (!isVisibleToCaller(input.callerAgent, input.targetVisibleTo)) {
		return {
			allowed: false,
			reason: `Target visible-to policy does not include this caller for agent "${input.targetAgent}".`,
			failingSide: "visible-to",
			childBudget,
			spawnableAgents,
			effectiveWidth,
		};
	}

	if (input.callerBudget !== null && input.callerBudget <= 0) {
		return {
			allowed: false,
			reason: "Spawn budget is exhausted.",
			failingSide: "budget",
			childBudget,
			spawnableAgents,
			effectiveWidth,
		};
	}

	return {
		allowed: true,
		childBudget,
		spawnableAgents,
		effectiveWidth,
	};
}

export function parseSpawnEnv(env: Record<string, string | undefined>): ParsedSpawnEnv {
	return {
		callerAgent: env.PI_SUBAGENT_AGENT?.trim() || null,
		callerBudget: parseSpawnBudget(env.PI_SUBAGENT_SPAWN_BUDGET),
		envDepthCeiling: parseNonNegativeInteger(env.PI_SUBAGENT_SPAWN_DEPTH),
		envWidthCeiling: parseNonNegativeInteger(
			env.PI_SUBAGENT_AGENT?.trim() && env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE !== undefined
				? env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE
				: env.PI_SUBAGENT_SPAWN_WIDTH,
		),
		callerSpawnable: parseSpawnable(env.PI_SUBAGENT_SPAWNABLE),
	};
}

export function narrowSpawnBudget(
	persisted: Pick<PersistedSpawnGrant, "spawnBudget"> | undefined,
	callerBudget: number | null,
	envCeiling: number | null,
): number {
	return Math.min(
		persisted?.spawnBudget ?? 0,
		(callerBudget ?? Number.POSITIVE_INFINITY) - 1,
		envCeiling ?? Number.POSITIVE_INFINITY,
	);
}

export function buildResumeSpawnEnv(
	persisted: PersistedSpawnGrant | undefined,
	narrowedBudget: number,
	effectiveWidth: number | null,
): ResumeSpawnEnv {
	return {
		PI_SUBAGENT_SPAWN_BUDGET: String(narrowedBudget > 0 ? narrowedBudget : 0),
		PI_SUBAGENT_SPAWNABLE:
			persisted?.spawnableAgents === true ? "true" : (persisted?.spawnableAgents ?? []).join(","),
		// Like the budget and spawnable grant, width is serialized unconditionally so the
		// resumed child enforces its own frontmatter width instead of inheriting the
		// resumer's (or falling back to the MAX_SPAWN_WIDTH default).
		PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE: effectiveWidth === null ? "" : String(effectiveWidth),
		denyToolsToAdd: narrowedBudget > 0 ? [] : [...SPAWNING_TOOL_NAMES],
	};
}
