import { execFileSync, execSync } from "node:child_process";
import {
	getMuxBackend,
	requireMuxBackend,
	shellEscape,
	zellijActionSync,
} from "./core.ts";
import { createCmuxSplit, createCmuxSurface } from "./cmux-surfaces.ts";
import {
	createHerdrSplit,
	createHerdrSurface,
	renameHerdrCurrentTab,
	renameHerdrCurrentWorkspace,
} from "./herdr-surfaces.ts";
import {
	createZellijSurface,
	type ZellijPlacementContext,
} from "./zellij-placement.ts";

const DEFAULT_INTERACTIVE_MIN_COLUMNS = 50;
const DEFAULT_INTERACTIVE_MIN_ROWS = 10;

function positiveNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

// ── Surface creation ───────────────────────────────────────────────────────

export interface SurfaceCreationOptions {
	zellij?: ZellijPlacementContext;
}

export function createSurface(
	name: string,
	options?: SurfaceCreationOptions,
): string {
	const backend = getMuxBackend();

	if (backend === "cmux") {
		return createCmuxSurface(name);
	}

	if (backend === "tmux") {
		return createTmuxSurface(name);
	}

	if (backend === "wezterm") {
		return createWezTermSurface(name);
	}

	if (backend === "zellij") {
		return createZellijSurface(name, options?.zellij);
	}

	if (backend === "herdr") {
		return createHerdrSurface(name);
	}

	return createSurfaceSplit(name, "right");
}

type TmuxPlacementGeometry = {
	paneColumns: number;
	paneRows: number;
	windowColumns: number;
	windowRows: number;
	windowPanes: number;
};

type TmuxSplitPlan = {
	layout: "even-horizontal" | "even-vertical" | "tiled";
};

function readTmuxPlacementGeometry(
	pane: string | undefined,
): TmuxPlacementGeometry | null {
	if (!pane) return null;
	try {
		const output = execFileSync(
			"tmux",
			[
				"display-message",
				"-p",
				"-t",
				pane,
				"#{pane_width} #{pane_height} #{window_width} #{window_height} #{window_panes}",
			],
			{ encoding: "utf8" },
		).trim();
		const [paneColumnsRaw, paneRowsRaw, windowColumnsRaw, windowRowsRaw, windowPanesRaw] = output.split(/\s+/, 5);
		const paneColumns = positiveNumber(paneColumnsRaw);
		const paneRows = positiveNumber(paneRowsRaw);
		const windowColumns = positiveNumber(windowColumnsRaw);
		const windowRows = positiveNumber(windowRowsRaw);
		const windowPanes = positiveNumber(windowPanesRaw);
		return paneColumns && paneRows && windowColumns && windowRows && windowPanes
			? { paneColumns, paneRows, windowColumns, windowRows, windowPanes }
			: null;
	} catch {
		return null;
	}
}

function canFitTmuxTiledLayout(geometry: TmuxPlacementGeometry): boolean {
	const nextPaneCount = geometry.windowPanes + 1;
	for (let rows = 1; rows <= nextPaneCount; rows++) {
		const columns = Math.ceil(nextPaneCount / rows);
		if (
			Math.floor(geometry.windowColumns / columns) >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
			Math.floor(geometry.windowRows / rows) >= DEFAULT_INTERACTIVE_MIN_ROWS
		) {
			return true;
		}
	}
	return false;
}

function isTmuxPaneUsable(geometry: TmuxPlacementGeometry | null): boolean {
	return !!geometry && geometry.paneColumns >= DEFAULT_INTERACTIVE_MIN_COLUMNS && geometry.paneRows >= DEFAULT_INTERACTIVE_MIN_ROWS;
}

function getTmuxSplitPlan(
	geometry: TmuxPlacementGeometry | null,
): TmuxSplitPlan | null {
	if (!geometry) return null;
	const nextPaneCount = geometry.windowPanes + 1;
	if (nextPaneCount === 2) {
		if (
			Math.floor(geometry.windowColumns / 2) >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
			geometry.windowRows >= DEFAULT_INTERACTIVE_MIN_ROWS
		) {
			return { layout: "even-horizontal" };
		}
		if (
			geometry.windowColumns >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
			Math.floor(geometry.windowRows / 2) >= DEFAULT_INTERACTIVE_MIN_ROWS
		) {
			return { layout: "even-vertical" };
		}
		return null;
	}
	return canFitTmuxTiledLayout(geometry) ? { layout: "tiled" } : null;
}

function createTmuxWindow(name: string): string {
	const args = ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", name];
	args.push("-c", process.cwd());

	const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
	if (!pane.startsWith("%")) {
		throw new Error(`Unexpected tmux new-window output: ${pane}`);
	}

	return pane;
}

function createTmuxSurface(name: string): string {
	const parentPane = process.env.TMUX_PANE;
	const splitPlan = getTmuxSplitPlan(readTmuxPlacementGeometry(parentPane));
	if (splitPlan) {
		const pane = createTmuxSplit(name, "right", parentPane);
		rebalanceTmuxWindow(parentPane, splitPlan.layout);
		if (!isTmuxPaneUsable(readTmuxPlacementGeometry(pane))) {
			moveTmuxPaneToWindow(pane, name);
		}
		return pane;
	}
	return createTmuxWindow(name);
}

function rebalanceTmuxWindow(
	pane: string | undefined,
	layout: "even-horizontal" | "even-vertical" | "tiled",
): void {
	if (!pane) return;
	try {
		execFileSync("tmux", ["select-layout", "-t", pane, layout], {
			encoding: "utf8",
		});
	} catch {}
}

function moveTmuxPaneToWindow(pane: string, name: string): void {
	try {
		execFileSync("tmux", ["break-pane", "-d", "-t", pane, "-n", name], {
			encoding: "utf8",
		});
	} catch {}
}

function createTmuxSplit(
	_name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const args = ["split-window", "-d"];
	args.push(direction === "left" || direction === "right" ? "-h" : "-v");
	if (direction === "left" || direction === "up") args.push("-b");
	if (fromSurface) args.push("-t", fromSurface);
	args.push("-P", "-F", "#{pane_id}");

	const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
	if (!pane.startsWith("%")) {
		throw new Error(`Unexpected tmux split-window output: ${pane}`);
	}

	return pane;
}

function createWezTermSurface(name: string): string {
	const paneId = execFileSync(
		"wezterm",
		["cli", "spawn", "--cwd", process.cwd()],
		{ encoding: "utf8" },
	).trim();
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(
			`Unexpected wezterm spawn output: ${paneId || "(empty)"}`,
		);
	}
	try {
		execFileSync(
			"wezterm",
			["cli", "set-tab-title", "--pane-id", paneId, name],
			{ encoding: "utf8" },
		);
	} catch {}
	return paneId;
}

function createWezTermSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const args = ["cli", "split-pane"];
	if (direction === "left") args.push("--left");
	else if (direction === "right") args.push("--right");
	else if (direction === "up") args.push("--top");
	else args.push("--bottom");
	args.push("--cwd", process.cwd());
	if (fromSurface) args.push("--pane-id", fromSurface);
	const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(
			`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`,
		);
	}
	try {
		execFileSync(
			"wezterm",
			["cli", "set-tab-title", "--pane-id", paneId, name],
			{ encoding: "utf8" },
		);
	} catch {}
	return paneId;
}

function createZellijSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const directionArg =
		direction === "left" || direction === "right" ? "right" : "down";
	const args = [
		"new-pane",
		"--direction",
		directionArg,
		"--name",
		name,
		"--cwd",
		process.cwd(),
	];

	let paneOut = "";
	try {
		paneOut = zellijActionSync(args, fromSurface);
	} catch {
		if (!fromSurface) throw new Error("Failed to create zellij pane");
		paneOut = zellijActionSync(args);
	}

	const paneId = paneOut.match(/(?:terminal_)?(\d+)/)?.[1] ?? "";
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(
			`Unexpected zellij pane id: ${paneOut.trim() || "(empty)"}`,
		);
	}

	const surface = `pane:${paneId}`;
	if (direction === "left" || direction === "up") {
		try {
			zellijActionSync(["move-pane", direction], surface);
		} catch {}
	}
	try {
		zellijActionSync(["rename-pane", name], surface);
	} catch {}
	return surface;
}

export function createSurfaceSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const backend = requireMuxBackend();
	if (backend === "cmux")
		return createCmuxSplit(name, direction, fromSurface);
	if (backend === "tmux")
		return createTmuxSplit(name, direction, fromSurface);
	if (backend === "wezterm")
		return createWezTermSplit(name, direction, fromSurface);
	if (backend === "zellij")
		return createZellijSplit(name, direction, fromSurface);
	return createHerdrSplit(name, direction, fromSurface);
}

export function renameCurrentTab(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		const surfaceId = process.env.CMUX_SURFACE_ID;
		if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
		execSync(
			`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`,
			{
				encoding: "utf8",
			},
		);
		return;
	}
	if (backend === "tmux") {
		if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") return;
		const paneId = process.env.TMUX_PANE;
		if (!paneId) throw new Error("TMUX_PANE not set");
		const windowId = execFileSync(
			"tmux",
			["display-message", "-p", "-t", paneId, "#{window_id}"],
			{ encoding: "utf8" },
		).trim();
		execFileSync("tmux", ["rename-window", "-t", windowId, title], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "wezterm") {
		const paneId = process.env.WEZTERM_PANE;
		const args = ["cli", "set-tab-title"];
		if (paneId) args.push("--pane-id", paneId);
		args.push(title);
		execFileSync("wezterm", args, { encoding: "utf8" });
		return;
	}
	if (backend === "zellij") {
		const paneId = process.env.ZELLIJ_PANE_ID;
		if (paneId)
			zellijActionSync(["rename-pane", title], `pane:${paneId}`);
		else zellijActionSync(["rename-tab", title]);
		return;
	}
	if (backend === "herdr") {
		renameHerdrCurrentTab(title);
		return;
	}
	throw new Error("Unsupported mux backend");
}

export function renameWorkspace(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		execSync(
			`cmux workspace-action --action rename --title ${shellEscape(title)}`,
			{ encoding: "utf8" },
		);
		return;
	}
	if (backend === "tmux") {
		if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") return;
		const paneId = process.env.TMUX_PANE;
		if (!paneId) throw new Error("TMUX_PANE not set");
		const sessionId = execFileSync(
			"tmux",
			["display-message", "-p", "-t", paneId, "#{session_id}"],
			{ encoding: "utf8" },
		).trim();
		execFileSync("tmux", ["rename-session", "-t", sessionId, title], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "wezterm") {
		const paneId = process.env.WEZTERM_PANE;
		const args = ["cli", "set-window-title"];
		if (paneId) args.push("--pane-id", paneId);
		args.push(title);
		try {
			execFileSync("wezterm", args, { encoding: "utf8" });
		} catch {}
		return;
	}
	if (backend === "zellij") return;
	if (backend === "herdr") {
		renameHerdrCurrentWorkspace(title);
		return;
	}
	throw new Error("Unsupported mux backend");
}
