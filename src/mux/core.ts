import { execFile, execFileSync } from "node:child_process";
import { basename, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { isHerdrRuntimeAvailable } from "./herdr.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

export const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr";

// Zellij does not update an existing process environment after a session rename.
// Keep the live session identity discovered at Pi startup instead of trusting the
// inherited ZELLIJ_SESSION_NAME for later subagent actions.
export interface ZellijRuntimeContext {
	sessionName: string;
	parentPaneId: number;
}

// Pane IDs repeat between Zellij sessions, so discovery needs pane state, cwd,
// and attached-client information to identify the session without guessing.
export interface ZellijSessionSnapshot {
	name: string;
	panes: Array<{
		id: number;
		is_plugin?: boolean;
		exited?: boolean;
		pane_cwd?: string;
	}>;
	clientPaneIds: number[];
}

let zellijRuntimeContext: ZellijRuntimeContext | null = null;
let zellijRuntimeError: string | null = null;

// Client focus is only a tie-breaker: an interactive child Pi often runs in a
// non-focused pane while the single attached client remains on the parent pane.
function parseZellijClientPaneIds(output: string): number[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(1)
		.map((line) => line.split(/\s+/)[1])
		.map((pane) => pane?.match(/(?:terminal_)?(\d+)/)?.[1])
		.filter((paneId): paneId is string => !!paneId)
		.map(Number);
}

function samePath(left: string | undefined, right: string): boolean {
	if (!left) return false;
	try {
		return resolvePath(left) === resolvePath(right);
	} catch {
		return left === right;
	}
}

/**
 * Resolves the current Zellij session from live pane snapshots.
 *
 * A unique pane ID is sufficient. Reused pane IDs are narrowed by cwd, then by
 * attached-client focus. Remaining ambiguity fails closed so commands cannot be
 * routed into an unrelated session.
 */
export function resolveZellijRuntimeContextFromSnapshots(
	parentPaneId: number,
	cwd: string,
	snapshots: ZellijSessionSnapshot[],
): ZellijRuntimeContext {
	const candidates = snapshots.filter((snapshot) =>
		snapshot.panes.some(
			(pane) =>
				pane.id === parentPaneId && !pane.is_plugin && !pane.exited,
		),
	);
	if (candidates.length === 1) {
		return { sessionName: candidates[0].name, parentPaneId };
	}

	// Session renames leave the old name in process.env, but the pane cwd remains
	// tied to the actual session and disambiguates common same-ID collisions.
	const cwdMatches = candidates.filter((snapshot) =>
		snapshot.panes.some(
			(pane) =>
				pane.id === parentPaneId &&
				!pane.is_plugin &&
				!pane.exited &&
				samePath(pane.pane_cwd, cwd),
		),
	);
	if (cwdMatches.length === 1) {
		return { sessionName: cwdMatches[0].name, parentPaneId };
	}

	// The focused client identifies the parent Pi pane when cwd alone is not
	// unique. Child panes do not depend on this fallback.
	const clientMatches = candidates.filter((snapshot) =>
		snapshot.clientPaneIds.includes(parentPaneId),
	);
	if (clientMatches.length === 1) {
		return { sessionName: clientMatches[0].name, parentPaneId };
	}

	if (candidates.length === 0) {
		throw new Error(
			`Could not discover the Zellij session containing pane ${parentPaneId}.`,
		);
	}
	throw new Error(
		`Zellij pane ${parentPaneId} matches multiple sessions: ${candidates
			.map((candidate) => candidate.name)
			.join(", ")}.`,
	);
}

function discoverZellijRuntimeContext(cwd: string): ZellijRuntimeContext {
	const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
	if (!Number.isInteger(parentPaneId)) {
		throw new Error("ZELLIJ_PANE_ID is missing or invalid.");
	}
	const sessions = execFileSync(
		"zellij",
		["list-sessions", "--short", "--no-formatting"],
		{ encoding: "utf8" },
	)
		.split("\n")
		.map((session) => session.trim())
		.filter(Boolean);
	const snapshots: ZellijSessionSnapshot[] = [];
	for (const name of sessions) {
		try {
			// Every probe names its target explicitly. Using an implicit action here
			// would reproduce the stale-environment bug discovery is meant to fix.
			const panes = JSON.parse(
				execFileSync(
					"zellij",
					["--session", name, "action", "list-panes", "--json", "--state"],
					{ encoding: "utf8" },
				),
			);
			if (!Array.isArray(panes)) continue;
			let clientPaneIds: number[] = [];
			try {
				clientPaneIds = parseZellijClientPaneIds(
					execFileSync(
						"zellij",
						["--session", name, "action", "list-clients"],
						{ encoding: "utf8" },
					),
				);
			} catch {}
			snapshots.push({ name, panes, clientPaneIds });
		} catch {}
	}
	return resolveZellijRuntimeContextFromSnapshots(parentPaneId, cwd, snapshots);
}

// session_start performs discovery once per Pi session. Cache failures as well
// as successes so later launches return the original diagnostic without falling
// back to the stale inherited session name.
export function initializeZellijRuntimeContext(
	cwd: string,
): ZellijRuntimeContext | null {
	try {
		zellijRuntimeContext = discoverZellijRuntimeContext(cwd);
		zellijRuntimeError = null;
		return zellijRuntimeContext;
	} catch (error) {
		zellijRuntimeContext = null;
		zellijRuntimeError = error instanceof Error ? error.message : String(error);
		return null;
	}
}

export function resetZellijRuntimeContext(): void {
	zellijRuntimeContext = null;
	zellijRuntimeError = null;
}

// Fake Zellij tests do not have a real session server to discover. Seeding the
// same runtime contract keeps those tests focused on placement and I/O behavior.
export function setZellijRuntimeContextForTests(
	context: ZellijRuntimeContext,
): void {
	zellijRuntimeContext = context;
	zellijRuntimeError = null;
}

export function getZellijRuntimeError(): string | null {
	return zellijRuntimeError;
}

export function requireZellijRuntimeContext(): ZellijRuntimeContext {
	if (zellijRuntimeContext) return zellijRuntimeContext;
	// Failing here is safer than silently sending pane operations to whichever
	// session the inherited environment happens to name.
	throw new Error(
		zellijRuntimeError ??
			"Zellij runtime was not initialized during Pi session startup.",
	);
}

function hasCommand(command: string): boolean {
	return defaultMuxRuntimeProbe.hasCommand(command);
}

function muxPreference(): MuxBackend | null {
	const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
	if (
		pref === "cmux" ||
		pref === "tmux" ||
		pref === "zellij" ||
		pref === "wezterm" ||
		pref === "herdr"
	) {
		return pref;
	}
	return null;
}

function isCmuxRuntimeAvailable(): boolean {
	return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

function isTmuxRuntimeAvailable(): boolean {
	return !!process.env.TMUX && hasCommand("tmux");
}

function isZellijRuntimeAvailable(): boolean {
	return (
		!!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) &&
		hasCommand("zellij")
	);
}

function isWezTermRuntimeAvailable(): boolean {
	return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
}

function isHerdrMuxRuntimeAvailable(): boolean {
	return isHerdrRuntimeAvailable(hasCommand);
}

export function isCmuxAvailable(): boolean {
	return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
	return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
	return isZellijRuntimeAvailable();
}

export function isHerdrAvailable(): boolean {
	return isHerdrMuxRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
	const pref = muxPreference();
	if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
	if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
	if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
	if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;
	if (pref === "herdr") return isHerdrMuxRuntimeAvailable() ? "herdr" : null;

	if (isHerdrMuxRuntimeAvailable()) return "herdr";
	if (isCmuxRuntimeAvailable()) return "cmux";
	if (isTmuxRuntimeAvailable()) return "tmux";
	if (isZellijRuntimeAvailable()) return "zellij";
	if (isWezTermRuntimeAvailable()) return "wezterm";
	return null;
}

export function isMuxAvailable(): boolean {
	return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
	const pref = muxPreference();
	if (pref === "cmux") return "Start pi inside cmux (`cmux pi`).";
	if (pref === "tmux") {
		return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
	}
	if (pref === "zellij") {
		return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
	}
	if (pref === "wezterm") return "Start pi inside WezTerm.";
	if (pref === "herdr") return "Start pi inside Herdr (`herdr`, then run `pi`).";
	return "Start pi inside Herdr (`herdr`, then run `pi`), cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";
}

export function requireMuxBackend(): MuxBackend {
	const backend = getMuxBackend();
	if (!backend) {
		throw new Error(
			`No supported terminal multiplexer found. ${muxSetupHint()}`,
		);
	}
	return backend;
}

export function isFishShell(): boolean {
	const shell = process.env.SHELL ?? "";
	return basename(shell) === "fish";
}

export function exitStatusVar(): string {
	return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export function tailLines(text: string, lines: number): string {
	const split = text.split("\n");
	if (split.length <= lines) return text;
	return split.slice(-lines).join("\n");
}

export function zellijPaneId(surface: string): string {
	return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(
	sessionName: string,
	surface?: string,
): NodeJS.ProcessEnv {
	// Child commands may inspect ZELLIJ_SESSION_NAME themselves. Override the stale
	// inherited value so command arguments and environment describe one session.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		ZELLIJ_SESSION_NAME: sessionName,
	};
	if (surface) env.ZELLIJ_PANE_ID = zellijPaneId(surface);
	return env;
}

const ZELLIJ_PANE_SCOPED_ACTIONS = new Set([
	"close-pane",
	"dump-screen",
	"move-pane",
	"rename-pane",
	"write",
	"write-chars",
]);

function zellijActionArgs(args: string[], surface?: string): string[] {
	if (!surface || args.includes("--pane-id")) return args;
	const [action] = args;
	if (!action || !ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return args;
	return [action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}

export function getZellijActionInvocation(
	args: string[],
	surface?: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
	const runtime = requireZellijRuntimeContext();
	return {
		// Explicit targeting avoids Zellij's implicit lookup through the immutable
		// environment inherited before a session was renamed.
		args: [
			"--session",
			runtime.sessionName,
			"action",
			...zellijActionArgs(args, surface),
		],
		env: zellijEnv(runtime.sessionName, surface),
	};
}

export function zellijActionSync(args: string[], surface?: string): string {
	const invocation = getZellijActionInvocation(args, surface);
	return execFileSync(
		"zellij",
		invocation.args,
		{
			encoding: "utf8",
			env: invocation.env,
		},
	);
}

