/**
 * Verified fan-out display data for the running-children widget.
 *
 * The widget needs one row per candidate plus the run phase; both live in the
 * durable manifest the supervisor already maintains. Reads are cached by
 * manifest mtime so the 80ms render tick never re-parses an unchanged file.
 */

import { statSync } from "node:fs";
import { readVerifiedRunManifest, verifiedRunFilePaths, type VerifiedRunManifest } from "./run/types.ts";

export interface VerifiedCandidateDisplay {
	/** 1-based candidate index, matching the run's worktree and branch naming. */
	index: number;
	/** Candidate session JSONL; per-candidate stats parse from here. */
	sessionFile: string;
	settled: boolean;
	exitCode: number | null;
	exitSignal: string | null;
}

export interface VerifiedRunDisplay {
	runId: string;
	state: VerifiedRunManifest["state"];
	candidateCount: number;
	candidates: VerifiedCandidateDisplay[];
}

const displayCache = new Map<string, { mtimeMs: number; display: VerifiedRunDisplay | null }>();

/** Read the run's display state, or null when the manifest is missing or unreadable. */
export function readVerifiedRunDisplay(runDir: string): VerifiedRunDisplay | null {
	try {
		const mtimeMs = statSync(verifiedRunFilePaths(runDir).manifest).mtimeMs;
		const cached = displayCache.get(runDir);
		if (cached && cached.mtimeMs === mtimeMs) return cached.display;
		const manifest = readVerifiedRunManifest(runDir);
		const display: VerifiedRunDisplay = {
			runId: manifest.runId,
			state: manifest.state,
			candidateCount: manifest.request.candidateCount,
			candidates: manifest.request.candidates.map((spec) => {
				const runtime = manifest.candidates.find((candidate) => candidate.index === spec.index);
				return {
					index: spec.index,
					sessionFile: spec.sessionFile,
					settled: runtime?.settled ?? false,
					exitCode: runtime?.exitCode ?? null,
					exitSignal: runtime?.exitSignal ?? null,
				};
			}),
		};
		displayCache.set(runDir, { mtimeMs, display });
		return display;
	} catch {
		displayCache.set(runDir, { mtimeMs: -1, display: null });
		return null;
	}
}
