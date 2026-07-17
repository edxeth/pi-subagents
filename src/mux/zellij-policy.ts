const ZELLIJ_MIN_TERMINAL_WIDTH = 5;
const ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
const ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;
export const DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
export const DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;

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
export type ZellijPlacementPolicy =
	| "auto"
	| "right-stack"
	| "down-stack"
	| "floating"
	| "tab-stack";

export interface ZellijPlacementContext {
	groupKey: string;
	parentPaneId?: number;
	policy?: ZellijPlacementPolicy;
}

export type ZellijFirstPlacementPlan =
	| {
			mode: "split";
			parentPaneId: number;
			tabId: number;
			direction: ZellijSplitDirection;
	  }
	| { mode: "floating"; parentPaneId: number; tabId: number }
	| { mode: "tab" };

const ZELLIJ_PLACEMENT_POLICIES = new Set<ZellijPlacementPolicy>([
	"auto",
	"right-stack",
	"down-stack",
	"floating",
	"tab-stack",
]);

export function resolveZellijPlacementPolicy(
	value: string | undefined,
): ZellijPlacementPolicy {
	if (!value) return "auto";
	if (ZELLIJ_PLACEMENT_POLICIES.has(value as ZellijPlacementPolicy)) {
		return value as ZellijPlacementPolicy;
	}
	throw new Error(
		`Invalid PI_SUBAGENT_ZELLIJ_PLACEMENT value "${value}". ` +
			"Expected auto, right-stack, down-stack, floating, or tab-stack.",
	);
}

export function isUsableZellijTiledPane(
	pane: ZellijPaneSnapshot,
): boolean {
	return (
		!pane.is_plugin &&
		!pane.is_floating &&
		pane.is_selectable !== false &&
		!pane.exited &&
		typeof pane.pane_rows === "number" &&
		typeof pane.pane_columns === "number"
	);
}

function predictZellijSplitDirection(
	pane: ZellijPaneSnapshot,
): ZellijSplitDirection | null {
	const columns = pane.pane_columns ?? 0;
	const rows = pane.pane_rows ?? 0;
	if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT) {
		return null;
	}
	if (
		rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns &&
		rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2
	) {
		return "down";
	}
	return columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2 ? "right" : null;
}

export function canSplitZellijPaneInDirection(
	pane: ZellijPaneSnapshot,
	direction: ZellijSplitDirection,
	minColumns = ZELLIJ_MIN_TERMINAL_WIDTH,
	minRows = ZELLIJ_MIN_TERMINAL_HEIGHT,
): boolean {
	const columns = pane.pane_columns ?? 0;
	const rows = pane.pane_rows ?? 0;
	return direction === "down"
		? columns >= minColumns && Math.floor(rows / 2) >= minRows
		: rows >= minRows && Math.floor(columns / 2) >= minColumns;
}

export function selectLiveOwnedZellijAnchor(
	panes: ZellijPaneSnapshot[],
	ownedPaneIds: number[],
	expectedTabId?: number,
): ZellijPaneSnapshot | null {
	for (const paneId of ownedPaneIds) {
		const pane = panes.find((candidate) => candidate.id === paneId);
		if (
			pane &&
			isUsableZellijTiledPane(pane) &&
			(expectedTabId === undefined || pane.tab_id === expectedTabId)
		) {
			return pane;
		}
	}
	return null;
}

export function selectZellijFirstPlacement(
	panes: ZellijPaneSnapshot[],
	parentPaneId: number,
	policy: ZellijPlacementPolicy,
	minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
	minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
): ZellijFirstPlacementPlan {
	if (policy === "tab-stack") return { mode: "tab" };
	const parentPane = panes.find(
		(pane) => !pane.is_plugin && pane.id === parentPaneId,
	);
	if (!parentPane || typeof parentPane.tab_id !== "number") return { mode: "tab" };
	if (policy === "floating") {
		return { mode: "floating", parentPaneId, tabId: parentPane.tab_id };
	}
	const direction =
		policy === "right-stack"
			? "right"
			: policy === "down-stack"
				? "down"
				: predictZellijSplitDirection(parentPane);
	if (
		direction &&
		canSplitZellijPaneInDirection(parentPane, direction, minColumns, minRows)
	) {
		return {
			mode: "split",
			parentPaneId,
			tabId: parentPane.tab_id,
			direction,
		};
	}
	return { mode: "tab" };
}
