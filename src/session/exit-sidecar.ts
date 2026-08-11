import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function getSubagentExitSidecarPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

/**
 * True once the child has published an outcome of its own. The parent checks
 * this before starting a timeout kill: a child that already recorded a verdict
 * finished on its own terms and must not be relabelled as a runaway.
 */
export function hasSubagentExitSidecar(sessionFile: string): boolean {
	return existsSync(getSubagentExitSidecarPath(sessionFile));
}

export function clearSubagentExitSidecar(sessionFile: string): void {
	rmSync(getSubagentExitSidecarPath(sessionFile), { force: true });
}

/**
 * Write the child's exit outcome. Returns false when an outcome already owns
 * this child and the write was refused, so callers never record a verdict the
 * parent will not see.
 */
export function writeSubagentExitSidecar(
	sessionFile: string,
	payload: object,
	opts?: { supersede?: boolean },
): boolean {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (existsSync(exitFile)) {
		if (!opts?.supersede) return false;
		try {
			const existing = JSON.parse(readFileSync(exitFile, "utf8")) as {
				type?: unknown;
			};
			if (existing.type !== "error") return false;
		} catch {
			// A consumed or unreadable sidecar carries no verdict worth protecting.
			// Let a genuine completion replace it.
		}
	}
	writeFileSync(exitFile, JSON.stringify(payload), "utf8");
	return true;
}
