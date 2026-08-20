/**
 * Child environment policy shared by background and interactive launches.
 *
 * Layers, in precedence order (later wins):
 *   1. pane identity   — mux/terminal context of the pane the child runs in
 *   2. parent snapshot — the launching pi process env, minus denied names
 *   3. overrides       — frontmatter `env:` plus PI_* control variables
 *
 * `deny-env` (agent frontmatter) and PI_SUBAGENT_ENV_DENY (parent env) filter
 * layer 2 only. They never strip pane identity or overrides, so they cannot
 * break the launch contract itself. Patterns are exact names or `*` wildcards;
 * patterns that match nothing are silently ignored.
 */

/** Mux/terminal context that belongs to the pane the child runs in, not the parent's pane. */
export const PANE_IDENTITY_ENV_PATTERNS = [
	"CMUX*",
	"COLORTERM",
	"HERDR*",
	"TERM",
	"TMUX*",
	"WEZTERM*",
	"ZELLIJ*",
] as const;

/** Shell-relative bookkeeping that is meaningless outside the shell that set it. */
const VOLATILE_SHELL_ENV_KEYS = ["OLDPWD", "PWD", "SHLVL", "_"] as const;

export function parseDenyEnvList(raw: string | undefined): string[] {
	const names: string[] = [];
	for (const token of (raw ?? "").split(/[,\n]/)) {
		const name = token.trim();
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

export function resolveDenyEnvPatterns(
	agentDenyEnv: string | undefined,
	env: { PI_SUBAGENT_ENV_DENY?: string | undefined } = process.env,
): string[] {
	const patterns = [...parseDenyEnvList(agentDenyEnv), ...parseDenyEnvList(env.PI_SUBAGENT_ENV_DENY)];
	return [...new Set(patterns)];
}

/**
 * Match an env name against a pattern where `*` stands for any sequence
 * (including empty). Everything else is compared literally, so names with
 * shell-hostile characters stay plain string data.
 */
export function envNameMatchesPattern(name: string, pattern: string): boolean {
	if (!pattern.includes("*")) return name === pattern;
	const segments = pattern.split("*");
	let cursor = 0;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (index === 0) {
			if (!name.startsWith(segment)) return false;
			cursor = segment.length;
			continue;
		}
		if (index === segments.length - 1) {
			return name.slice(cursor).endsWith(segment);
		}
		const found = name.indexOf(segment, cursor);
		if (found === -1) return false;
		cursor = found + segment.length;
	}
	return true;
}

export function filterDeniedEnv<T extends Record<string, string>>(env: T, patterns: string[]): Record<string, string> {
	if (patterns.length === 0) return { ...env };
	const filtered: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (patterns.some((pattern) => envNameMatchesPattern(key, pattern))) continue;
		filtered[key] = value;
	}
	return filtered;
}

export function stripVolatileShellEnv<T extends Record<string, string>>(env: T): Record<string, string> {
	const stripped: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if ((VOLATILE_SHELL_ENV_KEYS as readonly string[]).includes(key)) continue;
		stripped[key] = value;
	}
	return stripped;
}

/**
 * Extract pane identity from the pane shell's env. Only mux/terminal context is
 * taken; everything else (including secrets) is ignored so the pane's daemon
 * env can never override the parent snapshot.
 */
export function pickPaneIdentityEnv(paneEnv: Record<string, string | undefined>): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const [key, value] of Object.entries(paneEnv)) {
		if (!value) continue;
		if (!PANE_IDENTITY_ENV_PATTERNS.some((pattern) => envNameMatchesPattern(key, pattern))) continue;
		picked[key] = value;
	}
	return picked;
}

/** Build the parent env snapshot for capsule transport: denied names and shell bookkeeping removed. */
export function buildParentEnvSnapshot(
	env: Record<string, string | undefined> = process.env,
	denyPatterns: string[] = [],
): Record<string, string> {
	const present: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") present[key] = value;
	}
	return stripVolatileShellEnv(filterDeniedEnv(present, denyPatterns));
}
