import { existsSync } from "node:fs";
import { basename } from "node:path";
import { shellEscape } from "../mux.ts";

export interface PiInvocation {
	command: string;
	args: string[];
}

/**
 * Split a command override into argv parts. This intentionally supports only
 * shell-style quoting/escaping, not expansion or operators, because the result
 * is also used with spawn() for background subagents.
 */
export function parseCommandWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaping = false;

	for (const char of command.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && quote === null) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = null;
			continue;
		}
		if (/\s/.test(char) && quote === null) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) current += "\\";
	if (quote !== null)
		throw new Error("PI_SUBAGENT_PI_COMMAND has an unterminated quote");
	if (current) words.push(current);
	return words;
}

/**
 * Resolve the correct pi binary path for spawn(). Handles node, bun,
 * bundled executables, and opt-in wrapper commands.
 */
export function getPiInvocation(args: string[]): PiInvocation {
	const override = process.env.PI_SUBAGENT_PI_COMMAND?.trim();
	if (override) {
		const parts = parseCommandWords(override);
		if (parts.length === 0) {
			throw new Error("PI_SUBAGENT_PI_COMMAND did not contain a command");
		}
		return { command: parts[0], args: [...parts.slice(1), ...args] };
	}


	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export function getPiShellParts(args: string[]): string[] {
	const invocation = getPiInvocation(args);
	return [
		shellEscape(invocation.command),
		...invocation.args.map((arg) => shellEscape(arg)),
	];
}

export function getSubagentChildProcessEnv(
	_invocation: PiInvocation,
	envVars: Record<string, string>,
): NodeJS.ProcessEnv {
	const env = { ...process.env, ...envVars };
	return env;
}
