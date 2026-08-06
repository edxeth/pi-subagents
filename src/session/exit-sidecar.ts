import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function getSubagentExitSidecarPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

export function clearSubagentExitSidecar(sessionFile: string): void {
	rmSync(getSubagentExitSidecarPath(sessionFile), { force: true });
}

export function writeSubagentExitSidecar(sessionFile: string, payload: object, opts?: { supersede?: boolean }): void {
	const exitFile = getSubagentExitSidecarPath(sessionFile);
	if (existsSync(exitFile)) {
		if (!opts?.supersede) return;
		try {
			const existing = JSON.parse(readFileSync(exitFile, "utf8")) as {
				type?: unknown;
			};
			if (existing.type !== "error") return;
		} catch {
			// A consumed or unreadable sidecar carries no verdict worth protecting.
			// Let a genuine completion replace it.
		}
	}
	writeFileSync(exitFile, JSON.stringify(payload), "utf8");
}
