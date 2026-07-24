import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { defaultMuxRuntimeProbe } from "./runtime-probe.ts";

export type HerdrServerStatus = {
	status?: string;
	running: boolean;
	compatible: boolean;
	protocol?: number;
	version?: string;
	capabilities?: Record<string, unknown>;
};

export type HerdrPane = {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
	terminalId?: string;
	cwd?: string;
	foregroundCwd?: string;
	focused?: boolean;
};

export type HerdrPaneRect = {
	paneId: string;
	x: number;
	y: number;
	width: number;
	height: number;
	focused?: boolean;
};

export type HerdrPaneLayout = {
	area: Omit<HerdrPaneRect, "paneId" | "focused">;
	panes: HerdrPaneRect[];
	tabId?: string;
	workspaceId?: string;
};

export type HerdrTab = {
	tabId: string;
	workspaceId?: string;
	label?: string;
	focused?: boolean;
	paneCount?: number;
};

export type HerdrWorkspace = {
	workspaceId: string;
	activeTabId?: string;
	label?: string;
	focused?: boolean;
	tabCount?: number;
	paneCount?: number;
};

export type HerdrCreatedTabSurface = {
	tab: HerdrTab;
	pane: HerdrPane;
};

type HerdrProcessResult = ReturnType<typeof spawnSync>;
type HerdrExecError = Error & {
	code?: number | string;
	signal?: NodeJS.Signals | string;
	stdout?: string | Buffer;
	stderr?: string | Buffer;
};

const execFileAsync = promisify(execFile);

class HerdrCommandError extends Error {
	readonly operation: string;
	readonly code?: string;

	constructor(operation: string, message: string, code?: string) {
		super(message);
		this.name = "HerdrCommandError";
		this.operation = operation;
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringField(
	record: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
	record: Record<string, unknown>,
	field: string,
): number | undefined {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function booleanField(
	record: Record<string, unknown>,
	field: string,
): boolean | undefined {
	const value = record[field];
	return typeof value === "boolean" ? value : undefined;
}

function trimForError(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 300) return trimmed;
	return `${trimmed.slice(0, 300)}…`;
}

function getOutput(result: HerdrProcessResult): string {
	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	const stderr = typeof result.stderr === "string" ? result.stderr : "";
	return stdout.trim() || stderr.trim();
}

function outputText(value: string | Buffer | undefined): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}

function parseHerdrJson(operation: string, output: string): unknown {
	try {
		return JSON.parse(output);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Herdr ${operation} returned malformed JSON: ${message}; output: ${trimForError(output) || "(empty)"}`,
		);
	}
}

function formatHerdrApiError(
	operation: string,
	error: unknown,
	fallback: string,
): HerdrCommandError {
	if (!isRecord(error)) {
		return new HerdrCommandError(
			operation,
			`Herdr ${operation} failed: ${fallback}`,
		);
	}
	const code = stringField(error, "code");
	const message = stringField(error, "message");
	if (code && message) {
		return new HerdrCommandError(
			operation,
			`Herdr ${operation} failed: ${code}: ${message}`,
			code,
		);
	}
	if (message) {
		return new HerdrCommandError(
			operation,
			`Herdr ${operation} failed: ${message}`,
			code,
		);
	}
	if (code) {
		return new HerdrCommandError(
			operation,
			`Herdr ${operation} failed: ${code}`,
			code,
		);
	}
	return new HerdrCommandError(
		operation,
		`Herdr ${operation} failed: ${fallback}`,
	);
}

function runHerdrJson(operation: string, args: string[]): unknown {
	const result = spawnSync("herdr", args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(
			`Herdr ${operation} failed to start: ${result.error.message}`,
		);
	}

	const output = getOutput(result);
	if (!output) {
		throw new Error(`Herdr ${operation} returned no JSON output`);
	}

	let parsed: unknown;
	try {
		parsed = parseHerdrJson(operation, output);
	} catch (error) {
		if (result.status && result.status !== 0) {
			throw new Error(
				`Herdr ${operation} failed with exit code ${result.status}: ${trimForError(output)}`,
			);
		}
		throw error;
	}

	if (isRecord(parsed) && "error" in parsed) {
		throw formatHerdrApiError(operation, parsed.error, trimForError(output));
	}

	if (result.status && result.status !== 0) {
		throw new Error(
			`Herdr ${operation} failed with exit code ${result.status}: ${trimForError(output)}`,
		);
	}

	return parsed;
}

function runHerdrApi(operation: string, args: string[]): Record<string, unknown> {
	const envelope = runHerdrJson(operation, args);
	if (!isRecord(envelope)) {
		throw new Error(`Herdr ${operation} returned malformed API envelope`);
	}
	const result = envelope.result;
	if (!isRecord(result)) {
		throw new Error(`Herdr ${operation} returned malformed API envelope: missing result`);
	}
	return result;
}

function runHerdrText(operation: string, args: string[]): string {
	const result = spawnSync("herdr", args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(
			`Herdr ${operation} failed to start: ${result.error.message}`,
		);
	}
	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(
			`Herdr ${operation} failed with exit code ${result.status}: ${trimForError(getOutput(result))}`,
		);
	}
	return typeof result.stdout === "string" ? result.stdout : "";
}

function runHerdrVoid(operation: string, args: string[]): void {
	// Herdr void commands such as pane run/send report success with exit code 0 and empty stdout.
	// Structured JSON output is optional here and exists only on failures or future CLI variants.
	const result = spawnSync("herdr", args, { encoding: "utf8" });
	if (result.error) {
		throw new Error(
			`Herdr ${operation} failed to start: ${result.error.message}`,
		);
	}

	const output = getOutput(result);
	if (output) {
		let parsed: unknown;
		try {
			parsed = parseHerdrJson(operation, output);
		} catch (error) {
			if (result.status && result.status !== 0) {
				throw new Error(
					`Herdr ${operation} failed with exit code ${result.status}: ${trimForError(output)}`,
				);
			}
			throw error;
		}
		if (isRecord(parsed) && "error" in parsed) {
			throw formatHerdrApiError(operation, parsed.error, trimForError(output));
		}
	}

	if (typeof result.status === "number" && result.status !== 0) {
		throw new Error(
			`Herdr ${operation} failed with exit code ${result.status}: ${trimForError(output) || "(empty)"}`,
		);
	}
}

async function runHerdrTextAsync(
	operation: string,
	args: string[],
): Promise<string> {
	try {
		const { stdout } = await execFileAsync("herdr", args, {
			encoding: "utf8",
		});
		return outputText(stdout);
	} catch (error) {
		const execError = error as HerdrExecError;
		if (execError.code === "ENOENT") {
			throw new Error(
				`Herdr ${operation} failed to start: ${execError.message}`,
			);
		}
		const output =
			outputText(execError.stdout).trim() ||
			outputText(execError.stderr).trim() ||
			execError.message;
		throw new Error(`Herdr ${operation} failed: ${trimForError(output)}`);
	}
}

function parsePane(value: unknown, operation: string): HerdrPane {
	if (!isRecord(value)) {
		throw new Error(`Herdr ${operation} returned malformed pane record`);
	}
	const paneId = stringField(value, "pane_id");
	if (!paneId) {
		throw new Error(`Herdr ${operation} returned pane without pane_id`);
	}
	return {
		paneId,
		tabId: stringField(value, "tab_id"),
		workspaceId: stringField(value, "workspace_id"),
		terminalId: stringField(value, "terminal_id"),
		cwd: stringField(value, "cwd"),
		foregroundCwd: stringField(value, "foreground_cwd"),
		focused: booleanField(value, "focused"),
	};
}

function parsePaneLayout(value: unknown, operation: string): HerdrPaneLayout {
	if (!isRecord(value) || !isRecord(value.area) || !Array.isArray(value.panes)) {
		throw new Error(`Herdr ${operation} returned malformed pane layout`);
	}
	const rect = (record: Record<string, unknown>, context: string) => {
		const x = numberField(record, "x");
		const y = numberField(record, "y");
		const width = numberField(record, "width");
		const height = numberField(record, "height");
		if (x === undefined || y === undefined || width === undefined || height === undefined) {
			throw new Error(`Herdr ${operation} returned malformed ${context} rectangle`);
		}
		return { x, y, width, height };
	};
	return {
		area: rect(value.area, "layout"),
		panes: value.panes.map((pane) => {
			if (!isRecord(pane) || !isRecord(pane.rect)) {
				throw new Error(`Herdr ${operation} returned malformed pane layout record`);
			}
			const paneId = stringField(pane, "pane_id");
			if (!paneId) throw new Error(`Herdr ${operation} returned layout pane without pane_id`);
			return { paneId, ...rect(pane.rect, "pane"), focused: booleanField(pane, "focused") };
		}),
		tabId: stringField(value, "tab_id"),
		workspaceId: stringField(value, "workspace_id"),
	};
}

function parseTab(value: unknown, operation: string): HerdrTab {
	if (!isRecord(value)) {
		throw new Error(`Herdr ${operation} returned malformed tab record`);
	}
	const tabId = stringField(value, "tab_id");
	if (!tabId) {
		throw new Error(`Herdr ${operation} returned tab without tab_id`);
	}
	return {
		tabId,
		workspaceId: stringField(value, "workspace_id"),
		label: stringField(value, "label"),
		focused: booleanField(value, "focused"),
		paneCount: numberField(value, "pane_count"),
	};
}

function parseWorkspace(value: unknown, operation: string): HerdrWorkspace {
	if (!isRecord(value)) {
		throw new Error(`Herdr ${operation} returned malformed workspace record`);
	}
	const workspaceId = stringField(value, "workspace_id");
	if (!workspaceId) {
		throw new Error(
			`Herdr ${operation} returned workspace without workspace_id`,
		);
	}
	return {
		workspaceId,
		activeTabId: stringField(value, "active_tab_id"),
		label: stringField(value, "label"),
		focused: booleanField(value, "focused"),
		tabCount: numberField(value, "tab_count"),
		paneCount: numberField(value, "pane_count"),
	};
}

function closeHerdrTabQuiet(tabId: string): void {
	try {
		closeHerdrTab(tabId);
	} catch {}
}

function parseCreatedTabSurface(
	result: Record<string, unknown>,
	operation: string,
): HerdrCreatedTabSurface {
	const tab = parseTab(result.tab, operation);
	try {
		return {
			tab,
			pane: parsePane(result.root_pane ?? result.pane, operation),
		};
	} catch (error) {
		closeHerdrTabQuiet(tab.tabId);
		throw error;
	}
}

function parseCreatedPane(
	result: Record<string, unknown>,
	operation: string,
): HerdrPane {
	return parsePane(result.pane, operation);
}

export function getHerdrServerStatus(): HerdrServerStatus {
	const value = runHerdrJson("status server", ["status", "server", "--json"]);
	if (!isRecord(value)) {
		throw new Error("Herdr status server returned malformed status record");
	}
	return {
		status: stringField(value, "status"),
		running: booleanField(value, "running") === true,
		compatible: booleanField(value, "compatible") === true,
		protocol: numberField(value, "protocol"),
		version: stringField(value, "version"),
		capabilities: isRecord(value.capabilities) ? value.capabilities : undefined,
	};
}

export function getHerdrCurrentPane(): HerdrPane {
	const result = runHerdrApi("pane current", ["pane", "current", "--current"]);
	return parsePane(result.pane, "pane current");
}

export function getHerdrPaneLayout(paneId?: string): HerdrPaneLayout {
	const args = ["pane", "layout", paneId ? "--pane" : "--current"];
	if (paneId) args.push(paneId);
	const result = runHerdrApi("pane layout", args);
	return parsePaneLayout(result.layout, "pane layout");
}

export function getHerdrTab(tabId: string): HerdrTab {
	const result = runHerdrApi("tab get", ["tab", "get", tabId]);
	return parseTab(result.tab, "tab get");
}

export function listHerdrTabs(workspaceId?: string): HerdrTab[] {
	const args = ["tab", "list"];
	if (workspaceId) args.push("--workspace", workspaceId);
	const result = runHerdrApi("tab list", args);
	const tabs = Array.isArray(result.tabs) ? result.tabs : [];
	return tabs.map((tab) => parseTab(tab, "tab list"));
}

export function getHerdrWorkspace(workspaceId: string): HerdrWorkspace {
	const result = runHerdrApi("workspace get", ["workspace", "get", workspaceId]);
	return parseWorkspace(result.workspace, "workspace get");
}

export function createHerdrTabSurface(options: {
	label: string;
	cwd: string;
	workspaceId?: string;
	focus?: boolean;
}): HerdrCreatedTabSurface {
	const args = ["tab", "create"];
	if (options.workspaceId) args.push("--workspace", options.workspaceId);
	args.push("--cwd", options.cwd, "--label", options.label);
	args.push(options.focus ? "--focus" : "--no-focus");
	const result = runHerdrApi("tab create", args);
	return parseCreatedTabSurface(result, "tab create");
}

export function splitHerdrPane(options: {
	paneId?: string;
	direction: "right" | "down";
	ratio?: number;
	cwd: string;
	focus?: boolean;
}): HerdrPane {
	const args = ["pane", "split"];
	if (options.paneId) args.push(options.paneId);
	else args.push("--current");
	args.push("--direction", options.direction);
	if (options.ratio !== undefined) args.push("--ratio", String(options.ratio));
	args.push("--cwd", options.cwd);
	args.push(options.focus ? "--focus" : "--no-focus");
	const result = runHerdrApi("pane split", args);
	return parseCreatedPane(result, "pane split");
}

export function runHerdrPaneCommand(paneId: string, command: string): void {
	runHerdrVoid("pane run", ["pane", "run", paneId, command]);
}

export function sendHerdrPaneEnter(paneId: string): void {
	runHerdrVoid("pane send-keys", ["pane", "send-keys", paneId, "Enter"]);
}

export function readHerdrPaneScreen(paneId: string, lines: number): string {
	// Recent output supports child completion polling even after output scrolls
	// out of the visible viewport, while still honoring the caller's line limit.
	return runHerdrText("pane read", [
		"pane",
		"read",
		paneId,
		"--source",
		"recent",
		"--lines",
		String(Math.max(1, lines)),
		"--format",
		"text",
	]);
}

export function readHerdrPaneScreenAsync(
	paneId: string,
	lines: number,
): Promise<string> {
	return runHerdrTextAsync("pane read", [
		"pane",
		"read",
		paneId,
		"--source",
		"recent",
		"--lines",
		String(Math.max(1, lines)),
		"--format",
		"text",
	]);
}

function isAlreadyClosedHerdrPane(error: unknown): boolean {
	return (
		error instanceof HerdrCommandError &&
		(error.code === "pane_not_found" || error.code === "not_found")
	);
}

export function closeHerdrPane(paneId: string): void {
	try {
		runHerdrApi("pane close", ["pane", "close", paneId]);
	} catch (error) {
		if (isAlreadyClosedHerdrPane(error)) return;
		throw error;
	}
}

export function closeHerdrTab(tabId: string): void {
	runHerdrApi("tab close", ["tab", "close", tabId]);
}

export function renameHerdrPane(paneId: string, title: string): void {
	runHerdrApi("pane rename", ["pane", "rename", paneId, title]);
}

export function renameHerdrTab(tabId: string, title: string): void {
	runHerdrApi("tab rename", ["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(
	workspaceId: string,
	title: string,
): void {
	runHerdrApi("workspace rename", ["workspace", "rename", workspaceId, title]);
}

export function isHerdrRuntimeAvailable(
	hasCommand: (command: string) => boolean = (command) =>
		defaultMuxRuntimeProbe.hasCommand(command),
): boolean {
	if (!hasCommand("herdr")) return false;
	try {
		const status = getHerdrServerStatus();
		if (!status.running || !status.compatible) return false;
		getHerdrCurrentPane();
		return true;
	} catch {
		return false;
	}
}
