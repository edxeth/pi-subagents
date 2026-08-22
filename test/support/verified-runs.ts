import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPackagedCriteriaDir } from "../../src/vf/criteria.ts";
import { newRunId } from "../../src/vf/supervisor/run-client.ts";
import { candidateWorktreeBranchName, candidateWorktreeDirName, preflightWorktreeSource } from "../../src/vf/worktrees.ts";
import { startVerifiedRun } from "../../src/vf/run/client.ts";
import { isTerminalRunState, readVerifiedRunManifest, type VerifiedRunManifest } from "../../src/vf/run/types.ts";
import { createTestDir, sleep, writeExecutable } from "./fixtures.ts";

/**
 * Shared fixture harness for verified fan-out supervisor tests: a clean git
 * repo, a fake `pi` candidate that writes real session JSONL, and a
 * supervised-run builder that talks to the REAL detached supervisor and the
 * REAL ticket-05 bridge (mock verifier backend; no live API key).
 */

export const FAKE_PI = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const session = process.env.PI_SUBAGENT_SESSION ?? "";
const captureDir = process.env.TEST_CAPTURE_DIR ?? "";
const markerMap = process.env.TEST_MARKER_MAP ? JSON.parse(process.env.TEST_MARKER_MAP) : {};
const slot = /-w(\\d+)$/.exec(process.env.COMPOSE_PROJECT_NAME ?? "");
const marker = process.env.TEST_MARKER ?? (slot ? markerMap[slot[1]] ?? "" : "");
const before = Number(process.env.TEST_DELAY_BEFORE_MS ?? "0");
const after = Number(process.env.TEST_DELAY_AFTER_MS ?? "0");

if (captureDir) {
	writeFileSync(
		join(captureDir, \`argv-\${process.pid}.json\`),
		JSON.stringify(
			{
				argv: process.argv,
				marker,
				compose: process.env.COMPOSE_PROJECT_NAME ?? "",
				portOffset: process.env.PORT_OFFSET ?? "",
				session,
				denyTools: process.env.PI_DENY_TOOLS ?? "",
				spawnBudget: process.env.PI_SUBAGENT_SPAWN_BUDGET ?? "",
			},
			null,
			2,
		),
	);
}
if (before > 0) await new Promise((resolve) => setTimeout(resolve, before));
if (session) {
	mkdirSync(dirname(session), { recursive: true });
	const e = (id, parentId, message) =>
		JSON.stringify({ type: "message", id, parentId, timestamp: "2026-08-22T00:00:00Z", message });
	appendFileSync(
		session,
		[
			e("m1", null, { role: "user", content: [{ type: "text", text: "candidate task prompt" }] }),
			e("m2", "m1", { role: "assistant", content: [{ type: "text", text: \`working; marker \${marker}\` }] }),
			e("m3", "m2", {
				role: "assistant",
				content: [{ type: "text", text: \`Final report for \${marker || "none"}: completed the task with tests passing.\` }],
			}),
		]
			.map((line) => line + "\\n")
			.join(""),
	);
}
if (process.env.TEST_CHANGE) writeFileSync("change.txt", process.env.TEST_CHANGE + "\\n");
if (after > 0) await new Promise((resolve) => setTimeout(resolve, after));
process.exit(Number(process.env.TEST_EXIT_CODE ?? "0"));
`;

export function gitRun(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

export function setupVerifiedRunFixture(): { repo: string; parent: string; fakePi: string; captureDir: string } {
	const parent = createTestDir();
	const repo = join(parent, "repo");
	mkdirSync(repo, { recursive: true });
	gitRun(repo, "init", "-q");
	gitRun(repo, "config", "user.email", "test@localhost");
	gitRun(repo, "config", "user.name", "Test");
	writeFileSync(join(repo, "README.md"), "# test repo\n", "utf8");
	gitRun(repo, "add", "-A");
	gitRun(repo, "commit", "-q", "-m", "base");
	const captureDir = join(parent, "captures");
	mkdirSync(captureDir, { recursive: true });
	const fakePi = writeExecutable(parent, "fake-pi.mjs", `#!/usr/bin/env node\n${FAKE_PI}`);
	chmodSync(fakePi, 0o755);
	return { repo, parent, fakePi, captureDir };
}

export interface CandidateFixture {
	marker: string;
	exitCode?: number;
	beforeMs?: number;
	afterMs?: number;
	change?: string;
}

export function buildSupervisedRun(
	repo: string,
	fakePi: string,
	captureDir: string,
	candidates: CandidateFixture[],
	options: {
		baseCommit?: string;
		baseDir?: string;
		/** Merged over the default verifier block (mock config, model, criteria). */
		verifier?: Partial<VerifiedRunManifest["request"]["verifier"]>;
	} = {},
): { runDir: string; runId: string } {
	const baseDir = options.baseDir ?? createTestDir();
	const runId = newRunId();
	const sessionDir = join(baseDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const baseCommit = options.baseCommit ?? preflightWorktreeSource(repo).baseCommit;
	const request = {
		kind: "verified-fanout" as const,
		name: "vf-test",
		title: "VF test run",
		piCommand: process.execPath,
		taskArtifact: join(baseDir, "task.md"),
		taskPrompt: "candidate task prompt",
		sourceRepo: repo,
		baseCommit,
		agent: "tester",
		candidateCount: candidates.length,
		candidates: candidates.map((candidate, i) => ({
			index: i + 1,
			sessionFile: join(sessionDir, `w${i + 1}.jsonl`),
			worktree: join(dirname(repo), candidateWorktreeDirName(repo, runId, i + 1)),
			internalBranch: candidateWorktreeBranchName(runId, i + 1),
			args: [fakePi],
			env: {
				PI_SUBAGENT_SESSION: join(sessionDir, `w${i + 1}.jsonl`),
				TEST_CAPTURE_DIR: captureDir,
				TEST_MARKER: candidate.marker,
				TEST_EXIT_CODE: String(candidate.exitCode ?? 0),
				TEST_DELAY_BEFORE_MS: String(candidate.beforeMs ?? 0),
				...(candidate.change ? { TEST_CHANGE: candidate.change } : {}),
			},
			launchEntryCount: 0,
		})),
		verifier: {
			model: "deepseek-v4-flash",
			thinking: null,
			env: {},
			criteriaPath: join(getPackagedCriteriaDir(), "generic.md"),
			mockVerifier: { goodMarker: "VF-GOOD", midMarker: "VF-MID" },
			...(options.verifier ?? {}),
		},
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
		},
		parentSessionId: null,
		createdAt: new Date().toISOString(),
	};
	const started = startVerifiedRun({ baseDir, runId, request });
	return { runDir: started.runDir, runId };
}

export async function waitForVerifiedRunState(runDir: string, state: string): Promise<VerifiedRunManifest> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const manifest = readVerifiedRunManifest(runDir);
		if (manifest.state === state) return manifest;
		if (isTerminalRunState(manifest.state)) {
			throw new Error(`run reached ${manifest.state} while waiting for ${state}: ${manifest.result?.failure?.message}`);
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for state ${state}`);
		await sleep(100);
	}
}
