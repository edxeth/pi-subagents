#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireLiveWindowLock } from "./live-test-guard.mjs";

const SCRIPT_NAME = "test-live-herdr-mux";
const OPT_IN_ENV = "PI_SUBAGENT_ALLOW_LIVE_WINDOWS";
const HERDR_TIMEOUT_MS = 10_000;
const INNER_RESULT_TIMEOUT_MS = 45_000;
const SCREEN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function trimForError(text) {
	const trimmed = String(text ?? "").trim();
	return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runHerdrRaw(args, options = {}) {
	return execFileSync("herdr", args, {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: HERDR_TIMEOUT_MS,
		...options,
	});
}

function runHerdrQuiet(args) {
	try {
		execFileSync("herdr", args, {
			cwd: repoRoot,
			stdio: "ignore",
			timeout: HERDR_TIMEOUT_MS,
		});
	} catch {}
}

function parseHerdrJson(operation, output) {
	try {
		return JSON.parse(output);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`herdr ${operation} returned malformed JSON: ${message}; output: ${trimForError(output) || "(empty)"}`,
		);
	}
}

function runHerdrJson(operation, args, options = {}) {
	const output = runHerdrRaw(args, options);
	const parsed = parseHerdrJson(operation, output);
	if (parsed && typeof parsed === "object" && "error" in parsed) {
		const error = parsed.error;
		const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
		const message =
			error && typeof error === "object" && typeof error.message === "string" ? error.message : trimForError(output);
		throw new Error(`herdr ${operation} failed: ${code}: ${message}`);
	}
	return parsed;
}

function herdrResult(operation, args) {
	const envelope = runHerdrJson(operation, args);
	if (!envelope || typeof envelope !== "object" || !envelope.result || typeof envelope.result !== "object") {
		throw new Error(`herdr ${operation} returned malformed API envelope`);
	}
	return envelope.result;
}

function paneFromResult(operation, args) {
	const result = herdrResult(operation, args);
	const pane = result.pane;
	if (!pane || typeof pane !== "object" || typeof pane.pane_id !== "string") {
		throw new Error(`herdr ${operation} returned no pane_id`);
	}
	return pane;
}

function workspaceFromResult(operation, args) {
	const result = herdrResult(operation, args);
	const workspace = result.workspace;
	if (!workspace || typeof workspace !== "object" || typeof workspace.workspace_id !== "string") {
		throw new Error(`herdr ${operation} returned no workspace_id`);
	}
	return workspace;
}

function listTabs() {
	const result = herdrResult("tab list", ["tab", "list"]);
	return Array.isArray(result.tabs) ? result.tabs : [];
}

function closePaneQuiet(paneId) {
	if (!paneId) return;
	runHerdrQuiet(["pane", "close", paneId]);
}

function closeTabQuiet(tabId) {
	if (!tabId) return;
	runHerdrQuiet(["tab", "close", tabId]);
}

function restoreWorkspaceQuiet(workspaceId, label) {
	if (!workspaceId || !label) return;
	try {
		herdrResult("workspace rename", ["workspace", "rename", workspaceId, label]);
	} catch {}
}

function sweepMarkedTabs(marker) {
	for (const tab of listTabs()) {
		if (typeof tab?.label === "string" && tab.label.includes(marker) && typeof tab.tab_id === "string") {
			closeTabQuiet(tab.tab_id);
		}
	}
}

function requireCompatibleHerdrServer() {
	let status;
	try {
		status = runHerdrJson("status server", ["status", "server", "--json"]);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new Error("herdr is not on PATH");
		}
		throw error;
	}

	if (!status || typeof status !== "object") {
		throw new Error("herdr status server returned a non-object status");
	}
	if (status.running !== true) {
		throw new Error(`herdr server is not running: ${JSON.stringify(status)}`);
	}
	if (status.compatible !== true) {
		throw new Error(`herdr server protocol is not compatible: ${JSON.stringify(status)}`);
	}
	return status;
}

async function waitForResultFile(resultPath, parentPaneId) {
	const deadline = Date.now() + INNER_RESULT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(resultPath)) {
			return JSON.parse(readFileSync(resultPath, "utf8"));
		}
		await sleep(POLL_INTERVAL_MS);
	}

	let parentScreen = "";
	try {
		parentScreen = runHerdrRaw([
			"pane",
			"read",
			parentPaneId,
			"--source",
			"recent",
			"--lines",
			"80",
			"--format",
			"text",
		]);
	} catch (error) {
		parentScreen = error instanceof Error ? error.message : String(error);
	}

	throw new Error(
		`Timed out waiting for inner Herdr mux smoke result at ${resultPath}. Parent pane output:\n${trimForError(parentScreen)}`,
	);
}

function writeInnerResult(payload) {
	const resultPath = process.env.PI_SUBAGENT_HERDR_SMOKE_RESULT;
	if (!resultPath) throw new Error("PI_SUBAGENT_HERDR_SMOKE_RESULT is not set");
	writeFileSync(resultPath, JSON.stringify(payload, null, 2), "utf8");
}

async function waitForScreen(readFn, paneId, needle) {
	const deadline = Date.now() + SCREEN_TIMEOUT_MS;
	let lastScreen = "";
	while (Date.now() < deadline) {
		lastScreen = await readFn(paneId, 120);
		if (lastScreen.includes(needle)) return lastScreen;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out waiting for ${needle} in Herdr pane ${paneId}. Last screen:\n${trimForError(lastScreen)}`);
}

async function runInner() {
	const marker = process.env.PI_SUBAGENT_HERDR_SMOKE_MARKER;
	if (!marker) throw new Error("PI_SUBAGENT_HERDR_SMOKE_MARKER is not set");

	const {
		closeSurface,
		createSurface,
		createSurfaceSplit,
		readScreen,
		readScreenAsync,
		renameCurrentTab,
		renameWorkspace,
		sendCommand,
		sendShellCommand,
	} = await import("../src/mux.ts");
	const { getHerdrCurrentPane, getHerdrTab, getHerdrWorkspace } = await import("../src/mux/herdr.ts");

	let childPaneId = "";
	let childTabId = "";
	let splitPaneId = "";
	let overflowPaneId = "";
	let overflowTabId = "";
	let workspaceId = "";
	let originalWorkspaceLabel = "";

	try {
		if (process.env.PI_SUBAGENT_MUX !== "herdr") {
			throw new Error("PI_SUBAGENT_MUX was not forced to herdr in the inner smoke pane");
		}

		const parentPane = getHerdrCurrentPane();
		if (!parentPane.paneId || !parentPane.tabId || !parentPane.workspaceId) {
			throw new Error(`Current Herdr pane metadata was incomplete: ${JSON.stringify(parentPane)}`);
		}
		workspaceId = parentPane.workspaceId;
		const workspaceBefore = getHerdrWorkspace(workspaceId);
		originalWorkspaceLabel = workspaceBefore.label ?? "";

		const renamedTabLabel = `${marker} parent renamed`;
		renameCurrentTab(renamedTabLabel);
		const parentTabAfterRename = getHerdrTab(parentPane.tabId);
		if (parentTabAfterRename.label !== renamedTabLabel) {
			throw new Error(`Expected parent tab label ${renamedTabLabel}, got ${parentTabAfterRename.label ?? "(missing)"}`);
		}

		let workspaceRenameVerified = false;
		if (originalWorkspaceLabel) {
			const renamedWorkspaceLabel = `${marker} workspace renamed`;
			renameWorkspace(renamedWorkspaceLabel);
			const workspaceAfterRename = getHerdrWorkspace(workspaceId);
			if (workspaceAfterRename.label !== renamedWorkspaceLabel) {
				throw new Error(
					`Expected workspace label ${renamedWorkspaceLabel}, got ${workspaceAfterRename.label ?? "(missing)"}`,
				);
			}
			renameWorkspace(originalWorkspaceLabel);
			const workspaceAfterRestore = getHerdrWorkspace(workspaceId);
			if (workspaceAfterRestore.label !== originalWorkspaceLabel) {
				throw new Error(
					`Expected restored workspace label ${originalWorkspaceLabel}, got ${workspaceAfterRestore.label ?? "(missing)"}`,
				);
			}
			workspaceRenameVerified = true;
		}

		childPaneId = await createSurface(`${marker} child`);
		const childPane = paneFromResult("pane get", ["pane", "get", childPaneId]);
		childTabId = childPane.tab_id;
		if (!childTabId || childTabId !== parentPane.tabId) {
			throw new Error(
				`Expected default Herdr auto placement to keep the child in parent tab ${parentPane.tabId}; child pane: ${JSON.stringify(childPane)}`,
			);
		}
		if (childPane.workspace_id !== workspaceId) {
			throw new Error(`Expected child workspace ${workspaceId}, got ${childPane.workspace_id ?? "(missing)"}`);
		}
		const childTitle = childPane.label ?? childPane.terminal_title_stripped ?? childPane.terminal_title ?? "";
		if (!childTitle.includes(marker)) {
			throw new Error(`Expected child pane title to include ${marker}, got ${childTitle || "(missing)"}`);
		}

		splitPaneId = createSurfaceSplit(`${marker} split`, "right", childPaneId);
		const splitPane = paneFromResult("pane get", ["pane", "get", splitPaneId]);
		if (splitPane.tab_id !== childTabId) {
			throw new Error(
				`Expected explicit Herdr split to stay in child tab ${childTabId}, got ${splitPane.tab_id ?? "(missing)"}`,
			);
		}
		if (splitPane.workspace_id !== workspaceId) {
			throw new Error(`Expected split workspace ${workspaceId}, got ${splitPane.workspace_id ?? "(missing)"}`);
		}

		process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS = "100000";
		overflowPaneId = await createSurface(`${marker} overflow`);
		delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS;
		const overflowPane = paneFromResult("pane get", ["pane", "get", overflowPaneId]);
		overflowTabId = overflowPane.tab_id ?? "";
		if (!overflowTabId || overflowTabId === parentPane.tabId) {
			throw new Error(`Expected unsafe auto placement to use a dedicated tab: ${JSON.stringify(overflowPane)}`);
		}
		closeSurface(overflowPaneId);
		overflowPaneId = "";

		const shortToken = marker.split("-").at(-1) ?? String(Date.now());
		const commandNeedle = `cmd-${shortToken}`;
		const shellNeedle = `sh-${shortToken}`;
		sendCommand(childPaneId, `printf '${commandNeedle}\\n'`);
		const syncScreen = await waitForScreen(
			(pane, lines) => Promise.resolve(readScreen(pane, lines)),
			childPaneId,
			commandNeedle,
		);
		sendCommand(childPaneId, "");
		sendShellCommand(childPaneId, `printf '${shellNeedle}\\n'`);
		const asyncScreen = await waitForScreen(readScreenAsync, childPaneId, shellNeedle);

		if (!syncScreen.includes(commandNeedle) || !asyncScreen.includes(shellNeedle)) {
			throw new Error("Herdr screen reads did not include the sent command markers");
		}

		closeSurface(splitPaneId);
		splitPaneId = "";
		closeSurface(childPaneId);
		closeSurface(childPaneId);

		writeInnerResult({
			status: "ok",
			marker,
			parentPaneId: parentPane.paneId,
			parentTabId: parentPane.tabId,
			workspaceId,
			childPaneId,
			childTabId,
			splitPaneVerified: true,
			sameTabPlacementVerified: childTabId === parentPane.tabId,
			smallWindowFallbackVerified: overflowTabId !== parentPane.tabId,
			commandReadVerified: syncScreen.includes(commandNeedle),
			asyncReadVerified: asyncScreen.includes(shellNeedle),
			titleRenameVerified: true,
			workspaceRenameVerified,
			closeCleanupVerified: true,
		});
	} catch (error) {
		if (originalWorkspaceLabel) restoreWorkspaceQuiet(workspaceId, originalWorkspaceLabel);
		delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS;
		if (overflowPaneId) closePaneQuiet(overflowPaneId);
		if (splitPaneId) closePaneQuiet(splitPaneId);
		if (childPaneId) closePaneQuiet(childPaneId);
		writeInnerResult({
			status: "error",
			marker,
			childPaneId,
			childTabId,
			error: error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
		process.exitCode = 1;
	}
}

async function runOuter() {
	if (process.env[OPT_IN_ENV] !== "1") {
		console.log(
			`SKIP ${SCRIPT_NAME}: set ${OPT_IN_ENV}=1 to run the real live Herdr mux smoke. No Herdr panes or tabs were created.`,
		);
		return;
	}

	const releaseLock = acquireLiveWindowLock(SCRIPT_NAME);
	const marker = `pi-subagents-herdr-mux-smoke-${Date.now()}-${process.pid}`;
	const tmpRoot = mkdtempSync(`${tmpdir()}/pi-herdr-mux-smoke-`);
	const resultPath = resolve(tmpRoot, "result.json");
	let parentPaneId = "";
	let parentTabId = "";
	let workspaceId = "";
	let originalWorkspaceLabel = "";

	try {
		const status = requireCompatibleHerdrServer();
		const created = herdrResult("tab create", [
			"tab",
			"create",
			"--cwd",
			repoRoot,
			"--label",
			`${marker} parent`,
			"--no-focus",
		]);
		const parentPane = created.root_pane ?? created.pane;
		const parentTab = created.tab;
		if (!parentPane || typeof parentPane.pane_id !== "string") {
			throw new Error(`herdr tab create did not return a parent root pane: ${JSON.stringify(created)}`);
		}
		if (!parentTab || typeof parentTab.tab_id !== "string") {
			throw new Error(`herdr tab create did not return a parent tab: ${JSON.stringify(created)}`);
		}
		parentPaneId = parentPane.pane_id;
		parentTabId = parentTab.tab_id;
		workspaceId = parentPane.workspace_id || parentTab.workspace_id || "";
		if (workspaceId) {
			const workspace = workspaceFromResult("workspace get", ["workspace", "get", workspaceId]);
			originalWorkspaceLabel = workspace.label ?? "";
		}

		await sleep(500);
		const innerEnv = [
			`${OPT_IN_ENV}=1`,
			"PI_SUBAGENT_MUX=herdr",
			"PI_SUBAGENT_HERDR_MIN_COLUMNS=1",
			"PI_SUBAGENT_HERDR_MIN_ROWS=1",
			`PI_SUBAGENT_HERDR_SMOKE_MARKER=${shellQuote(marker)}`,
			`PI_SUBAGENT_HERDR_SMOKE_RESULT=${shellQuote(resultPath)}`,
		].join(" ");
		const innerCommand = `cd ${shellQuote(repoRoot)} && ${innerEnv} node ${shellQuote(__filename)} --inner`;
		runHerdrRaw(["pane", "run", parentPaneId, innerCommand]);

		const result = await waitForResultFile(resultPath, parentPaneId);
		if (result.status !== "ok") {
			throw new Error(`Inner Herdr mux smoke failed: ${JSON.stringify(result, null, 2)}`);
		}
		if (result.parentTabId !== parentTabId) {
			throw new Error(`Inner smoke ran in unexpected parent tab ${result.parentTabId}; expected ${parentTabId}`);
		}
		if (result.sameTabPlacementVerified !== true || result.childTabId !== parentTabId) {
			throw new Error(`Herdr createSurface did not prove same-tab auto placement: ${JSON.stringify(result, null, 2)}`);
		}
		if (
			!result.smallWindowFallbackVerified ||
			!result.commandReadVerified ||
			!result.asyncReadVerified ||
			!result.titleRenameVerified ||
			!result.closeCleanupVerified ||
			!result.splitPaneVerified
		) {
			throw new Error(`Herdr mux live smoke did not verify all required behavior: ${JSON.stringify(result, null, 2)}`);
		}

		console.log(
			JSON.stringify(
				{
					status: "passed",
					script: SCRIPT_NAME,
					herdr: {
						version: status.version,
						protocol: status.protocol,
						compatible: status.compatible,
					},
					parentPaneId: result.parentPaneId,
					parentTabId: result.parentTabId,
					childPaneId: result.childPaneId,
					childTabId: result.childTabId,
					sameTabPlacementVerified: result.sameTabPlacementVerified,
					smallWindowFallbackVerified: result.smallWindowFallbackVerified,
					splitPaneVerified: result.splitPaneVerified,
					commandReadVerified: result.commandReadVerified,
					asyncReadVerified: result.asyncReadVerified,
					titleRenameVerified: result.titleRenameVerified,
					workspaceRenameVerified: result.workspaceRenameVerified,
					closeCleanupVerified: result.closeCleanupVerified,
				},
				null,
				2,
			),
		);
	} finally {
		restoreWorkspaceQuiet(workspaceId, originalWorkspaceLabel);
		sweepMarkedTabs(marker);
		closeTabQuiet(parentTabId);
		closePaneQuiet(parentPaneId);
		releaseLock();
		if (process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1") {
			console.error(`kept temp dir: ${tmpRoot}`);
		} else {
			rmSync(tmpRoot, { recursive: true, force: true });
		}
	}
}

if (process.argv.includes("--inner")) {
	await runInner();
} else {
	await runOuter();
}
