import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zellijActionSync } from "./core.ts";

// Mirrors Zellij 0.44.x tab minimums, used to predict which pane Zellij itself
// will choose for a directionless split.
const ZELLIJ_MIN_TERMINAL_WIDTH = 5;
const ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
const ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;

// Pi subagents need more usable space than Zellij's internal minimum. These can
// be tuned per session without another code change.
const DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
const DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;

export interface ZellijPaneSnapshot {
	id: number;
	is_plugin?: boolean;
	is_floating?: boolean;
	is_selectable?: boolean;
	exited?: boolean;
	pane_rows?: number;
	pane_columns?: number;
	tab_id?: number;
	is_focused?: boolean;
}

export type ZellijSplitDirection = "down" | "right";

export type ZellijPlacementPlan =
	| {
			mode: "split";
			anchorPaneId: number;
			targetPaneId: number;
			tabId: number;
			splitDirection: ZellijSplitDirection;
	  }
	| { mode: "stack"; anchorPaneId: number; targetPaneId: number; tabId: number };

function paneArea(pane: ZellijPaneSnapshot): number {
	return (pane.pane_rows ?? 0) * (pane.pane_columns ?? 0);
}

function isUsableZellijTiledPane(pane: ZellijPaneSnapshot): boolean {
	return (
		!pane.is_plugin &&
		!pane.is_floating &&
		pane.is_selectable !== false &&
		!pane.exited &&
		typeof pane.pane_rows === "number" &&
		typeof pane.pane_columns === "number"
	);
}

export function predictZellijSplitDirection(
	pane: ZellijPaneSnapshot,
): ZellijSplitDirection | null {
	const columns = pane.pane_columns ?? 0;
	const rows = pane.pane_rows ?? 0;
	if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT)
		return null;

	if (
		rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns &&
		rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2
	) {
		return "down";
	}

	if (columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2) {
		return "right";
	}

	return null;
}

export function canSplitZellijPane(
	pane: ZellijPaneSnapshot,
	minColumns = ZELLIJ_MIN_TERMINAL_WIDTH,
	minRows = ZELLIJ_MIN_TERMINAL_HEIGHT,
): boolean {
	const columns = pane.pane_columns ?? 0;
	const rows = pane.pane_rows ?? 0;
	const direction = predictZellijSplitDirection(pane);
	if (!direction) return false;

	if (direction === "down") {
		return columns >= minColumns && Math.floor(rows / 2) >= minRows;
	}

	return rows >= minRows && Math.floor(columns / 2) >= minColumns;
}

function zellijTabPanesForParent(
	panes: ZellijPaneSnapshot[],
	parentPaneId: number,
): { parentPane: ZellijPaneSnapshot; tabPanes: ZellijPaneSnapshot[] } | null {
	const parentPane = panes.find(
		(pane) => !pane.is_plugin && pane.id === parentPaneId,
	);
	if (!parentPane || typeof parentPane.tab_id !== "number") return null;

	const tabPanes = panes
		.filter((pane) => pane.tab_id === parentPane.tab_id)
		.filter(isUsableZellijTiledPane);

	return { parentPane, tabPanes };
}

export function selectZellijStackPlacement(
	panes: ZellijPaneSnapshot[],
	parentPaneId: number,
): ZellijPlacementPlan | null {
	const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
	if (!tabInfo) return null;

	const stackTarget = tabInfo.tabPanes
		.filter((pane) => pane.id !== parentPaneId)
		.sort((a, b) => paneArea(b) - paneArea(a))[0];
	if (!stackTarget) return null;

	return {
		mode: "stack",
		anchorPaneId: stackTarget.id,
		targetPaneId: stackTarget.id,
		tabId: tabInfo.parentPane.tab_id!,
	};
}

export function selectZellijPlacement(
	panes: ZellijPaneSnapshot[],
	parentPaneId: number,
	minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
	minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
): ZellijPlacementPlan | null {
	const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
	if (!tabInfo) return null;

	const zellijSplitCandidates = tabInfo.tabPanes
		.map((pane) => ({
			pane,
			splitDirection: predictZellijSplitDirection(pane),
		}))
		.filter(
			(
				candidate,
			): candidate is {
				pane: ZellijPaneSnapshot;
				splitDirection: ZellijSplitDirection;
			} =>
				candidate.splitDirection !== null &&
				canSplitZellijPane(
					candidate.pane,
					ZELLIJ_MIN_TERMINAL_WIDTH,
					ZELLIJ_MIN_TERMINAL_HEIGHT,
				),
		);

	const safeSplitCandidates = zellijSplitCandidates.filter((candidate) =>
		canSplitZellijPane(candidate.pane, minColumns, minRows),
	);

	// Split creation is tab-scoped and Zellij chooses the concrete split pane
	// and direction. Zellij 0.44 can choose a different direction than this
	// predictor for narrow-but-tall panes, so only split when both possible
	// directions would leave the child pane usable.
	const directionAgnosticSafeSplitCandidates = safeSplitCandidates.filter(
		(candidate) =>
			Math.floor((candidate.pane.pane_columns ?? 0) / 2) >= minColumns &&
			Math.floor((candidate.pane.pane_rows ?? 0) / 2) >= minRows,
	);

	if (
		zellijSplitCandidates.length > 0 &&
		directionAgnosticSafeSplitCandidates.length === zellijSplitCandidates.length
	) {
		const splitTarget = directionAgnosticSafeSplitCandidates.sort(
			(a, b) => paneArea(b.pane) - paneArea(a.pane),
		)[0];
		return {
			mode: "split",
			anchorPaneId: splitTarget.pane.id,
			targetPaneId: splitTarget.pane.id,
			tabId: tabInfo.parentPane.tab_id!,
			splitDirection: splitTarget.splitDirection,
		};
	}

	return selectZellijStackPlacement(panes, parentPaneId);
}

function parseZellijPaneSurface(rawId: string, context: string): string {
	const idMatch = rawId.match(/(\d+)/);
	if (!idMatch) {
		throw new Error(
			`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`,
		);
	}
	return `pane:${idMatch[1]}`;
}

function readZellijPanes(): ZellijPaneSnapshot[] {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const output = zellijActionSync([
				"list-panes",
				"--json",
				"--geometry",
				"--state",
				"--tab",
			]);
			if (!output.trim()) {
				throw new Error(
					"Unexpected zellij list-panes output: empty",
				);
			}
			const parsed = JSON.parse(output);
			if (!Array.isArray(parsed)) {
				throw new Error(
					"Unexpected zellij list-panes output: not an array",
				);
			}
			return parsed as ZellijPaneSnapshot[];
		} catch (error) {
			lastError = error;
			if (attempt < 2) sleepSync(50);
		}
	}
	throw lastError;
}

function createZellijTiledPane(name: string, tabId: number): string {
	const args = [
		"new-pane",
		"--tab-id",
		String(tabId),
		"--name",
		name,
		"--cwd",
		process.cwd(),
	];
	return parseZellijPaneSurface(zellijActionSync(args).trim(), "new-pane");
}

function createZellijStackedPane(name: string, anchorSurface: string): string {
	const args = [
		"new-pane",
		"--stacked",
		"--near-current-pane",
		"--name",
		name,
		"--cwd",
		process.cwd(),
	];
	return parseZellijPaneSurface(
		zellijActionSync(args, anchorSurface).trim(),
		"new-pane --stacked",
	);
}

function createZellijTab(name: string): string {
	const tabIdRaw = zellijActionSync([
		"new-tab",
		"--name",
		name,
		"--cwd",
		process.cwd(),
	]).trim();
	const tabId = Number(tabIdRaw);
	if (!Number.isInteger(tabId)) {
		throw new Error(
			`Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`,
		);
	}

	try {
		const panes = readZellijPanes();
		const pane = panes.find(
			(candidate) =>
				candidate.tab_id === tabId &&
				isUsableZellijTiledPane(candidate) &&
				typeof candidate.id === "number",
		);
		if (!pane) {
			throw new Error(
				`Could not find initial pane for zellij tab ${tabId}`,
			);
		}

		const surface = `pane:${pane.id}`;
		try {
			zellijActionSync(["rename-pane", name], surface);
		} catch {
			// Optional.
		}
		return surface;
	} catch (error) {
		try {
			zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
		} catch {
			// Best effort cleanup for tabs created before post-creation inspection failed.
		}
		throw error;
	}
}

function envPositiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function zellijSurfaceLockPath(): string {
	const session = (
		process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default"
	).replace(/[^A-Za-z0-9_.-]/g, "_");
	return join(tmpdir(), `pi-zellij-surface-${session}.lock`);
}

function withZellijSurfaceLock<T>(callback: () => T): T {
	const lockPath = zellijSurfaceLockPath();
	const deadline = Date.now() + 10000;

	while (true) {
		try {
			mkdirSync(lockPath);
			writeFileSync(join(lockPath, "owner"), `${process.pid}\n`);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;

			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {}

			if (Date.now() > deadline) {
				throw new Error(
					`Timed out waiting for zellij surface lock: ${lockPath}`,
				);
			}
			sleepSync(50);
		}
	}

	try {
		return callback();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

function createZellijSurfaceUnlocked(name: string): string {
	const parentPaneIdRaw = process.env.ZELLIJ_PANE_ID;
	const parentPaneId = parentPaneIdRaw ? Number(parentPaneIdRaw) : NaN;
	const minColumns = envPositiveInteger(
		"PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
		DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
	);
	const minRows = envPositiveInteger(
		"PI_SUBAGENT_ZELLIJ_MIN_ROWS",
		DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
	);

	const plan = Number.isInteger(parentPaneId)
		? selectZellijPlacement(
				readZellijPanes(),
				parentPaneId,
				minColumns,
				minRows,
			)
		: null;

	if (plan?.mode === "split") {
		return createZellijTiledPane(name, plan.tabId);
	}

	if (plan?.mode === "stack") {
		return createZellijStackedPane(name, `pane:${plan.targetPaneId}`);
	}

	return createZellijTab(name);
}

export function createZellijSurface(name: string): string {
	return withZellijSurfaceLock(() => createZellijSurfaceUnlocked(name));
}
