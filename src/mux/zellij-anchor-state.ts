import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

function zellijSessionSlug(): string {
	return (
		process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default"
	).replace(/[^A-Za-z0-9_.-]/g, "_");
}

function zellijPlacementStatePath(): string {
	return join(tmpdir(), `pi-zellij-placement-${zellijSessionSlug()}.json`);
}

export function zellijPlacementGroupId(
	groupKey: string,
	parentPaneId: number,
	policy: ZellijPlacementPolicy,
	runtimeId = ZELLIJ_PLACEMENT_RUNTIME_ID,
): string {
	return createHash("sha256")
		.update(
			`${zellijSessionSlug()}\0${runtimeId}\0${groupKey}\0${parentPaneId}\0${policy}`,
		)
		.digest("hex")
		.slice(0, 24);
}

export function readZellijPlacementState(): ZellijPlacementStateFile {
	try {
		const parsed = JSON.parse(readFileSync(zellijPlacementStatePath(), "utf8"));
		if (parsed?.version === 1 && parsed.groups && typeof parsed.groups === "object") {
			return parsed as ZellijPlacementStateFile;
		}
	} catch {}
	return { version: 1, groups: {} };
}

export function writeZellijPlacementState(
	state: ZellijPlacementStateFile,
): void {
	const path = zellijPlacementStatePath();
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export function resetZellijPlacementState(): void {
	const path = zellijPlacementStatePath();
	if (existsSync(path)) rmSync(path, { force: true });
}
