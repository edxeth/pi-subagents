import {
	closeHerdrPane,
	closeHerdrTab,
	createHerdrTabSurface,
	getHerdrCurrentPane,
	getHerdrPaneLayout,
	listHerdrTabs,
	renameHerdrPane,
	renameHerdrTab,
	renameHerdrWorkspace,
	splitHerdrPane,
	type HerdrPaneRect,
} from "./herdr.ts";

type SurfaceSplitDirection = "left" | "right" | "up" | "down";
type HerdrSplitDirection = "right" | "down";
export type HerdrPlacementPolicy =
	| "auto"
	| "right-stack"
	| "down-stack"
	| "right"
	| "down"
	| "tab";

export interface HerdrPlacementContext {
	policy?: HerdrPlacementPolicy;
}

type HerdrSplitPlan = {
	paneId: string;
	direction: HerdrSplitDirection;
	ratio?: number;
};

type HerdrPlacementGroup = {
	paneIds: string[];
};

const DEFAULT_HERDR_MIN_COLUMNS = 50;
const DEFAULT_HERDR_MIN_ROWS = 12;
const placementGroups = new Map<string, HerdrPlacementGroup>();

function assertSupportedHerdrSplitDirection(
	direction: SurfaceSplitDirection,
): asserts direction is HerdrSplitDirection {
	if (direction === "right" || direction === "down") return;
	throw new Error(
		`Herdr split direction "${direction}" is unsupported; Herdr pane split supports only right and down`,
	);
}

function cleanNumberedHerdrTabTitle(title: string): string {
	return title.replace(/^\d+:\s*/, "").trim();
}

function isAgentTabTitle(title: string): boolean {
	return /^\[[^\]\r\n]+\](?:\s|$)/.test(cleanNumberedHerdrTabTitle(title));
}

function numberedHerdrTabTitle(title: string, tabNumber: number | undefined): string {
	const cleanTitle = cleanNumberedHerdrTabTitle(title);
	if (isAgentTabTitle(cleanTitle)) return cleanTitle;
	if (tabNumber === undefined) return title;
	return `${tabNumber}: ${cleanTitle}`;
}

function isSubagentProcess(): boolean {
	return !!(process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_SESSION);
}

function herdrTabPosition(workspaceId: string, tabId: string): number | undefined {
	const index = listHerdrTabs(workspaceId).findIndex((tab) => tab.tabId === tabId);
	return index === -1 ? undefined : index + 1;
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function herdrMinimums(): { columns: number; rows: number } {
	return {
		columns: positiveInteger(
			"PI_SUBAGENT_HERDR_MIN_COLUMNS",
			DEFAULT_HERDR_MIN_COLUMNS,
		),
		rows: positiveInteger("PI_SUBAGENT_HERDR_MIN_ROWS", DEFAULT_HERDR_MIN_ROWS),
	};
}

export function resolveHerdrPlacementPolicy(
	value = process.env.PI_SUBAGENT_HERDR_PLACEMENT,
): HerdrPlacementPolicy {
	const policy = value?.trim().toLowerCase() || "auto";
	if (
		policy === "auto" ||
		policy === "right-stack" ||
		policy === "down-stack" ||
		policy === "right" ||
		policy === "down" ||
		policy === "tab"
	) {
		return policy;
	}
	throw new Error(
		`Invalid PI_SUBAGENT_HERDR_PLACEMENT value "${value}". ` +
			"Expected auto, right-stack, down-stack, right, down, or tab.",
	);
}

function canSplitHerdrPane(
	pane: HerdrPaneRect,
	direction: HerdrSplitDirection,
	ratio: number,
): boolean {
	// Both halves must clear the minimum. Herdr spends ~1 cell on the split
	// border, so this is one cell optimistic; harmless at the 50-col floor.
	const minimums = herdrMinimums();
	const span = direction === "right" ? pane.width : pane.height;
	const first = Math.floor(span * ratio);
	const second = span - first;
	return direction === "right"
		? Math.min(first, second) >= minimums.columns && pane.height >= minimums.rows
		: pane.width >= minimums.columns && Math.min(first, second) >= minimums.rows;
}

function selectFirstAutoSplit(pane: HerdrPaneRect): HerdrSplitPlan | null {
	for (const direction of ["right", "down"] as const) {
		for (const ratio of [0.62, 0.5]) {
			if (canSplitHerdrPane(pane, direction, ratio)) {
				return { paneId: pane.paneId, direction, ratio };
			}
		}
	}
	return null;
}

function selectOwnedAutoSplit(panes: HerdrPaneRect[]): HerdrSplitPlan | null {
	const largestFirst = [...panes].sort(
		(a, b) => b.width * b.height - a.width * a.height,
	);
	for (const pane of largestFirst) {
		const preferred = pane.width >= pane.height * 4 ? "right" : "down";
		for (const direction of [preferred, preferred === "right" ? "down" : "right"] as const) {
			if (canSplitHerdrPane(pane, direction, 0.5)) {
				return { paneId: pane.paneId, direction, ratio: 0.5 };
			}
		}
	}
	return null;
}

function placementGroupKey(
	parentPaneId: string,
	policy: HerdrPlacementPolicy,
): string {
	const parentSession =
		process.env.PI_SUBAGENT_SESSION ??
		process.env.PI_SUBAGENT_PARENT_SESSION ??
		`process:${process.pid}`;
	return `${parentSession}\0${parentPaneId}\0${policy}`;
}

function liveOwnedPanes(
	group: HerdrPlacementGroup | undefined,
	panes: HerdrPaneRect[],
): HerdrPaneRect[] {
	if (!group) return [];
	return group.paneIds
		.map((paneId) => panes.find((pane) => pane.paneId === paneId))
		.filter((pane): pane is HerdrPaneRect => !!pane);
}

function createNamedHerdrSplit(
	name: string,
	plan: HerdrSplitPlan,
): string | null {
	// Auto placement: a split failure or rename failure returns null so the
	// caller can fall back to one dedicated tab. If close fails after a rename
	// failure, the error propagates rather than masking a broken Herdr server.
	let pane;
	try {
		pane = splitHerdrPane({
			paneId: plan.paneId,
			direction: plan.direction,
			ratio: plan.ratio,
			cwd: process.cwd(),
			focus: false,
		});
	} catch {
		return null;
	}
	try {
		renameHerdrPane(pane.paneId, name);
		return pane.paneId;
	} catch {
		closeHerdrPane(pane.paneId);
		return null;
	}
}

function createHerdrTabSurfaceForAgent(name: string): string {
	const parentPane = getHerdrCurrentPane();
	const surface = createHerdrTabSurface({
		label: name,
		cwd: process.cwd(),
		workspaceId: parentPane.workspaceId,
		focus: false,
	});
	if (parentPane.tabId && surface.tab.tabId === parentPane.tabId) {
		throw new Error(
			`Herdr tab create returned the parent tab ${parentPane.tabId}; expected a non-shrinking new tab`,
		);
	}
	const tabNumber =
		!isAgentTabTitle(name) && parentPane.workspaceId
			? herdrTabPosition(parentPane.workspaceId, surface.tab.tabId)
			: undefined;
	try {
		renameHerdrPane(surface.pane.paneId, name);
		renameHerdrTab(surface.tab.tabId, numberedHerdrTabTitle(name, tabNumber));
		return surface.pane.paneId;
	} catch (error) {
		closeHerdrTab(surface.tab.tabId);
		throw error;
	}
}

export function createHerdrSurface(
	name: string,
	context?: HerdrPlacementContext,
): string {
	const policy = resolveHerdrPlacementPolicy(
		context?.policy ?? process.env.PI_SUBAGENT_HERDR_PLACEMENT,
	);
	if (policy === "tab") return createHerdrTabSurfaceForAgent(name);

	const parentPane = getHerdrCurrentPane();
	if (policy === "right" || policy === "down") {
		// Explicit non-stacking policies re-split the parent every launch by
		// design, so they skip ownership tracking and geometry checks.
		return (
			createNamedHerdrSplit(name, {
				paneId: parentPane.paneId,
				direction: policy,
			}) ?? createHerdrTabSurfaceForAgent(name)
		);
	}

	let panes: HerdrPaneRect[];
	try {
		panes = getHerdrPaneLayout(parentPane.paneId).panes;
	} catch {
		return createHerdrTabSurfaceForAgent(name);
	}
	const parentRect = panes.find((pane) => pane.paneId === parentPane.paneId);
	if (!parentRect) return createHerdrTabSurfaceForAgent(name);

	const groupKey = placementGroupKey(parentPane.paneId, policy);
	const previous = placementGroups.get(groupKey);
	const owned = liveOwnedPanes(previous, panes);
	let plan: HerdrSplitPlan | null;
	if (policy === "auto") {
		plan = owned.length ? selectOwnedAutoSplit(owned) : selectFirstAutoSplit(parentRect);
	} else if (owned.length) {
		plan = {
			paneId: owned[owned.length - 1].paneId,
			direction: policy === "right-stack" ? "down" : "right",
			ratio: 0.5,
		};
	} else {
		plan = {
			paneId: parentPane.paneId,
			direction: policy === "right-stack" ? "right" : "down",
			ratio: 0.62,
		};
	}
	if (!plan) return createHerdrTabSurfaceForAgent(name);

	const paneId = createNamedHerdrSplit(name, plan);
	if (!paneId) return createHerdrTabSurfaceForAgent(name);
	placementGroups.set(groupKey, {
		paneIds: [...owned.map((pane) => pane.paneId), paneId],
	});
	return paneId;
}

export function createHerdrSplit(
	name: string,
	direction: SurfaceSplitDirection,
	fromSurface?: string,
): string {
	assertSupportedHerdrSplitDirection(direction);
	// Let a real Herdr split failure propagate. Only the optional pane rename is
	// rolled back so an explicit split never leaves an orphan pane.
	const pane = splitHerdrPane({
		paneId: fromSurface ?? getHerdrCurrentPane().paneId,
		direction,
		cwd: process.cwd(),
		focus: false,
	});
	try {
		renameHerdrPane(pane.paneId, name);
	} catch (error) {
		closeHerdrPane(pane.paneId);
		throw error;
	}
	return pane.paneId;
}

function currentHerdrTabId(): string {
	const envTabId = process.env.HERDR_TAB_ID?.trim();
	if (envTabId) return envTabId;
	const tabId = getHerdrCurrentPane().tabId;
	if (!tabId) throw new Error("Herdr current pane did not report a tab id");
	return tabId;
}

function currentHerdrWorkspaceId(): string {
	const envWorkspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
	if (envWorkspaceId) return envWorkspaceId;
	const workspaceId = getHerdrCurrentPane().workspaceId;
	if (!workspaceId) {
		throw new Error("Herdr current pane did not report a workspace id");
	}
	return workspaceId;
}

export function renameHerdrCurrentTab(title: string): void {
	const childSurface = process.env.PI_SUBAGENT_SURFACE?.trim();
	if (isSubagentProcess() && childSurface) {
		renameHerdrPane(childSurface, title);
		return;
	}
	const tabId = currentHerdrTabId();
	if (!isSubagentProcess()) {
		renameHerdrTab(tabId, title);
		return;
	}
	if (isAgentTabTitle(title)) {
		renameHerdrTab(tabId, cleanNumberedHerdrTabTitle(title));
		return;
	}
	const workspaceId = currentHerdrWorkspaceId();
	renameHerdrTab(
		tabId,
		numberedHerdrTabTitle(title, herdrTabPosition(workspaceId, tabId)),
	);
}

export function renameHerdrCurrentWorkspace(title: string): void {
	if (isSubagentProcess()) return;
	renameHerdrWorkspace(currentHerdrWorkspaceId(), title);
}
