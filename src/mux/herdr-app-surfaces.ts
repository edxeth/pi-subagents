import {
	closeHerdrAppTerminal,
	createHerdrAppTab,
	getHerdrAppTerminalSize,
	type HerdrAppTerminalRef,
	labelHerdrAppTerminal,
	listHerdrAppTerminals,
	splitHerdrAppPane,
} from "./herdr-app.ts";
import {
	type HerdrPlacementContext,
	resolveHerdrPlacementPolicy,
	selectFirstAutoSplit,
	selectOwnedAutoSplit,
} from "./herdr-surfaces.ts";

type SplitDirection = "right" | "down";
type Size = { cols: number; rows: number };
type OwnedGroup = { terminals: string[]; estimates: Map<string, Size> };
type SplitPlan = { terminal: string; direction: SplitDirection };

const TITLE_LABEL = "pi.subagent.title";
const placementGroups = new Map<string, OwnedGroup>();

function parentTerminalId(): string {
	const id = process.env.HC_TERMINAL_ID?.trim();
	if (!id) throw new Error("Herdr app terminal id (HC_TERMINAL_ID) is not set");
	return id;
}

function requireRef(refs: HerdrAppTerminalRef[], terminal: string): HerdrAppTerminalRef {
	const ref = refs.find((candidate) => candidate.terminal === terminal);
	if (!ref) throw new Error(`Herdr app terminal ${terminal} is not shown in any pane`);
	return ref;
}

function placementGroupKey(parentTerminal: string, policy: string): string {
	const parentSession =
		process.env.PI_SUBAGENT_SESSION ?? process.env.PI_SUBAGENT_PARENT_SESSION ?? `process:${process.pid}`;
	return `${parentSession}\0${parentTerminal}\0${policy}`;
}

function createTabSurface(name: string, parent: HerdrAppTerminalRef): string {
	const tab = createHerdrAppTab({
		space: parent.space,
		folder: process.cwd(),
		name,
	});
	labelHerdrAppTerminal(tab.terminal, TITLE_LABEL, name);
	return tab.terminal;
}

function splitSurface(name: string, pane: string, direction: SplitDirection): string {
	const created = splitHerdrAppPane({ pane, direction });
	labelHerdrAppTerminal(created.terminal, TITLE_LABEL, name);
	return created.terminal;
}

function halves(size: Size, direction: SplitDirection): [Size, Size] {
	if (direction === "right") {
		const first = Math.floor(size.cols / 2);
		return [
			{ cols: first, rows: size.rows },
			{ cols: size.cols - first, rows: size.rows },
		];
	}
	const first = Math.floor(size.rows / 2);
	return [
		{ cols: size.cols, rows: first },
		{ cols: size.cols, rows: size.rows - first },
	];
}

function safeSize(terminal: string): Size | null {
	try {
		return getHerdrAppTerminalSize(terminal);
	} catch {
		return null;
	}
}

/** A fresh terminal can report a stale default size, so never trust a size above our own estimate. */
function ownedSize(terminal: string, estimate: Size | undefined): Size | null {
	const reported = safeSize(terminal);
	if (!reported) return estimate ?? null;
	if (!estimate) return reported;
	return {
		cols: Math.min(reported.cols, estimate.cols),
		rows: Math.min(reported.rows, estimate.rows),
	};
}

function planSplit(
	policy: string,
	parent: HerdrAppTerminalRef,
	parentSize: Size,
	owned: Array<{ terminal: string; size: Size }>,
): SplitPlan | null {
	const rect = (terminal: string, size: Size) => ({
		paneId: terminal,
		x: 0,
		y: 0,
		width: size.cols,
		height: size.rows,
	});
	if (policy === "auto") {
		const plan = owned.length
			? selectOwnedAutoSplit(owned.map((pane) => rect(pane.terminal, pane.size)))
			: selectFirstAutoSplit(rect(parent.terminal, parentSize));
		return plan && { terminal: plan.paneId, direction: plan.direction };
	}
	if (owned.length) {
		return {
			terminal: owned[owned.length - 1].terminal,
			direction: policy === "right-stack" ? "down" : "right",
		};
	}
	return {
		terminal: parent.terminal,
		direction: policy === "right-stack" ? "right" : "down",
	};
}

export function createHerdrAppSurface(name: string, context?: HerdrPlacementContext): string {
	const policy = resolveHerdrPlacementPolicy(context?.policy ?? process.env.PI_SUBAGENT_HERDR_PLACEMENT);
	const parentId = parentTerminalId();
	const refs = listHerdrAppTerminals();
	const parent = requireRef(refs, parentId);
	if (policy === "tab") return createTabSurface(name, parent);

	if (policy === "right" || policy === "down") {
		// Explicit non-stacking policies re-split the parent every launch by design.
		try {
			return splitSurface(name, parent.pane, policy);
		} catch {
			return createTabSurface(name, parent);
		}
	}

	const parentSize = safeSize(parentId);
	if (!parentSize) return createTabSurface(name, parent);

	const groupKey = placementGroupKey(parentId, policy);
	const previous = placementGroups.get(groupKey);
	const owned: Array<{ terminal: string; size: Size }> = [];
	for (const terminal of previous?.terminals ?? []) {
		const ref = refs.find((candidate) => candidate.terminal === terminal);
		if (!ref || ref.tab !== parent.tab) continue;
		const size = ownedSize(terminal, previous?.estimates.get(terminal));
		if (size) owned.push({ terminal, size });
	}

	const plan = planSplit(policy, parent, parentSize, owned);
	if (!plan) return createTabSurface(name, parent);
	const source = refs.find((candidate) => candidate.terminal === plan.terminal);
	if (!source) return createTabSurface(name, parent);

	let terminal: string;
	try {
		terminal = splitSurface(name, source.pane, plan.direction);
	} catch {
		return createTabSurface(name, parent);
	}

	const estimates = new Map(owned.map((pane) => [pane.terminal, pane.size]));
	const sourceSize = plan.terminal === parentId ? parentSize : estimates.get(plan.terminal);
	if (sourceSize) {
		const [remaining, created] = halves(sourceSize, plan.direction);
		if (plan.terminal !== parentId) estimates.set(plan.terminal, remaining);
		estimates.set(terminal, created);
	}
	placementGroups.set(groupKey, {
		terminals: [...owned.map((pane) => pane.terminal), terminal],
		estimates,
	});
	return terminal;
}

export function createHerdrAppSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	if (direction !== "right" && direction !== "down") {
		throw new Error(
			`Herdr split direction "${direction}" is unsupported; Herdr pane split supports only right and down`,
		);
	}
	const refs = listHerdrAppTerminals();
	const source = requireRef(refs, fromSurface ?? parentTerminalId());
	return splitSurface(name, source.pane, direction);
}

export function closeHerdrAppSurface(surface: string): void {
	closeHerdrAppTerminal(surface);
}
