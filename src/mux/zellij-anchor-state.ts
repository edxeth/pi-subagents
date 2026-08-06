import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZellijPlacementPolicy } from "./zellij-policy.ts";

interface ZellijPlacementGroupState {
	policy: ZellijPlacementPolicy;
	parentPaneId: number;
	paneIds: number[];
	tabId?: number;
}

const ZELLIJ_PLACEMENT_RUNTIME_ID: string = randomUUID();

interface ZellijPlacementStateFile {
	version: 1;
	groups: Record<string, ZellijPlacementGroupState>;
}

function zellijSessionSlug(sessionName: string): string {
	return sessionName.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function zellijPlacementStatePath(sessionName: string): string {
	return join(tmpdir(), `pi-zellij-placement-${zellijSessionSlug(sessionName)}.json`);
}

export function zellijPlacementGroupId(
	groupKey: string,
	parentPaneId: number,
	policy: ZellijPlacementPolicy,
	runtimeId = ZELLIJ_PLACEMENT_RUNTIME_ID,
	sessionName = process.env.ZELLIJ_SESSION_NAME ?? "default",
): string {
	return createHash("sha256")
		.update(`${zellijSessionSlug(sessionName)}\0${runtimeId}\0${groupKey}\0${parentPaneId}\0${policy}`)
		.digest("hex")
		.slice(0, 24);
}

export function readZellijPlacementState(
	sessionName = process.env.ZELLIJ_SESSION_NAME ?? "default",
): ZellijPlacementStateFile {
	try {
		const parsed = JSON.parse(readFileSync(zellijPlacementStatePath(sessionName), "utf8"));
		if (parsed?.version === 1 && parsed.groups && typeof parsed.groups === "object") {
			return parsed as ZellijPlacementStateFile;
		}
	} catch {}
	return { version: 1, groups: {} };
}

export function writeZellijPlacementState(
	state: ZellijPlacementStateFile,
	sessionName = process.env.ZELLIJ_SESSION_NAME ?? "default",
): void {
	const path = zellijPlacementStatePath(sessionName);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export function resetZellijPlacementState(sessionName = process.env.ZELLIJ_SESSION_NAME ?? "default"): void {
	const path = zellijPlacementStatePath(sessionName);
	if (existsSync(path)) rmSync(path, { force: true });
}
