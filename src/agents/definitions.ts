import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface AgentDefaults {
	enabled?: boolean;
	model?: string;
	allowModelOverride?: boolean;
	tools?: string;
	skills?: string;
	injectSkills?: string;
	extensions?: string;
	thinking?: string;
	denyTools?: string;
	spawning?: boolean;
	autoExit?: boolean;
	systemPromptMode?: "append" | "replace";
	cwd?: string;
	cwdBase?: string;
	path?: string;
	body?: string;
	mode?: "interactive" | "background";
	sessionMode?: "standalone" | "lineage-only" | "fork";
	fork?: boolean;
	async?: boolean;
	blocking?: boolean;
	noContextFiles?: boolean;
	noSession?: boolean;
	timeout?: number;

	flags?: string;
	env?: string;
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
		const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m ? m[1].trim() : undefined;
	};
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
	const forkRaw = get("fork");
	const asyncRaw = get("async");
	const blockingRaw = get("blocking");
	const noContextFilesRaw = get("no-context-files");
	const noSessionRaw = get("no-session");
	const timeoutRaw = get("timeout");


	const systemPromptRaw = get("system-prompt");
	const extensionsRaw = get("extensions");
	const injectSkillsRaw = get("inject-skills");
	const flagsRaw = get("flags");
	const parentClosePolicyRaw = get("parent-close-policy");
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	return {
		name: get("name") ?? basename(path, ".md"),
		description: get("description"),
		source,
		path,
		enabled: enabledRaw != null ? enabledRaw === "true" : undefined,
		model: get("model"),
		allowModelOverride:
			allowModelOverrideRaw != null
				? allowModelOverrideRaw === "true"
				: undefined,
		tools: get("tools"),
		skills: get("skills"),
		injectSkills: injectSkillsRaw,
		extensions: extensionsRaw,
		thinking: get("thinking"),
		denyTools: get("deny-tools"),
		spawning: spawningRaw != null ? spawningRaw === "true" : false,
		autoExit: autoExitRaw != null ? autoExitRaw === "true" : undefined,
		systemPromptMode:
			systemPromptRaw === "append" || systemPromptRaw === "replace"
				? systemPromptRaw
				: undefined,
		cwd: get("cwd"),
		cwdBase,
		body: body || undefined,
		sessionMode:
			sessionModeRaw === "standalone" ||
			sessionModeRaw === "lineage-only" ||
			sessionModeRaw === "fork"
				? sessionModeRaw
				: forkRaw === "true"
					? "fork"
					: undefined,
		fork: forkRaw != null ? forkRaw === "true" : undefined,
		async: asyncRaw != null ? asyncRaw === "true" : undefined,
		blocking: blockingRaw != null ? blockingRaw === "true" : undefined,
		noContextFiles:
			noContextFilesRaw != null ? noContextFilesRaw === "true" : undefined,
		noSession: noSessionRaw != null ? noSessionRaw === "true" : undefined,
		mode:
			modeRaw === "background" || modeRaw === "interactive"
				? modeRaw
				: undefined,
		timeout: timeoutRaw != null ? parseInt(timeoutRaw, 10) : undefined,

		flags: flagsRaw,
		env: getBlock("env"),
		parentClosePolicy:
			parentClosePolicyRaw === "terminate" ||
			parentClosePolicyRaw === "continue"
				? parentClosePolicyRaw
				: undefined,
	};
}

export type ResolveAgentCwd = (cwdHint: string | null, baseCwd: string) => string;

export function getEffectiveAgentDefinitions(
	baseCwd = process.cwd(),
): ResolvedAgentDefinition[] {
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
	return (
		getEffectiveAgentDefinitions(resolvedBaseCwd).find(
			(agent) => agent.name === agentName,
		) ?? null
	);
}
