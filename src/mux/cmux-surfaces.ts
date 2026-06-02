import { execFileSync, spawnSync } from "node:child_process";

type CmuxFocusSnapshot = {
	surfaceRef?: string;
	paneRef?: string;
	columns?: number;
	rows?: number;
};

type CmuxCreatedSurface = {
	surface: string;
	paneRef?: string;
};

type CmuxIdentifySnapshot = {
	focused: CmuxFocusSnapshot | null;
	caller: CmuxFocusSnapshot | null;
};

const DEFAULT_INTERACTIVE_MIN_COLUMNS = 50;
const DEFAULT_INTERACTIVE_MIN_ROWS = 10;

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function positiveNumber(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseCmuxColumns(record: Record<string, unknown>): number | undefined {
	return (
		positiveNumber(record.columns) ??
		positiveNumber(record.cols) ??
		positiveNumber(record.width) ??
		positiveNumber(record.pane_columns)
	);
}

function parseCmuxRows(record: Record<string, unknown>): number | undefined {
	return (
		positiveNumber(record.rows) ??
		positiveNumber(record.height) ??
		positiveNumber(record.pane_rows)
	);
}

function parseCmuxFocusedSnapshot(value: unknown): CmuxFocusSnapshot | null {
	if (!value || typeof value !== "object") return null;

	const focused = (value as { focused?: unknown }).focused;
	if (!focused || typeof focused !== "object") return null;

	const record = focused as {
		surface_ref?: unknown;
		pane_ref?: unknown;
		columns?: unknown;
		cols?: unknown;
		width?: unknown;
		pane_columns?: unknown;
		rows?: unknown;
		height?: unknown;
		pane_rows?: unknown;
	};
	const surfaceRef = nonEmptyString(record.surface_ref)
		? record.surface_ref
		: undefined;
	const paneRef = nonEmptyString(record.pane_ref)
		? record.pane_ref
		: undefined;
	const columns = parseCmuxColumns(record);
	const rows = parseCmuxRows(record);

	if (!surfaceRef && !paneRef) return null;
	return { surfaceRef, paneRef, columns, rows };
}

function parseCmuxJson(value: string): unknown | null {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
	if (!value || typeof value !== "object") return null;

	const caller = (value as { caller?: unknown }).caller;
	if (!caller || typeof caller !== "object") return null;

	const record = caller as {
		surface_ref?: unknown;
		pane_ref?: unknown;
		columns?: unknown;
		cols?: unknown;
		width?: unknown;
		pane_columns?: unknown;
		rows?: unknown;
		height?: unknown;
		pane_rows?: unknown;
	};
	const surfaceRef = nonEmptyString(record.surface_ref)
		? record.surface_ref
		: undefined;
	const paneRef = nonEmptyString(record.pane_ref)
		? record.pane_ref
		: undefined;
	const columns = parseCmuxColumns(record);
	const rows = parseCmuxRows(record);

	if (!surfaceRef && !paneRef) return null;
	return { surfaceRef, paneRef, columns, rows };
}

function parseCmuxCreatedSurface(
	output: string,
	command: string,
): CmuxCreatedSurface {
	const surfaceMatch = output.match(/surface:\d+/);
	if (!surfaceMatch) {
		throw new Error(`Unexpected cmux ${command} output: ${output}`);
	}
	return {
		surface: surfaceMatch[0],
		paneRef: output.match(/pane:\d+/)?.[0],
	};
}

function parseCmuxPaneRefForSurface(
	value: unknown,
	surface: string,
): string | null {
	if (!value || typeof value !== "object") return null;

	const record = value as {
		surface_ref?: unknown;
		pane_ref?: unknown;
		caller?: unknown;
	};
	if (record.surface_ref === surface && nonEmptyString(record.pane_ref)) {
		return record.pane_ref;
	}

	const caller = record.caller;
	if (!caller || typeof caller !== "object") return null;

	const callerRecord = caller as {
		surface_ref?: unknown;
		pane_ref?: unknown;
	};
	if (
		callerRecord.surface_ref === surface &&
		nonEmptyString(callerRecord.pane_ref)
	) {
		return callerRecord.pane_ref;
	}

	return null;
}

function readCmux(args: string[]): string | null {
	const result = spawnSync("cmux", args, { encoding: "utf8" });
	if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
	return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
	const parsed = value ? parseCmuxJson(value) : null;
	return {
		focused: parseCmuxFocusedSnapshot(parsed),
		caller: parseCmuxCallerSnapshot(parsed),
	};
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
	return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
	return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
	const info = readCmux(["identify", "--surface", surface]);
	return info ? parseCmuxPaneRefForSurface(parseCmuxJson(info), surface) : null;
}

function restoreCmuxFocusSnapshot(snapshot: CmuxFocusSnapshot | null): void {
	if (!snapshot) return;

	if (snapshot.paneRef) {
		spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], {
			encoding: "utf8",
		});
	}

	if (snapshot.surfaceRef) {
		spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], {
			encoding: "utf8",
		});
	}
}

function waitForCmuxFocusSettle(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function cmuxFocusMatchesChild(
	currentFocus: CmuxFocusSnapshot | null,
	child: CmuxCreatedSurface,
): boolean {
	if (!currentFocus) return false;
	if (currentFocus.surfaceRef === child.surface) return true;
	return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}

function cmuxFocusMatchesSurfaceRef(
	currentFocus: CmuxFocusSnapshot | null,
	surfaceRef: string | undefined,
): boolean {
	return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
	currentFocus: CmuxFocusSnapshot | null,
	paneRef: string | undefined,
): boolean {
	return !!paneRef && currentFocus?.paneRef === paneRef;
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
	snapshot: CmuxFocusSnapshot | null,
	child: CmuxCreatedSurface,
	options?: {
		sourceSurfaceRef?: string;
		callerSnapshot?: CmuxFocusSnapshot | null;
	},
): void {
	if (!snapshot) return;

	waitForCmuxFocusSettle();
	const currentFocus = captureCmuxFocusSnapshot();
	if (
		cmuxFocusMatchesChild(currentFocus, child) ||
		cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
		cmuxFocusMatchesSurfaceRef(
			currentFocus,
			options?.callerSnapshot?.surfaceRef,
		) ||
		cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
	) {
		restoreCmuxFocusSnapshot(snapshot);
	}
}

function createCmuxChildSurface(
	name: string,
	args: string[],
	command: string,
	options?: { sourceSurfaceRef?: string },
): CmuxCreatedSurface {
	const identifySnapshot = captureCmuxIdentifySnapshot();
	const focusSnapshot = identifySnapshot.focused;
	const callerSnapshot = identifySnapshot.caller;
	let child: CmuxCreatedSurface | null = null;

	try {
		const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
		child = parseCmuxCreatedSurface(output, command);
		child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;

		execFileSync("cmux", ["rename-tab", "--surface", child.surface, name], {
			encoding: "utf8",
		});

		return child;
	} finally {
		if (child) {
			restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
				sourceSurfaceRef: options?.sourceSurfaceRef,
				callerSnapshot,
			});
		} else {
			restoreCmuxFocusSnapshot(focusSnapshot);
		}
	}
}

function canSplitCmuxPaneRight(snapshot: CmuxFocusSnapshot | null): boolean {
	if (!snapshot?.columns || !snapshot.rows) return false;
	return (
		Math.floor(snapshot.columns / 2) >= DEFAULT_INTERACTIVE_MIN_COLUMNS &&
		snapshot.rows >= DEFAULT_INTERACTIVE_MIN_ROWS
	);
}

function createCmuxSplitSurface(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): CmuxCreatedSurface {
	const args = ["new-split", direction];
	if (fromSurface) args.push("--surface", fromSurface);
	return createCmuxChildSurface(name, args, "new-split", {
		sourceSurfaceRef: fromSurface,
	});
}

export function createCmuxSurface(name: string): string {
	const snapshot = captureCmuxIdentifySnapshot().focused;
	const sourceSurface = snapshot?.surfaceRef ?? process.env.CMUX_SURFACE_ID;
	if (canSplitCmuxPaneRight(snapshot)) {
		return createCmuxSplitSurface(name, "right", sourceSurface).surface;
	}
	return createCmuxChildSurface(name, ["new-surface"], "new-surface").surface;
}

export function createCmuxSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	return createCmuxSplitSurface(name, direction, fromSurface).surface;
}
