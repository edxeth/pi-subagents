import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { traceSubagentLaunch } from "../launch/trace.ts";
import { tailLines } from "./core.ts";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;

export type HerdrAppTerminalRef = {
	terminal: string;
	pane: string;
	tab: string;
	space: string;
};

type HerdrAppFocus = { space?: string; tab?: string; pane?: string };

class HerdrAppCommandError extends Error {
	readonly operation: string;
	readonly code?: string;

	constructor(operation: string, message: string, code?: string) {
		super(message);
		this.name = "HerdrAppCommandError";
		this.operation = operation;
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trimForError(text: string): string {
	const trimmed = text.trim();
	return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}

/** `hc` is the documented name; `herdr-core` is the long form shipped beside it. */
function hcCommand(): string {
	return defaultMuxRuntimeProbe.hasCommand("hc") ? "hc" : "herdr-core";
}

/** Errors are `{error: "msg"}` (herdr-app) or `{error: {kind, message, hint}}` (hc), on stdout or stderr. */
function failure(operation: string, stdout: string, stderr: string, fallback: string): HerdrAppCommandError {
	for (const text of [stderr, stdout]) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (!isRecord(parsed) || parsed.error === undefined) continue;
			if (typeof parsed.error === "string") {
				return new HerdrAppCommandError(operation, `Herdr app ${operation} failed: ${parsed.error}`);
			}
			if (isRecord(parsed.error)) {
				const kind = str(parsed.error, "kind");
				const message = str(parsed.error, "message") ?? kind ?? fallback;
				return new HerdrAppCommandError(operation, `Herdr app ${operation} failed: ${message}`, kind);
			}
		} catch {}
	}
	const output = stderr.trim() || stdout.trim() || fallback;
	return new HerdrAppCommandError(operation, `Herdr app ${operation} failed: ${trimForError(output)}`);
}

function runSync(operation: string, command: string, args: string[]): string {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error) {
		throw new HerdrAppCommandError(operation, `Herdr app ${operation} failed to start: ${result.error.message}`);
	}
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	if (result.status !== 0) throw failure(operation, stdout, stderr, `exit ${result.status}`);
	return stdout;
}

function parseJson(operation: string, output: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new HerdrAppCommandError(
			operation,
			`Herdr app ${operation} returned malformed JSON: ${message}; output: ${trimForError(output) || "(empty)"}`,
		);
	}
	if (!isRecord(parsed)) throw new HerdrAppCommandError(operation, `Herdr app ${operation} returned non-object JSON`);
	if (parsed.error !== undefined) throw failure(operation, output, "", "request failed");
	return parsed;
}

function runApp(operation: string, args: string[]): Record<string, unknown> {
	return parseJson(operation, runSync(operation, "herdr-app", args));
}

function runAppDo(operation: string, command: string, args: Record<string, string>): Record<string, unknown> {
	const flat = Object.entries(args).flatMap(([key, value]) => [`--${key}`, value]);
	return runApp(operation, ["do", command, ...flat]);
}

export function listHerdrAppTerminals(): HerdrAppTerminalRef[] {
	const result = runApp("ls", ["ls"]);
	const refs: HerdrAppTerminalRef[] = [];
	for (const space of Array.isArray(result.spaces) ? result.spaces : []) {
		if (!isRecord(space) || (space.machine !== null && space.machine !== undefined)) continue;
		const spaceId = str(space, "id");
		for (const tab of Array.isArray(space.tabs) ? space.tabs : []) {
			if (!isRecord(tab)) continue;
			const tabId = str(tab, "id");
			for (const terminal of Array.isArray(tab.terminals) ? tab.terminals : []) {
				if (!isRecord(terminal)) continue;
				const id = str(terminal, "terminal");
				const pane = str(terminal, "pane");
				if (id && pane && tabId && spaceId) refs.push({ terminal: id, pane, tab: tabId, space: spaceId });
			}
		}
	}
	return refs;
}

function findHerdrAppTerminal(id: string): HerdrAppTerminalRef | undefined {
	return listHerdrAppTerminals().find((ref) => ref.terminal === id);
}

export function getHerdrAppTerminalSize(id: string): { cols: number; rows: number } | null {
	const terminal = parseJson("get", runSync("get", hcCommand(), ["get", id, "--json"]));
	const { cols, rows } = terminal;
	if (typeof cols !== "number" || typeof rows !== "number" || cols <= 0 || rows <= 0) return null;
	return { cols, rows };
}

function readFocus(): HerdrAppFocus {
	const status = runApp("status", ["status"]);
	return {
		space: str(status, "space"),
		tab: str(status, "tab"),
		pane: str(status, "focused_pane"),
	};
}

function sameFocus(want: HerdrAppFocus, got: HerdrAppFocus): boolean {
	return (
		(!want.space || want.space === got.space) &&
		(!want.tab || want.tab === got.tab) &&
		(!want.pane || want.pane === got.pane)
	);
}

/** The parent's own location, used when the pre-change status read failed. */
function parentFocus(): HerdrAppFocus | undefined {
	try {
		const id = process.env.HC_TERMINAL_ID?.trim();
		const ref = id ? findHerdrAppTerminal(id) : undefined;
		return ref && { space: ref.space, tab: ref.tab, pane: ref.pane };
	} catch {
		return undefined;
	}
}

/** Run a layout change, then put the person's view back: tab.new switches the visible space and tab. */
function preservingFocus<T>(action: () => T): T {
	let before: HerdrAppFocus | undefined;
	try {
		before = readFocus();
	} catch {
		before = parentFocus();
	}
	try {
		return action();
	} finally {
		if (before) restoreFocus(before);
	}
}

/** Best effort: never throws, but re-reads status after each step and traces a restore that did not take. */
function restoreFocus(want: HerdrAppFocus): void {
	const steps: Array<[string, string, string | undefined, Record<string, string>]> = [
		["space", "space.select", want.space, { id: want.space ?? "" }],
		["tab", "tab.select", want.tab, { id: want.tab ?? "" }],
		["pane", "pane.focus", want.pane, { pane: want.pane ?? "" }],
	];
	try {
		let now = readFocus();
		for (const [field, command, target, args] of steps) {
			if (!target || now[field as keyof HerdrAppFocus] === target) continue;
			runAppDo(command, command, args);
			now = readFocus();
		}
		if (!sameFocus(want, now)) traceSubagentLaunch("herdr-app.focus-restore-failed", { want, now });
	} catch (error) {
		traceSubagentLaunch("herdr-app.focus-restore-failed", {
			want,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function splitHerdrAppPane(options: { pane: string; direction: "right" | "down" }): {
	pane: string;
	terminal: string;
} {
	const reply = preservingFocus(() =>
		runAppDo("pane.split", "pane.split", {
			direction: options.direction,
			pane: options.pane,
		}),
	);
	const pane = str(reply, "pane");
	const terminal = str(reply, "terminal");
	if (!pane || !terminal)
		throw new HerdrAppCommandError("pane.split", "Herdr app pane.split returned no pane/terminal");
	return { pane, terminal };
}

export function createHerdrAppTab(options: { space: string; folder: string; name: string }): {
	terminal: string;
	tab: string;
} {
	const reply = preservingFocus(() =>
		runAppDo("tab.new", "tab.new", {
			space: options.space,
			folder: options.folder,
			name: options.name,
		}),
	);
	const terminal = str(reply, "terminal");
	const tab = str(reply, "tab");
	if (!terminal || !tab) throw new HerdrAppCommandError("tab.new", "Herdr app tab.new returned no tab/terminal");
	return { terminal, tab };
}

export function labelHerdrAppTerminal(id: string, key: string, value: string): void {
	try {
		runSync("label", hcCommand(), ["label", id, `${key}=${value}`]);
	} catch {}
}

/** `hc send` pastes the text and presses Enter itself; empty text only presses Enter. */
export function sendHerdrAppText(id: string, text: string): void {
	if (text.length === 0) runSync("keys", hcCommand(), ["keys", id, "enter"]);
	else runSync("send", hcCommand(), ["send", id, text]);
}

export function readHerdrAppScreen(id: string, lines: number): string {
	return tailLines(runSync("read", hcCommand(), ["read", id, "--lines", "0"]), lines);
}

export async function readHerdrAppScreenAsync(id: string, lines: number): Promise<string> {
	try {
		const { stdout } = await execFileAsync(hcCommand(), ["read", id, "--lines", "0"], {
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			windowsHide: true,
		});
		return tailLines(stdout, lines);
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string; message: string };
		throw failure("read", e.stdout ?? "", e.stderr ?? "", e.message);
	}
}

function isAlreadyGone(error: unknown): boolean {
	return error instanceof HerdrAppCommandError && (error.code === "not_found" || error.code === "finished");
}

/** Killing the terminal removes its pane, and a tab it alone filled; the pane close is belt and braces. */
export function closeHerdrAppTerminal(id: string): void {
	try {
		runSync("kill", hcCommand(), ["kill", id]);
	} catch (error) {
		if (!isAlreadyGone(error)) throw error;
	}
	try {
		const left = listHerdrAppTerminals().find((ref) => ref.terminal === id);
		if (left) runAppDo("pane.close", "pane.close", { pane: left.pane });
	} catch {}
	try {
		runSync("rm", hcCommand(), ["rm", id]);
	} catch {}
}

const DETECTION_TTL_MS = 1000;
let detectionCache: { key: string; at: number; value: boolean } | undefined;

export function resetHerdrAppDetectionCache(): void {
	detectionCache = undefined;
}

/** Cached ~1s per HC_TERMINAL_ID and PATH: every mux call runs detection, and it spawns `herdr-app ls`. */
export function isHerdrAppRuntimeAvailable(hasCommand: (command: string) => boolean): boolean {
	const terminalId = process.env.HC_TERMINAL_ID?.trim();
	if (!terminalId) return false;
	const key = `${terminalId}\0${process.env.PATH ?? ""}`;
	const now = Date.now();
	if (detectionCache && detectionCache.key === key && now - detectionCache.at < DETECTION_TTL_MS) {
		return detectionCache.value;
	}
	let value = false;
	if (hasCommand("herdr-app") && (hasCommand("hc") || hasCommand("herdr-core"))) {
		try {
			value = !!findHerdrAppTerminal(terminalId);
		} catch {}
	}
	detectionCache = { key, at: now, value };
	return value;
}
