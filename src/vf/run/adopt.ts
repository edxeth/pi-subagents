import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runningSubagents, moduleAbortController } from "../../runtime/state.ts";
import {
	claimSpawnWidthSlot,
	getSpawnWidthLimit,
	releaseSlots,
	releaseSpawnWidthSlotOnCompletion,
	tryAcquireSlots,
} from "../../runtime/spawn-width.ts";
import { attachVerifiedRun, isVerifiedRunOrphaned, listVerifiedRuns, respawnVerifiedSupervisor, waitForVerifiedRunResult } from "./client.ts";
import { claimVerifiedRunDelivery, isTerminalRunState, type VerifiedRunManifest } from "./types.ts";
import { verifiedRunToSubagentResult, verifiedRunsBaseDir } from "./launch.ts";
import type { RunningSubagent, SubagentResult } from "../../types.ts";

/**
 * Reattach: collect verified fan-out results across parent sessions.
 *
 * Runs live in a project-scoped artifacts dir and are owned by detached
 * supervisors, so a parent that quit, reloaded, or was replaced finds them
 * again on session start: finished runs are delivered exactly once (delivery
 * claim), live runs get a watcher registered so the result steers in when
 * the supervisor terminalizes, and orphaned runs get a replacement
 * supervisor that adopts the still-running candidates.
 */

	const adoptedRunDirs = new Set<string>();

export interface AdoptedRunOutcome {
	runDir: string;
	runId: string;
	action: "delivered" | "watching" | "respawned" | "already-delivered" | "already-tracked";
}

export function adoptVerifiedRuns(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cwd: string,
	options: { updateWidget?: () => void } = {},
): AdoptedRunOutcome[] {
	const outcomes: AdoptedRunOutcome[] = [];
	for (const runDir of listVerifiedRuns(verifiedRunsBaseDir(cwd))) {
		let snapshot;
		try {
			snapshot = attachVerifiedRun(runDir);
		} catch {
			continue; // foreign or unreadable entry; not ours to adopt
		}
		const { manifest } = snapshot;
		if (snapshot.delivered) {
			outcomes.push({ runDir, runId: manifest.runId, action: "already-delivered" });
			continue;
		}
		if (adoptedRunDirs.has(runDir)) {
			outcomes.push({ runDir, runId: manifest.runId, action: "already-tracked" });
			continue;
		}
		if (isTerminalRunState(manifest.state)) {
			const claim = claimVerifiedRunDelivery(runDir);
			if (claim.claimed) {
				deliverVerifiedRunResult(pi, manifest, runDir);
				adoptedRunDirs.add(runDir);
				outcomes.push({ runDir, runId: manifest.runId, action: "delivered" });
			} else {
				outcomes.push({ runDir, runId: manifest.runId, action: "already-delivered" });
			}
			continue;
		}
		let respawned = false;
		if (isVerifiedRunOrphaned(snapshot)) {
			try {
				respawnVerifiedSupervisor(runDir);
				respawned = true;
			} catch {
				// A concurrent parent may have respawned first; the watcher below
				// still collects the result.
			}
		}
		registerAdoptedWatcher(pi, manifest, runDir, options.updateWidget);
		adoptedRunDirs.add(runDir);
		outcomes.push({ runDir, runId: manifest.runId, action: respawned ? "respawned" : "watching" });
	}
	return outcomes;
}

function registerAdoptedWatcher(
	pi: Pick<ExtensionAPI, "sendMessage">,
	manifest: VerifiedRunManifest,
	runDir: string,
	updateWidget?: () => void,
): void {
	const reserved = manifest.request.candidateCount - 1;
	// The candidates are already paid for and running; adopting without a slot
	// is the lesser evil if the width is full. Delivery stays exactly-once via
	// the claim either way.
	tryAcquireSlots(reserved, getSpawnWidthLimit());
	const running: RunningSubagent = {
		id: manifest.runId.slice(-8),
		name: manifest.request.name,
		task: manifest.request.taskPrompt,
		title: manifest.request.title,
		agent: manifest.request.agent,
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "continue",
		blocking: false,
		async: true,
		autoExit: true,
		noSession: false,
		startTime: Date.parse(manifest.createdAt) || Date.now(),
		sessionFile: manifest.request.candidates[0]?.sessionFile ?? "",
		verifiedRunDir: runDir,
		verifiedRunId: manifest.runId,
	};
	running.completionPromise = releaseSpawnWidthSlotOnCompletion(
		running,
		(async (): Promise<SubagentResult> => {
			try {
				const final = await waitForVerifiedRunResult(runDir, {
					signal: moduleAbortController.signal,
				});
				const claim = claimVerifiedRunDelivery(runDir);
				const result = verifiedRunToSubagentResult(final, runDir, {
					name: manifest.request.name,
					task: manifest.request.taskPrompt,
				}, running.startTime);
				if (claim.claimed) deliverVerifiedRunResult(pi, final, runDir);
				return result;
			} finally {
				if (reserved > 0) releaseSlots(reserved);
				runningSubagents.delete(running.id);
				updateWidget?.();
			}
		})(),
	);
	claimSpawnWidthSlot(running);
	runningSubagents.set(running.id, running);
	updateWidget?.();
}

function deliverVerifiedRunResult(
	pi: Pick<ExtensionAPI, "sendMessage">,
	manifest: VerifiedRunManifest,
	runDir: string,
): void {
	const result = verifiedRunToSubagentResult(
		manifest,
		runDir,
		{ name: manifest.request.name, task: manifest.request.taskPrompt },
		Date.parse(manifest.createdAt) || Date.now(),
	);
	const selection = manifest.result?.selection ?? null;
	pi.sendMessage(
		{
			customType: "subagent_result",
			content: result.summary,
			display: true,
			details: {
				id: manifest.runId.slice(-8),
				name: manifest.request.name,
				task: manifest.request.taskPrompt,
				agent: manifest.request.agent,
				mode: "background",
				status: manifest.state === "completed" ? "completed" : "failed",
				deliveryState: "detached",
				parentClosePolicy: "continue",
				async: true,
				exitCode: result.exitCode,
				elapsed: result.elapsed,
				sessionFile: selection?.winnerSessionFile ?? manifest.request.candidates[0]?.sessionFile,
				verifiedRunId: manifest.runId,
				errorMessage: result.errorMessage,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}
