import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readZellijPlacementState,
	resetZellijPlacementState,
	writeZellijPlacementState,
	zellijPlacementGroupId,
} from "./zellij-anchor-state.ts";
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
import {
	resolveZellijTarget,
	runZellijAction,
	type ZellijTarget,
} from "./zellij-runtime.ts";

export {
	canSplitZellijPaneInDirection,
	resolveZellijPlacementPolicy,
	selectLiveOwnedZellijAnchor,
	selectZellijFirstPlacement,
	type ZellijPaneSnapshot,
	type ZellijPlacementContext,
	type ZellijPlacementPolicy,
} from "./zellij-policy.ts";

function surfacePaneId(surface: string): number {
	return Number(surface.startsWith("pane:") ? surface.slice(5) : surface);
}

function parseSurface(rawId: string, context: string): string {
	const match = rawId.match(/(\d+)/);
	if (!match) {
		throw new Error(`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`);
	}
	return `pane:${match[1]}`;
}

function withPaneCommand(args: string[], command?: string[]): string[] {
	return command?.length ? [...args, "--", ...command] : args;
}

function action(
	runtime: ZellijTarget,
	args: string[],
	surface?: string,
): Promise<string> {
	return runZellijAction(runtime, args, surface);
}

async function readPanes(runtime: ZellijTarget): Promise<ZellijPaneSnapshot[]> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const output = await action(runtime, [
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
			if (attempt < 2) await delay(50);
		}
	}
	throw lastError;
}

async function readClientSurfaces(runtime: ZellijTarget): Promise<string[]> {
	return (await action(runtime, ["list-clients"]))
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(1)
		.map((line) => line.split(/\s+/)[1])
		.map((pane) => pane?.match(/(?:terminal_)?(\d+)/)?.[1])
		.filter((paneId): paneId is string => !!paneId)
		.map((paneId) => `pane:${paneId}`);
}

async function requireSingleClient(runtime: ZellijTarget): Promise<string> {
	const clients = await readClientSurfaces(runtime);
	if (clients.length !== 1) {
		throw new Error(
			"Zellij right/down/stack/tab placement requires exactly one attached client " +
				`to preserve focus; found ${clients.length}. Use floating placement or detach extra clients.`,
		);
	}
	return clients[0];
}

async function focusPane(runtime: ZellijTarget, surface: string): Promise<void> {
	try {
		await action(runtime, ["focus-pane-id", `terminal_${surfacePaneId(surface)}`]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/is already focused/i.test(message)) throw error;
	}
}

async function restoreFocus(
	runtime: ZellijTarget,
	surface: string,
	tabPosition?: number,
): Promise<void> {
	try {
		await action(runtime, ["focus-previous-pane"]);
	} catch {}
	try {
		const position = tabPosition ?? (await readPanes(runtime)).find(
			(candidate) => !candidate.is_plugin && candidate.id === surfacePaneId(surface),
		)?.tab_position;
		if (typeof position === "number") {
			await action(runtime, ["go-to-tab", String(position + 1)]);
		}
	} catch {}
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await focusPane(runtime, surface);
			if ((await readClientSurfaces(runtime))[0] === surface) return;
		} catch {}
		await delay(25);
	}
}

async function waitForPane(
	runtime: ZellijTarget,
	surface: string,
	timeoutMs = 2000,
): Promise<void> {
	const paneId = surfacePaneId(surface);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const pane = (await readPanes(runtime)).find(
			(candidate) => !candidate.is_plugin && candidate.id === paneId && !candidate.exited,
		);
		if (pane) return;
		await delay(25);
	}
	throw new Error(`Zellij created ${surface}, but the pane never became live`);
}

async function createSplit(
	runtime: ZellijTarget,
	name: string,
	parentSurface: string,
	tabId: number,
	direction: ZellijSplitDirection,
	command?: string[],
): Promise<string> {
	const original = await requireSingleClient(runtime);
	await focusPane(runtime, parentSurface);
	try {
		const surface = parseSurface(
			(
				await action(
				runtime,
				withPaneCommand([
					"new-pane",
					"--direction",
					direction,
					"--tab-id",
					String(tabId),
					"--name",
					name,
					"--cwd",
					process.cwd(),
				], command),
			)
			).trim(),
			`new-pane --direction ${direction}`,
		);
		if (!command) await waitForPane(runtime, surface);
		return surface;
	} finally {
		await restoreFocus(runtime, original);
	}
}

async function createStacked(
	runtime: ZellijTarget,
	name: string,
	anchorSurface: string,
	command?: string[],
): Promise<string> {
	const original = await requireSingleClient(runtime);
	try {
		const surface = parseSurface(
			(
				await action(
					runtime,
					withPaneCommand([
						"new-pane",
						"--stacked",
						"--near-current-pane",
						"--name",
						name,
						"--cwd",
						process.cwd(),
					], command),
					anchorSurface,
				)
			).trim(),
			"new-pane --stacked",
		);
		if (!command) await waitForPane(runtime, surface);
		return surface;
	} finally {
		await restoreFocus(runtime, original);
	}
}

async function createFloating(
	runtime: ZellijTarget,
	name: string,
	parentSurface: string,
	command?: string[],
): Promise<string> {
	const surface = parseSurface(
		(
			await action(
				runtime,
				withPaneCommand([
					"new-pane",
					"--floating",
					"--pinned",
					"true",
					"--near-current-pane",
					"--name",
					name,
					"--cwd",
					process.cwd(),
				], command),
				parentSurface,
			)
		).trim(),
		"new-pane --floating",
	);
	if (!command) await waitForPane(runtime, surface);
	return surface;
}

async function createTab(
	runtime: ZellijTarget,
	name: string,
	command?: string[],
): Promise<{ surface: string; tabId: number }> {
	const original = await requireSingleClient(runtime);
	const originalTabPosition = (await readPanes(runtime)).find(
		(candidate) => !candidate.is_plugin && candidate.id === surfacePaneId(original),
	)?.tab_position;
	const tabIdRaw = (
		await action(runtime, ["new-tab", "--name", name, "--cwd", process.cwd()])
	).trim();
	const tabId = Number(tabIdRaw);
	if (!Number.isInteger(tabId)) {
		throw new Error(`Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`);
	}
	try {
		const pane = (await readPanes(runtime)).find(
			(candidate) =>
				candidate.tab_id === tabId &&
				isUsableZellijTiledPane(candidate) &&
				typeof candidate.id === "number",
		);
		if (!pane) throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
		let surface = `pane:${pane.id}`;
		if (command) {
			surface = parseSurface(
				(
					await action(
						runtime,
						withPaneCommand(
							["new-pane", "--tab-id", String(tabId), "--name", name, "--cwd", process.cwd()],
							command,
						),
					)
				).trim(),
				"new-pane in new tab",
			);
			await action(runtime, ["close-pane"], `pane:${pane.id}`);
		} else {
			await waitForPane(runtime, surface);
			try {
				await action(runtime, ["rename-pane", name], surface);
			} catch {}
		}
		await restoreFocus(runtime, original, originalTabPosition);
		return { surface, tabId };
	} catch (error) {
		try {
			await action(runtime, ["close-tab", "--tab-id", String(tabId)]);
		} catch {}
		await restoreFocus(runtime, original, originalTabPosition);
		throw error;
	}
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lockPath(runtime: ZellijTarget): string {
	const slug = runtime.sessionName.replace(/[^A-Za-z0-9_.-]/g, "_");
	return join(tmpdir(), `pi-zellij-surface-${slug}.lock`);
}

async function withSurfaceLock<T>(
	runtime: ZellijTarget,
	callback: () => Promise<T>,
): Promise<T> {
	const path = lockPath(runtime);
	const deadline = Date.now() + 10000;
	while (true) {
		try {
			mkdirSync(path);
			writeFileSync(join(path, "owner"), `${process.pid}\n`);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(path).mtimeMs > 30000) {
					rmSync(path, { recursive: true, force: true });
					continue;
				}
			} catch {}
			if (Date.now() > deadline) {
				throw new Error(`Timed out waiting for zellij surface lock: ${path}`);
			}
			await delay(50);
		}
	}
	try {
		return await callback();
	} finally {
		rmSync(path, { recursive: true, force: true });
	}
}

async function createZellijSurfaceOnce(
	name: string,
	runtime: ZellijTarget,
	providedContext?: ZellijPlacementContext,
	command?: string[],
): Promise<string> {
	return withSurfaceLock(runtime, async () => {
		const context = providedContext ?? {
			groupKey:
				process.env.PI_SUBAGENT_SESSION ??
				process.env.PI_SUBAGENT_PARENT_SESSION ??
				`process:${process.pid}`,
			parentPaneId: runtime.parentPaneId,
			policy: resolveZellijPlacementPolicy(process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT),
		};
		const parentPaneId = context.parentPaneId ?? runtime.parentPaneId;
		const policy =
			context.policy ??
			resolveZellijPlacementPolicy(process.env.PI_SUBAGENT_ZELLIJ_PLACEMENT);
		const panes = await readPanes(runtime);
		if (policy === "floating") {
			return Number.isInteger(parentPaneId)
				? createFloating(runtime, name, `pane:${parentPaneId}`, command)
				: (await createTab(runtime, name, command)).surface;
		}

		const state = readZellijPlacementState(runtime.sessionName);
		const groupId = zellijPlacementGroupId(
			context.groupKey,
			parentPaneId,
			policy,
			undefined,
			runtime.sessionName,
		);
		const previous = state.groups[groupId];
		const liveOwnedPaneIds =
			previous?.paneIds.filter((paneId) =>
				panes.some((pane) => pane.id === paneId && !pane.exited),
			) ?? [];
		const anchor =
			previous?.policy === policy
				? selectLiveOwnedZellijAnchor(panes, liveOwnedPaneIds)
				: null;
		if (anchor) {
			const surface = await createStacked(runtime, name, `pane:${anchor.id}`, command);
			state.groups[groupId] = {
				...previous,
				paneIds: [...liveOwnedPaneIds, surfacePaneId(surface)],
				...(typeof anchor.tab_id === "number" ? { tabId: anchor.tab_id } : {}),
			};
			writeZellijPlacementState(state, runtime.sessionName);
			return surface;
		}

		const plan = Number.isInteger(parentPaneId)
			? selectZellijFirstPlacement(
					panes,
					parentPaneId,
					policy,
					positiveInteger("PI_SUBAGENT_ZELLIJ_MIN_COLUMNS", DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS),
					positiveInteger("PI_SUBAGENT_ZELLIJ_MIN_ROWS", DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS),
				)
			: ({ mode: "tab" } as const);
		let surface: string;
		let tabId: number | undefined;
		if (plan.mode === "split") {
			surface = await createSplit(
				runtime,
				name,
				`pane:${plan.parentPaneId}`,
				plan.tabId,
				plan.direction,
				command,
			);
			tabId = plan.tabId;
		} else if (plan.mode === "floating") {
			surface = await createFloating(runtime, name, `pane:${plan.parentPaneId}`, command);
			tabId = plan.tabId;
		} else {
			const created = await createTab(runtime, name, command);
			surface = created.surface;
			tabId = created.tabId;
		}
		state.groups[groupId] = {
			policy,
			parentPaneId,
			paneIds: [surfacePaneId(surface)],
			...(tabId !== undefined ? { tabId } : {}),
		};
		writeZellijPlacementState(state, runtime.sessionName);
		return surface;
	});
}

export function createZellijSurface(
	name: string,
	context?: ZellijPlacementContext,
): Promise<string> {
	return resolveZellijTarget().then((target) =>
		createZellijSurfaceOnce(name, target, context),
	);
}

export function createZellijCommandSurface(
	name: string,
	target: ZellijTarget,
	command: string[],
	context?: ZellijPlacementContext,
): Promise<string> {
	return createZellijSurfaceOnce(name, target, context, command);
}

export function resetZellijPlacementStateForTests(): void {
	const sessionName = process.env.ZELLIJ_SESSION_NAME ?? "default";
	resetZellijPlacementState(sessionName);
	rmSync(lockPath({ sessionName, parentPaneId: 0 }), {
		recursive: true,
		force: true,
	});
}
