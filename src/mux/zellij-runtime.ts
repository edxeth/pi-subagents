import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ZELLIJ_TIMEOUT_MS = 3000;
export interface ZellijTarget {
	sessionName: string;
	parentPaneId: number;
}
interface ZellijPaneIdentity {
	id: number;
	is_plugin?: boolean;
	exited?: boolean;
	terminal_command?: string;
	pane_command?: string;
	title?: string;
}
export interface ZellijSessionIdentity {
	name: string;
	panes: ZellijPaneIdentity[];
}
function paneId(surface: string): string {
	return surface.startsWith("pane:") ? surface.slice(5) : surface;
}
function isParentPiPane(pane: ZellijPaneIdentity): boolean {
	const command = `${pane.terminal_command ?? ""} ${pane.pane_command ?? ""}`;
	return /(^|[\s/])pi(?:\s|$)/i.test(command) || /π/.test(pane.title ?? "");
}
export function resolveZellijTargetFromSessions(
	parentPaneId: number,
	sessions: ZellijSessionIdentity[],
	preferredSessionName?: string,
): ZellijTarget {
	const hasParent = (session: ZellijSessionIdentity, requirePi = false) =>
		session.panes.some(
			(pane) => pane.id === parentPaneId && !pane.is_plugin && !pane.exited && (!requirePi || isParentPiPane(pane)),
		);
	const candidates = sessions.filter((session) => hasParent(session));
	if (candidates.length === 1) return { sessionName: candidates[0].name, parentPaneId };
	const piCandidates = candidates.filter((session) => hasParent(session, true));
	if (piCandidates.length === 1) return { sessionName: piCandidates[0].name, parentPaneId };
	const preferred =
		piCandidates.find(({ name }) => name === preferredSessionName) ??
		candidates.find(({ name }) => name === preferredSessionName);
	if (preferred) return { sessionName: preferred.name, parentPaneId };
	if (candidates.length === 0) {
		throw new Error(`Could not find the live Zellij session containing parent pane ${parentPaneId}.`);
	}
	throw new Error(
		`Zellij parent pane ${parentPaneId} is ambiguous across sessions: ${candidates.map(({ name }) => name).join(", ")}.`,
	);
}
async function runZellij(args: string[], target?: ZellijTarget, surface?: string): Promise<string> {
	const env: NodeJS.ProcessEnv = target
		? {
				...process.env,
				ZELLIJ_SESSION_NAME: target.sessionName,
				...(surface ? { ZELLIJ_PANE_ID: paneId(surface) } : {}),
			}
		: { ...process.env };
	delete env.BASH_ENV;
	delete env.ENV;
	const { stdout } = await execFileAsync("zellij", args, {
		encoding: "utf8",
		timeout: ZELLIJ_TIMEOUT_MS,
		env,
	});
	return String(stdout);
}
async function listSessionNames(): Promise<string[]> {
	return (await runZellij(["list-sessions", "--no-formatting"]))
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.includes("(EXITED"))
		.map((line) => line.match(/^(.*?) \[Created\b/)?.[1] ?? line);
}
async function inspectSession(name: string): Promise<ZellijSessionIdentity> {
	const target = { sessionName: name, parentPaneId: 0 };
	const panes = JSON.parse(await runZellij(["--session", name, "action", "list-panes", "--all", "--json"], target));
	if (!Array.isArray(panes)) throw new Error(`Zellij returned an invalid pane list for session ${name}.`);
	return { name, panes };
}
export async function resolveZellijTarget(): Promise<ZellijTarget> {
	const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
	if (!Number.isInteger(parentPaneId)) throw new Error("ZELLIJ_PANE_ID is missing or invalid.");
	const before = await listSessionNames();
	const inspected = await Promise.allSettled(before.map(inspectSession));
	const failed = inspected.flatMap((result, index) => (result.status === "rejected" ? [before[index]] : []));
	if (failed.length) throw new Error(`Could not inspect active Zellij sessions: ${failed.join(", ")}.`);
	const after = await listSessionNames();
	if ([...before].sort().join("\0") !== [...after].sort().join("\0")) {
		throw new Error("Zellij sessions changed during live-session discovery.");
	}
	return resolveZellijTargetFromSessions(
		parentPaneId,
		inspected.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
		process.env.ZELLIJ_SESSION_NAME,
	);
}
const PANE_ACTIONS = new Set(["close-pane", "dump-screen", "move-pane", "rename-pane", "write", "write-chars"]);
export function runZellijAction(target: ZellijTarget, args: string[], surface?: string): Promise<string> {
	const actionArgs =
		surface && PANE_ACTIONS.has(args[0] ?? "") && !args.includes("--pane-id")
			? [args[0], "--pane-id", paneId(surface), ...args.slice(1)]
			: args;
	return runZellij(["--session", target.sessionName, "action", ...actionArgs], target, surface);
}
const SHELL_LAUNCHER = `
const { spawn } = require("node:child_process");
const shell = process.argv[1];
const args = process.argv.slice(2);
const env = { ...process.env, BASH_ENV: "", ENV: "" };
const child = spawn(shell, args, { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => { console.error(error.message); process.exit(1); });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});`;

export function getZellijShellCommand(command: string): string[] {
	const shell = (process.env.SHELL ?? "").trim();
	const name = basename(shell);
	let args: string[];
	if (name === "fish") args = ["--no-config", "-c", command];
	else if (name === "bash") args = ["--noprofile", "--norc", "-c", command];
	else if (name === "zsh") args = ["-f", "-c", command];
	else if (["sh", "dash", "ksh"].includes(name)) args = ["-c", command];
	else throw new Error(`Unsupported Zellij child shell: ${name || "unset"}.`);
	return [process.execPath, "-e", SHELL_LAUNCHER, shell, ...args];
}
export async function closeZellijSurface(surface: string, target?: ZellijTarget): Promise<void> {
	await runZellijAction(target ?? (await resolveZellijTarget()), ["close-pane"], surface);
}

export async function isZellijSurfaceLive(target: ZellijTarget, surface: string): Promise<boolean> {
	const panes = JSON.parse(await runZellijAction(target, ["list-panes", "--all", "--json"]));
	return (
		Array.isArray(panes) &&
		panes.some((pane) => !pane?.is_plugin && !pane?.exited && pane?.id === Number(paneId(surface)))
	);
}
