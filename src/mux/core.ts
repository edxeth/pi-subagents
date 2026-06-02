import { execFile, execFileSync } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

export const execFileAsync = promisify(execFile);

export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm";

function hasCommand(command: string): boolean {
	return defaultMuxRuntimeProbe.hasCommand(command);
}

function muxPreference(): MuxBackend | null {
	const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
	if (
		pref === "cmux" ||
		pref === "tmux" ||
		pref === "zellij" ||
		pref === "wezterm"
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

export function isCmuxAvailable(): boolean {
	return isCmuxRuntimeAvailable();
}

export function isTmuxAvailable(): boolean {
	return isTmuxRuntimeAvailable();
}

export function isZellijAvailable(): boolean {
	return isZellijRuntimeAvailable();
}

export function getMuxBackend(): MuxBackend | null {
	const pref = muxPreference();
	if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
	if (pref === "tmux") return isTmuxRuntimeAvailable() ? "tmux" : null;
	if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;
	if (pref === "wezterm") return isWezTermRuntimeAvailable() ? "wezterm" : null;

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
	return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), or WezTerm.";
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

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
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

export function zellijActionSync(args: string[], surface?: string): string {
	return execFileSync(
		"zellij",
		["action", ...zellijActionArgs(args, surface)],
		{
			encoding: "utf8",
			env: zellijEnv(surface),
		},
	);
}

