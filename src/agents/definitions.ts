import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface AgentDefaults {
	enabled?: boolean;
	model?: string;
	allowedModels?: string;
	allowModelOverride?: boolean;
	tools?: string;
	skills?: string;
	injectSkills?: string;
	extensions?: string;
	thinking?: string;
	denyTools?: string;
	spawning?: true | string[] | false;
	spawnDepth?: number;
	spawnWidth?: number;
	visibleTo?: string[];
	autoExit?: boolean;
	systemPromptMode?: "append" | "replace";
	cwd?: string;
	cwdBase?: string;
	path?: string;
	body?: string;
	mode?: "interactive" | "background";
	sessionMode?: "standalone" | "lineage-only" | "fork";
	async?: boolean;
	noContextFiles?: boolean;
	inheritAppendSystem?: boolean;
	noSession?: boolean;
	trustProject?: boolean;
	taskExpansion?: "shell";
	/** Wall-clock seconds a child may run before the parent kills it. */
	timeout?: number;
	/** Seconds a child may go without session growth before the parent kills it. */
	idleTimeout?: number;
	/** Raw `timeout-warn-threshold` value; launch policy validates it. */
	timeoutWarnThreshold?: string;
	/** What the parent allows after a timeout kill. Defaults to `report`. */
	onTimeout?: "report" | "block-resume";
	/**
	 * `llm-as-a-verifier` frontmatter flag. Marks every launch of this
	 * definition as a verified fan-out (ticket 01 owns the boolean only; the
	 * candidates/model/criteria siblings live in ticket 10).
	 */
	llmAsVerifier?: boolean;
	contextWarnThreshold?: string;
	contextWarnStep?: string;
	reportContextUsage?: boolean;

	flags?: string;
	env?: string;
	/** Comma- or newline-separated env names (with `*` globs) excluded from the inherited parent env. */
	denyEnv?: string;
	parentClosePolicy?: "terminate" | "continue";
}

export interface ResolvedAgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	source: "project" | "global";
	path: string;
}

export function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function parseAgentDefinition(
	path: string,
	source: "project" | "global",
	cwdBase: string,
): ResolvedAgentDefinition | null {
	const content = readFileSync(path, "utf8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const frontmatter = match[1];
	const get = (key: string) => {
		const m = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
		return m ? m[1].trim() : undefined;
	};
	const hasKey = (key: string) => new RegExp(`^${key}:`, "m").test(frontmatter);
	const getBlock = (key: string) => {
		const inline = get(key);
		if (inline !== "|") return inline;
		const lines = frontmatter.split(/\r?\n/);
		const start = lines.findIndex((line) => line.match(new RegExp(`^${key}:\\s*\\|\\s*$`)));
		if (start === -1) return inline;
		const block: string[] = [];
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() && !line.match(/^[ \t]/)) break;
			block.push(line.replace(/^[ \t]{1,2}/, ""));
		}
		return block.join("\n").trim();
	};
	const enabledRaw = get("enabled");
	if (enabledRaw === "false") return null;
	const spawningRaw = get("spawning");
	const autoExitRaw = get("auto-exit");
	const allowModelOverrideRaw = get("allow-model-override");
	const modeRaw = get("mode");
	const sessionModeRaw = get("session-mode");
	const asyncRaw = get("async");
	const noContextFilesRaw = get("no-context-files");
	const inheritAppendSystemRaw = get("inherit-append-system");
	const noSessionRaw = get("no-session");
	const trustProjectRaw = get("trust-project");
	const taskExpansionRaw = get("task-expansion");
	const timeoutRaw = get("timeout");
	const idleTimeoutRaw = get("idle-timeout");
	const timeoutWarnThresholdRaw = get("timeout-warn-threshold");
	const onTimeoutRaw = get("on-timeout");
	const contextWarnThresholdRaw = get("context-warn-threshold");
	const contextWarnStepRaw = get("context-warn-step");
	const reportContextUsageRaw = get("report-context-usage");
	const llmAsVerifier = parseLlmAsVerifier(get("llm-as-a-verifier"), hasKey("llm-as-a-verifier"), path);
	const spawnDepthRaw = get("spawn-depth");
	const spawnWidthRaw = get("spawn-width");

	const systemPromptRaw = get("system-prompt");
	const extensionsRaw = get("extensions");
	const injectSkillsRaw = get("inject-skills");
	const flagsRaw = get("flags");
	const parentClosePolicyRaw = get("parent-close-policy");
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	const spawning = parseSpawning(spawningRaw);
	const spawnDepth = parsePositiveInteger("spawn-depth", spawnDepthRaw, hasKey("spawn-depth"));
	const spawnWidth = parsePositiveInteger("spawn-width", spawnWidthRaw, hasKey("spawn-width"));
	// A malformed budget must never resolve to "unbounded": that turns a typo
	// into the exact runaway the field exists to prevent.
	const timeout = parsePositiveInteger("timeout", timeoutRaw, hasKey("timeout"));
	const idleTimeout = parsePositiveInteger("idle-timeout", idleTimeoutRaw, hasKey("idle-timeout"));
	const onTimeout = parseOnTimeout(onTimeoutRaw, hasKey("on-timeout"), path);
	const visibleTo = parseVisibleTo(get("visible-to"));
	return {
		name: get("name") ?? basename(path, ".md"),
		description: get("description"),
		source,
		path,
		enabled: enabledRaw != null ? enabledRaw === "true" : undefined,
		model: get("model"),
		allowedModels: get("allowed-models"),
		allowModelOverride: allowModelOverrideRaw != null ? allowModelOverrideRaw === "true" : undefined,
		tools: get("tools"),
		skills: get("skills"),
		injectSkills: injectSkillsRaw,
		extensions: extensionsRaw,
		thinking: get("thinking"),
		denyTools: get("deny-tools"),
		spawning,
		...(spawnDepth !== undefined ? { spawnDepth } : {}),
		...(spawnWidth !== undefined ? { spawnWidth } : {}),
		visibleTo,
		autoExit: autoExitRaw != null ? autoExitRaw === "true" : undefined,
		systemPromptMode: systemPromptRaw === "append" || systemPromptRaw === "replace" ? systemPromptRaw : undefined,
		cwd: get("cwd"),
		cwdBase,
		body: body || undefined,
		sessionMode:
			sessionModeRaw === "standalone" || sessionModeRaw === "lineage-only" || sessionModeRaw === "fork"
				? sessionModeRaw
				: undefined,
		async: asyncRaw != null ? asyncRaw === "true" : undefined,
		noContextFiles: noContextFilesRaw != null ? noContextFilesRaw === "true" : undefined,
		inheritAppendSystem: inheritAppendSystemRaw === "true",
		noSession: noSessionRaw != null ? noSessionRaw === "true" : undefined,
		trustProject: trustProjectRaw != null ? trustProjectRaw === "true" : undefined,
		mode: modeRaw === "background" || modeRaw === "interactive" ? modeRaw : undefined,
		taskExpansion: taskExpansionRaw === "shell" ? "shell" : undefined,
		...(timeout !== undefined ? { timeout } : {}),
		...(idleTimeout !== undefined ? { idleTimeout } : {}),
		timeoutWarnThreshold: timeoutWarnThresholdRaw,
		onTimeout,
		llmAsVerifier,
		contextWarnThreshold: contextWarnThresholdRaw,
		contextWarnStep: contextWarnStepRaw,
		reportContextUsage: reportContextUsageRaw != null ? reportContextUsageRaw === "true" : undefined,

		flags: flagsRaw,
		env: getBlock("env"),
		denyEnv: getBlock("deny-env"),
		parentClosePolicy:
			parentClosePolicyRaw === "terminate" || parentClosePolicyRaw === "continue" ? parentClosePolicyRaw : undefined,
	};
}

const RESERVED_SPAWNING_NAMES = new Set(["root", "all", "true", "false"]);

function parseCommaSeparated(value: string): string[] {
	return value
		.split(",")
		.map((token) => token.trim())
		.filter(Boolean);
}

function parseSpawning(raw: string | undefined): true | string[] | false {
	if (raw === undefined || raw === "false") return false;
	if (raw === "true") return true;
	const names = parseCommaSeparated(raw);
	for (const name of names) {
		if (RESERVED_SPAWNING_NAMES.has(name)) {
			throw new Error(`Invalid spawning value: reserved agent name "${name}" cannot appear in a spawn list.`);
		}
	}
	return names;
}

function parsePositiveInteger(key: string, raw: string | undefined, present: boolean): number | undefined {
	if (!present) return undefined;
	if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
		throw new Error(`${key} must be a positive safe integer greater than 0.`);
	}
	return Number(raw);
}

/**
 * Resolve the `on-timeout` policy, rejecting anything unrecognised.
 *
 * This one fails closed on purpose. Silently taking the permissive default
 * would mean a typo like `block-resuem` re-enables resume for exactly the
 * agent that asked to be protected from a second partial run.
 */
function parseOnTimeout(
	raw: string | undefined,
	present: boolean,
	path: string,
): "report" | "block-resume" | undefined {
	if (!present) return undefined;
	if (raw === "report" || raw === "block-resume") return raw;
	throw new Error(`on-timeout must be "report" or "block-resume" (got ${JSON.stringify(raw ?? "")}) in ${path}.`);
}

/**
 * Resolve the `llm-as-a-verifier` flag, rejecting anything but `true`/`false`.
 *
 * The candidate count moved to `llm-as-a-verifier-candidates` (ticket 10), so
 * an integer here is a stale or mistyped definition. Accepting it would either
 * guess a count the author meant to put on the sibling field or silently run
 * the default — both wrong, so it fails agent loading instead.
 */
function parseLlmAsVerifier(
	raw: string | undefined,
	present: boolean,
	path: string,
): boolean | undefined {
	if (!present) return undefined;
	if (raw === "true" || raw === "false") return raw === "true";
	throw new Error(`llm-as-a-verifier must be "true" or "false" (got ${JSON.stringify(raw ?? "")}) in ${path}.`);
}

function parseVisibleTo(raw: string | undefined): string[] {
	if (raw === undefined) return ["all"];
	const names = parseCommaSeparated(raw);
	if (names.includes("all") && names.length > 1) {
		throw new Error('visible-to cannot mix "all" with other agent names.');
	}
	return names;
}

export type ResolveAgentCwd = (cwdHint: string | null, baseCwd: string) => string;

export function getEffectiveAgentDefinitions(baseCwd = process.cwd()): ResolvedAgentDefinition[] {
	const configDir = getAgentConfigDir();
	const agents = new Map<string, ResolvedAgentDefinition>();
	const dirs = [
		{
			path: join(configDir, "agents"),
			source: "global" as const,
			cwdBase: configDir,
		},
		{
			path: join(baseCwd, ".pi", "agents"),
			source: "project" as const,
			cwdBase: baseCwd,
		},
	];
	for (const { path: dir, source, cwdBase } of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort((a, b) => a.localeCompare(b))) {
			const definition = parseAgentDefinition(join(dir, file), source, cwdBase);
			if (!definition) continue;
			agents.set(definition.name, definition);
		}
	}
	return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgentDefaults(
	agentName: string,
	cwdHint: string | null | undefined,
	baseCwd: string,
	resolveAgentCwd: ResolveAgentCwd,
): AgentDefaults | null {
	const resolvedBaseCwd = resolveAgentCwd(cwdHint ?? null, baseCwd);
	return getEffectiveAgentDefinitions(resolvedBaseCwd).find((agent) => agent.name === agentName) ?? null;
}
