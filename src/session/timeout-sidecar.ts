import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SubagentTimeoutBudget, SubagentTimeoutKind } from "../types.ts";

/**
 * Verdict for a child the parent killed on a budget.
 *
 * A killed child cannot record its own outcome, and its Pi process writes an
 * ordinary `done` completion on the way out of the SIGTERM it was sent. That
 * makes the child's own session an unsafe place for this verdict: the two
 * writers would race, and the child's record would sometimes land last.
 *
 * The parent owns the kill, so the parent owns the record. It lives beside the
 * session rather than inside it, and a resume clears it, so a later clean run
 * releases whatever the timeout had blocked.
 */
export interface SubagentTimeoutVerdict {
	kind: SubagentTimeoutKind;
	/** True when the agent's `on-timeout` policy refuses a resume. */
	blocksResume: boolean;
	/**
	 * The budgets this child ran under.
	 *
	 * Recorded because persisted launch metadata is not available for every
	 * session mode — a `session-mode: standalone` child has no seeded session
	 * file at launch, so nothing persists its configuration. Without this, a
	 * resume of a session that already proved it runs away would run unbounded.
	 */
	budget?: SubagentTimeoutBudget;
}

function getSubagentTimeoutSidecarPath(sessionFile: string): string {
	return `${sessionFile}.timeout`;
}

export function writeSubagentTimeoutSidecar(sessionFile: string, verdict: SubagentTimeoutVerdict): void {
	try {
		writeFileSync(getSubagentTimeoutSidecarPath(sessionFile), JSON.stringify(verdict), "utf8");
	} catch {}
}

export function readSubagentTimeoutSidecar(sessionFile: string): SubagentTimeoutVerdict | null {
	const path = getSubagentTimeoutSidecarPath(sessionFile);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as {
			kind?: unknown;
			blocksResume?: unknown;
			budget?: { timeoutSeconds?: unknown; idleTimeoutSeconds?: unknown };
		};
		if (parsed?.kind !== "timeout" && parsed?.kind !== "idle-timeout") return null;
		const timeoutSeconds = parsed.budget?.timeoutSeconds;
		const idleTimeoutSeconds = parsed.budget?.idleTimeoutSeconds;
		const budget: SubagentTimeoutBudget = {
			...(typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
			...(typeof idleTimeoutSeconds === "number" && idleTimeoutSeconds > 0 ? { idleTimeoutSeconds } : {}),
		};
		return {
			kind: parsed.kind,
			blocksResume: parsed.blocksResume === true,
			...(budget.timeoutSeconds || budget.idleTimeoutSeconds ? { budget } : {}),
		};
	} catch {
		return null;
	}
}

export function clearSubagentTimeoutSidecar(sessionFile: string): void {
	try {
		rmSync(getSubagentTimeoutSidecarPath(sessionFile), { force: true });
	} catch {}
}
