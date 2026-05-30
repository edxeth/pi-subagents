import { homedir } from "node:os";
import { join } from "node:path";

function expandHomeDir(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

export function parseEnvString(env: string | undefined): Record<string, string> {
	if (!env?.trim()) return {};
	const result: Record<string, string> = {};
	for (const line of env.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) throw new Error(`Missing '=' in env variable: "${trimmed}"`);
		const key = trimmed.slice(0, eq).trim();
		if (!key) throw new Error(`Empty env key in: "${trimmed}"`);
		const value = trimmed.slice(eq + 1).trim();
		result[key] = value;
	}
	return result;
}

export function getEnvAgentConfigDir(env: string | undefined): string | null {
	const configDir = parseEnvString(env).PI_CODING_AGENT_DIR;
	return configDir ? expandHomeDir(configDir) : null;
}
