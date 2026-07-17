import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readZellijPlacementState,
	resetZellijPlacementState,
	writeZellijPlacementState,
	zellijPlacementGroupId,
} from "./zellij-anchor-state.ts";
import { zellijActionSync } from "./core.ts";

import {
	DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
	DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
	isUsableZellijTiledPane,
	resolveZellijPlacementPolicy,
	selectLiveOwnedZellijAnchor,
	selectZellijFirstPlacement,
	type ZellijPaneSnapshot,
	type ZellijPlacementContext,
	type ZellijSplitDirection,
} from "./zellij-policy.ts";

export {
	canSplitZellijPaneInDirection,
	resolveZellijPlacementPolicy,
	selectLiveOwnedZellijAnchor,
	selectZellijFirstPlacement,
	type ZellijPaneSnapshot,
	type ZellijPlacementContext,
	type ZellijPlacementPolicy,
} from "./zellij-policy.ts";

function parseZellijPaneSurface(rawId: string, context: string): string {
	const idMatch = rawId.match(/(\d+)/);
	if (!idMatch) {
		throw new Error(
			`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`,
		);
	}
	return `pane:${idMatch[1]}`;
}

function surfacePaneId(surface: string): number {
	return Number(surface.startsWith("pane:") ? surface.slice(5) : surface);
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
			if (!output.trim()) throw new Error("Unexpected zellij list-panes output: empty");
			const parsed = JSON.parse(output);
			if (!Array.isArray(parsed)) {
				throw new Error("Unexpected zellij list-panes output: not an array");
			}
			return parsed as ZellijPaneSnapshot[];
		} catch (error) {
			lastError = error;
			if (attempt < 2) sleepSync(50);
		}
	}
	throw lastError;
}

function readZellijClientPaneSurfaces(): string[] {
	return zellijActionSync(["list-clients"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(1)
		.map((line) => line.split(/\s+/)[1])
		.map((pane) => pane?.match(/(?:terminal_)?(\d+)/)?.[1])
		.filter((paneId): paneId is string => !!paneId)
		.map((paneId) => `pane:${paneId}`);
}

function requireSingleZellijClient(): string {
	const clients = readZellijClientPaneSurfaces();
	if (clients.length !== 1) {
		throw new Error(
			"Zellij right/down/stack/tab placement requires exactly one attached client " +
				`to preserve focus; found ${clients.length}. Use floating placement or detach extra clients.`,
		);
	}
	return clients[0];
}

function focusZellijPane(surface: string): void {
	try {
		zellijActionSync(["focus-pane-id", `terminal_${surfacePaneId(surface)}`]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/is already focused/i.test(message)) throw error;
	}
}

function restoreZellijFocus(originalSurface: string): void {
	try {
		zellijActionSync(["focus-previous-pane"]);
	} catch {}
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			focusZellijPane(originalSurface);
			if (readZellijClientPaneSurfaces()[0] === originalSurface) return;
		} catch {}
		sleepSync(25);
	}
}

function waitForLiveZellijPane(surface: string, timeoutMs = 2000): void {
	const paneId = surfacePaneId(surface);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const pane = readZellijPanes().find(
			(candidate) =>
				!candidate.is_plugin && candidate.id === paneId && !candidate.exited,
		);
		if (pane) return;
		sleepSync(25);
	}
	throw new Error(`Zellij created ${surface}, but the pane never became live`);
}

function createZellijSplitPane(
	name: string,
	parentSurface: string,
	tabId: number,
	direction: ZellijSplitDirection,
): string {
	const originalSurface = requireSingleZellijClient();
	focusZellijPane(parentSurface);
	try {
		const surface = parseZellijPaneSurface(
			zellijActionSync([
				"new-pane",
				"--direction",
				direction,
				"--tab-id",
				String(tabId),
				"--name",
				name,
				"--cwd",
				process.cwd(),
			]).trim(),
			`new-pane --direction ${direction}`,
		);
		waitForLiveZellijPane(surface);
		return surface;
	} finally {
		restoreZellijFocus(originalSurface);
	}
}

function createZellijStackedPane(name: string, anchorSurface: string): string {
	const originalSurface = requireSingleZellijClient();
	try {
		const surface = parseZellijPaneSurface(
			zellijActionSync(
				[
					"new-pane",
					"--stacked",
					"--near-current-pane",
					"--name",
					name,
					"--cwd",
					process.cwd(),
				],
				anchorSurface,
			).trim(),
			"new-pane --stacked",
		);
		waitForLiveZellijPane(surface);
		return surface;
	} finally {
		restoreZellijFocus(originalSurface);
	}
}

function createZellijFloatingPane(name: string, parentSurface: string): string {
	const surface = parseZellijPaneSurface(
		zellijActionSync(
			[
				"new-pane",
				"--floating",
				"--pinned",
				"true",
				"--near-current-pane",
				"--name",
				name,
				"--cwd",
				process.cwd(),
			],
			parentSurface,
		).trim(),
		"new-pane --floating",
	);
	waitForLiveZellijPane(surface);
	return surface;
}

function createZellijTab(name: string): { surface: string; tabId: number } {
	const originalSurface = requireSingleZellijClient();
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
		const pane = readZellijPanes().find(
			(candidate) =>
				candidate.tab_id === tabId &&
				isUsableZellijTiledPane(candidate) &&
				typeof candidate.id === "number",
		);
		if (!pane) throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
		const surface = `pane:${pane.id}`;
		waitForLiveZellijPane(surface);
		try {
			zellijActionSync(["rename-pane", name], surface);
		} catch {}
		restoreZellijFocus(originalSurface);
		return { surface, tabId };
	} catch (error) {
		try {
			zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
		} catch {}
		restoreZellijFocus(originalSurface);
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

function zellijSessionSlug(): string {
	return (
		process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default"
	).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function zellijSurfaceLockPath(): string {
	return join(tmpdir(), `pi-zellij-surface-${zellijSessionSlug()}.lock`);
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
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for zellij surface lock: ${lockPath}`);
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

function defaultPlacementContext(): ZellijPlacementContext {
	const parentPaneId = Number(process.env.ZELLIJ_PANE_ID);
	return {
		groupKey:
			process.env.PI_SUBAGENT_SESSION ??
			process.env.PI_SUBAGENT_PARENT_SESSION ??
			`process:${process.pid}`,
		...(Number.isInteger(parentPaneId) ? { parentPaneId } : {}),
		policy: resolveZellijPlacementPolicy(
			process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT,
		),
	};
}

function createZellijSurfaceUnlocked(
	name: string,
	providedContext?: ZellijPlacementContext,
): string {
	const context = providedContext ?? defaultPlacementContext();
	const parentPaneId =
		context.parentPaneId ?? Number(process.env.ZELLIJ_PANE_ID);
	const policy =
		context.policy ??
		resolveZellijPlacementPolicy(process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT);
	const panes = readZellijPanes();
	if (policy === "floating") {
		const parentSurface = Number.isInteger(parentPaneId)
			? `pane:${parentPaneId}`
			: undefined;
		if (!parentSurface) return createZellijTab(name).surface;
		return createZellijFloatingPane(name, parentSurface);
	}

	const state = readZellijPlacementState();
	const groupId = zellijPlacementGroupId(context.groupKey, parentPaneId, policy);
	const previous = state.groups[groupId];
	const liveOwnedPaneIds = previous?.paneIds.filter((paneId) =>
		panes.some((pane) => pane.id === paneId && !pane.exited),
	) ?? [];
	const anchor =
		previous?.policy === policy
			? selectLiveOwnedZellijAnchor(panes, liveOwnedPaneIds)
			: null;
	if (anchor) {
		const surface = createZellijStackedPane(name, `pane:${anchor.id}`);
		state.groups[groupId] = {
			...previous,
			paneIds: [...liveOwnedPaneIds, surfacePaneId(surface)],
			...(typeof anchor.tab_id === "number" ? { tabId: anchor.tab_id } : {}),
		};
		writeZellijPlacementState(state);
		return surface;
	}

	const minColumns = envPositiveInteger(
		"PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
		DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS,
	);
	const minRows = envPositiveInteger(
		"PI_SUBAGENT_ZELLIJ_MIN_ROWS",
		DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS,
	);
	const plan = Number.isInteger(parentPaneId)
		? selectZellijFirstPlacement(
				panes,
				parentPaneId,
				policy,
				minColumns,
				minRows,
			)
		: ({ mode: "tab" } as const);
	let surface: string;
	let tabId: number | undefined;
	if (plan.mode === "split") {
		surface = createZellijSplitPane(
			name,
			`pane:${plan.parentPaneId}`,
			plan.tabId,
			plan.direction,
		);
		tabId = plan.tabId;
	} else if (plan.mode === "floating") {
		surface = createZellijFloatingPane(name, `pane:${plan.parentPaneId}`);
		tabId = plan.tabId;
	} else {
		const createdTab = createZellijTab(name);
		surface = createdTab.surface;
		tabId = createdTab.tabId;
	}
	state.groups[groupId] = {
		policy,
		parentPaneId,
		paneIds: [surfacePaneId(surface)],
		...(tabId !== undefined ? { tabId } : {}),
	};
	writeZellijPlacementState(state);
	return surface;
}

export function createZellijSurface(
	name: string,
	context?: ZellijPlacementContext,
): string {
	return withZellijSurfaceLock(() => createZellijSurfaceUnlocked(name, context));
}

export function resetZellijPlacementStateForTests(): void {
	resetZellijPlacementState();
	rmSync(zellijSurfaceLockPath(), { recursive: true, force: true });
}
