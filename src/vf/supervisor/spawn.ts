import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseCommandWords } from "../../launch/child-command.ts";

/**
 * Resolve how to spawn the detached supervisor process.
 *
 * The supervisor entry is TypeScript (same source tree as the extension), so
 * the runtime must be able to execute .ts files. Node >= 23 strips types
 * natively; bun always can. A bundled pi binary can neither be re-invoked
 * with a script path nor assumed to carry a TS runtime, so in that case we
 * look for bun or a new-enough node on PATH, or take an explicit override.
 */

export class SupervisorRuntimeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SupervisorRuntimeError";
	}
}

export interface SupervisorRuntime {
	command: string;
	/** Args before the entry script path (none for node/bun). */
	preArgs: string[];
	label: string;
}

export function getSupervisorMainPath(): string {
	return fileURLToPath(new URL("./main.ts", import.meta.url));
}

export function resolveSupervisorRuntime(): SupervisorRuntime {
	const override = process.env.PI_SUBAGENT_SUPERVISOR_RUNTIME?.trim();
	if (override) {
		const parts = parseCommandWords(override);
		if (parts.length === 0) {
			throw new SupervisorRuntimeError("PI_SUBAGENT_SUPERVISOR_RUNTIME did not contain a command.");
		}
		return { command: parts[0], preArgs: parts.slice(1), label: parts[0] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (isGenericRuntime) {
		return { command: process.execPath, preArgs: [], label: execName.replace(/\.exe$/, "") };
	}

	// Bundled binary (pi itself): use PATH runtimes, newest guarantee first.
	const bun = findOnPath("bun");
	if (bun) return { command: bun, preArgs: [], label: "bun" };
	const node = findOnPath("node");
	if (node && nodeSupportsTypeStripping(node)) {
		return { command: node, preArgs: [], label: "node" };
	}
	throw new SupervisorRuntimeError(
		`Cannot find a runtime for the detached supervisor. pi runs as a bundled binary (${process.execPath}), ` +
			"and neither a usable bun nor node >= 23 was found on PATH. " +
			"Fix: install bun, upgrade node to >= 23, or set PI_SUBAGENT_SUPERVISOR_RUNTIME to a command that runs a .ts file " +
			"(e.g. \"bun\" or \"node --experimental-strip-types\").",
	);
}

function findOnPath(binary: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		for (const name of [binary, `${binary}.exe`]) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

function nodeSupportsTypeStripping(nodePath: string): boolean {
	try {
		const result = spawnSync(nodePath, ["--version"], { encoding: "utf8", timeout: 5000 });
		const match = result.stdout?.match(/v(\d+)\.(\d+)/);
		if (!match) return false;
		const major = Number(match[1]);
		const minor = Number(match[2]);
		// Type stripping is on by default from 23.6 (and 22.18) onward.
		return major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
	} catch {
		return false;
	}
}
