import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { shellEscape } from "./core.ts";

// Interactive launches are staged as a POSIX script and typed into the child pane.
// The pane shell is not always POSIX: on Windows a Herdr or cmux pane usually runs
// PowerShell, which prints a bare quoted path instead of executing it and rejects
// `rm -f` ("the parameter name 'f' is ambiguous"). Both halves of the staged line
// fail silently, so the parent waits forever on a done sentinel that is never written.
// This module classifies the pane shell and emits a line that shell can actually run.

export type PaneShellKind = "posix" | "powershell" | "cmd";

const POSIX_SHELL_NAMES = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish", "busybox", "ash"]);
const POWERSHELL_NAMES = new Set(["pwsh", "powershell"]);
const CMD_NAMES = new Set(["cmd"]);

export function classifyPaneShell(processName: string | undefined): PaneShellKind | undefined {
	if (!processName) return undefined;
	const base = processName.split(/[\\/]/).pop() ?? "";
	const name = base.trim().toLowerCase().replace(/\.exe$/, "");
	if (!name) return undefined;
	if (POWERSHELL_NAMES.has(name)) return "powershell";
	if (CMD_NAMES.has(name)) return "cmd";
	if (POSIX_SHELL_NAMES.has(name)) return "posix";
	return undefined;
}

// A pane can report several foreground processes, and a busy one can report a program
// rather than its shell. Take the first name that is a shell we recognize.
export function classifyPaneShells(processNames: readonly string[]): PaneShellKind | undefined {
	for (const name of processNames) {
		const kind = classifyPaneShell(name);
		if (kind) return kind;
	}
	return undefined;
}

// Used when the backend cannot report the pane process. Windows panes default to
// PowerShell because that is the Herdr and cmux default shell there.
export function defaultPaneShellKind(platform: NodeJS.Platform = process.platform): PaneShellKind {
	return platform === "win32" ? "powershell" : "posix";
}

function psQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function cmdQuote(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

export type PosixInterpreterProbe = {
	getEnv?: (name: string) => string | undefined;
	exists?: (path: string) => boolean;
	whichAll?: (command: string) => string[];
};

// WSL ships C:\Windows\System32\bash.exe and it often wins `where bash`. It runs in the
// Linux filesystem namespace, so `cd 'C:\...'` fails and `pi` resolves to a Linux binary
// or nothing at all. It can never launch a Windows subagent; skip it explicitly.
export function isWslBashPath(candidate: string): boolean {
	const normalized = candidate.replace(/\//g, "\\").toLowerCase();
	return /\\windows\\(system32|sysnative|syswow64)\\bash\.exe$/.test(normalized);
}

function windowsBashCandidates(getEnv: (name: string) => string | undefined): string[] {
	const roots = [getEnv("ProgramFiles"), getEnv("ProgramFiles(x86)"), getEnv("ProgramW6432")].filter(
		(root): root is string => !!root,
	);
	const local = getEnv("LOCALAPPDATA");
	const candidates: string[] = [];
	for (const root of roots) {
		candidates.push(`${root}\\Git\\usr\\bin\\bash.exe`, `${root}\\Git\\bin\\bash.exe`);
	}
	if (local) {
		candidates.push(`${local}\\Programs\\Git\\usr\\bin\\bash.exe`, `${local}\\Programs\\Git\\bin\\bash.exe`);
	}
	// MSYS2 only. Cygwin's bash is deliberately not listed: its path layer does not
	// accept a Windows `cd 'C:\...'` the way Git for Windows and MSYS2 do.
	candidates.push("C:\\msys64\\usr\\bin\\bash.exe");
	return candidates;
}

function whereCommand(command: string): string[] {
	try {
		const output = execFileSync("where.exe", [command], { encoding: "utf8" });
		return output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

// Resolution order: explicit override, then PATH (minus WSL), then known install roots.
export function resolveWindowsPosixInterpreter(probe: PosixInterpreterProbe = {}): string | undefined {
	const getEnv = probe.getEnv ?? DEFAULT_ENV_READER;
	const exists = probe.exists ?? existsSync;
	const whichAll = probe.whichAll ?? whereCommand;

	const explicit = (getEnv("PI_SUBAGENT_WIN_BASH") ?? "").trim();
	if (explicit) return exists(explicit) ? explicit : undefined;

	for (const candidate of whichAll("bash")) {
		if (isWslBashPath(candidate)) continue;
		if (exists(candidate)) return candidate;
	}
	for (const candidate of windowsBashCandidates(getEnv)) {
		if (exists(candidate)) return candidate;
	}
	return undefined;
}

const DEFAULT_ENV_READER = (name: string) => process.env[name];

export function posixInterpreterSetupHint(getEnv = DEFAULT_ENV_READER): string {
	const explicit = (getEnv("PI_SUBAGENT_WIN_BASH") ?? "").trim();
	if (explicit) {
		return (
			`PI_SUBAGENT_WIN_BASH points at "${explicit}", which does not exist. ` +
			'Set it to a bash.exe that can run Windows paths, for example "C:\\Program Files\\Git\\usr\\bin\\bash.exe".'
		);
	}
	return (
		"No POSIX shell was found to run the staged subagent launch script in this pane. " +
		"Install Git for Windows, or set PI_SUBAGENT_WIN_BASH to a bash.exe path. " +
		"WSL's C:\\Windows\\System32\\bash.exe is ignored: it cannot open Windows paths or launch a Windows pi."
	);
}

export type StagedShellPlan = {
	kind: PaneShellKind;
	interpreter?: string;
};

export function buildStagedShellCommand(scriptPath: string, plan: StagedShellPlan): string {
	if (plan.kind === "posix") {
		return `${shellEscape(scriptPath)}; rm -f ${shellEscape(scriptPath)}`;
	}
	if (!plan.interpreter) {
		throw new Error(`Staged ${plan.kind} launch requires a POSIX interpreter. ${posixInterpreterSetupHint()}`);
	}
	if (plan.kind === "powershell") {
		// `&` is required: PowerShell evaluates a bare quoted path as a string literal.
		return `& ${psQuote(plan.interpreter)} ${psQuote(scriptPath)}; Remove-Item -Force ${psQuote(scriptPath)}`;
	}
	return `${cmdQuote(plan.interpreter)} ${cmdQuote(scriptPath)} & del /f /q ${cmdQuote(scriptPath)}`;
}

// Resolve before staging so a missing interpreter fails loudly instead of leaving an
// orphaned %TEMP% script and a child pane that never starts.
export function resolveStagedShellPlan(
	paneShellNames: readonly string[],
	probe: PosixInterpreterProbe = {},
	platform: NodeJS.Platform = process.platform,
): StagedShellPlan {
	const kind = classifyPaneShells(paneShellNames) ?? defaultPaneShellKind(platform);
	if (kind === "posix") return { kind };
	const interpreter = resolveWindowsPosixInterpreter(probe);
	if (!interpreter) {
		const getEnv = probe.getEnv ?? DEFAULT_ENV_READER;
		throw new Error(`Cannot start an interactive subagent in this pane. ${posixInterpreterSetupHint(getEnv)}`);
	}
	return { kind, interpreter };
}
