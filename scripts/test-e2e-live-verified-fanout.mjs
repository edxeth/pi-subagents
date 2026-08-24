#!/usr/bin/env node
/**
 * Live e2e: verified fan-out end to end with real model candidates and a real
 * DeepSeek verifier (ticket 09).
 *
 * What runs for real:
 *   - the real launch path (launchVerifiedFanOut) from this source tree
 *   - a real detached supervisor and real candidate git worktrees
 *   - two real pi candidate sessions on zai/glm-5-turbo:high (live model calls
 *     that actually fix a failing test in their worktree)
 *   - one deliberately-broken candidate FIXTURE (sanctioned by the SPEC's
 *     testing decisions): a scripted session whose transcript writes a wrong
 *     fix, runs no verification, and claims success — it must rank LAST
 *   - the real llm-verifier tournament against the live DeepSeek API
 *   - the guarded winner apply (cherry-pick --no-commit + tree equality)
 *
 * Gates: PI_SUBAGENT_ALLOW_VERIFIED_E2E=1 and DEEPSEEK_API_KEY in the env.
 * This test spends real model tokens; it is never part of `npm test`.
 *
 * Usage:
 *   PI_SUBAGENT_ALLOW_VERIFIED_E2E=1 DEEPSEEK_API_KEY=... \
 *     node scripts/test-e2e-live-verified-fanout.mjs
 */

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
	if (!condition) throw new Error(`assert failed: ${message}`);
}

function git(cwd, ...args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function fail(message) {
	throw new Error(message);
}

if (process.env.PI_SUBAGENT_ALLOW_VERIFIED_E2E !== "1") {
	fail(
		"Refusing to run without PI_SUBAGENT_ALLOW_VERIFIED_E2E=1. " +
			"This live e2e spends real model tokens (zai candidates + a DeepSeek verifier tournament).",
	);
}
if (!process.env.DEEPSEEK_API_KEY) {
	fail("DEEPSEEK_API_KEY must be set in the environment for the live DeepSeek verifier.");
}

const CANDIDATE_MODEL = process.env.PI_SUBAGENT_VF_E2E_MODEL ?? "zai/glm-5-turbo:high";
const BROKEN_SLOT = Number(process.env.PI_SUBAGENT_VF_E2E_BROKEN_SLOT ?? 3);
const RUN_TIMEOUT_MS = Number(process.env.PI_SUBAGENT_VF_E2E_TIMEOUT_MS ?? 25 * 60_000);
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

const tmpRoot = mkdtempSync(join(tmpdir(), "pi-vf-e2e-"));
const configDir = join(tmpRoot, "agent");
const repo = join(tmpRoot, "repo");
const captureDir = join(tmpRoot, "captures");
const artifactsRoot = join(tmpRoot, "artifacts");
const sessionsDir = join(tmpRoot, "sessions");
for (const dir of [join(configDir, "agents"), repo, captureDir, artifactsRoot, sessionsDir]) {
	mkdirSync(dir, { recursive: true });
}

console.error(`[vf-e2e] tmp root: ${tmpRoot}`);
console.error(`[vf-e2e] candidate model: ${CANDIDATE_MODEL} (broken fixture in slot w${BROKEN_SLOT})`);

// Isolated pi config for the real candidate sessions: the user's credentials
// and model catalog, but no ambient extensions/MCP servers.
const sourceConfigDir =
	process.env.PI_CODING_AGENT_DIR && existsSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"))
		? process.env.PI_CODING_AGENT_DIR
		: join(homedir(), ".pi", "agent");
for (const name of ["auth.json", "settings.json", "models.json"]) {
	const source = join(sourceConfigDir, name);
	if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

// Reuse the pre-provisioned verifier venv when it exists (the temp
// PI_CODING_AGENT_DIR would otherwise re-provision a fresh one).
const userVenv = join(sourceConfigDir, "llm-verifier-venv");
if (!process.env.PI_SUBAGENT_LLM_VERIFIER_VENV && existsSync(join(userVenv, "marker.json"))) {
	process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = userVenv;
}

// Root-caller hygiene (mirrors live-test-common.mjs): this script is a root
// session, so inherited spawn-grant variables must be absent, not blank.
for (const name of [
	"PI_SUBAGENT_SPAWNABLE",
	"PI_SUBAGENT_SPAWN_BUDGET",
	"PI_SUBAGENT_SPAWN_DEPTH",
	"PI_SUBAGENT_SPAWN_WIDTH",
	"PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE",
	"PI_SUBAGENT_EXTENSIONS",
	"PI_SUBAGENT_AGENT",
	"PI_SUBAGENT_NAME",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_VF_MOCK_VERIFIER",
	"PI_DENY_TOOLS",
	"PI_ARTIFACT_PROJECT_ROOT",
	"PI_PACKAGE_DIR",
	"PI_SUBAGENT_PI_COMMAND",
]) {
	delete process.env[name];
}
process.env.PI_CODING_AGENT_DIR = configDir;
process.env.PI_ARTIFACT_PROJECT_ROOT = artifactsRoot;

// --- fixture repo: a failing test the candidates must fix -------------------

const BUGGY_STATS = `export function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}
`;

const STATS_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { median } from "../lib/stats.js";

test("median of odd-length input", () => {
	assert.equal(median([3, 1, 2]), 2);
});

test("median of even-length input", () => {
	assert.equal(median([4, 1, 3, 2]), 2.5);
});
`;

mkdirSync(join(repo, "lib"));
mkdirSync(join(repo, "test"));
mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
writeFileSync(join(repo, "lib", "stats.js"), BUGGY_STATS);
writeFileSync(join(repo, "test", "stats.test.js"), STATS_TEST);
writeFileSync(
	join(repo, ".pi", "agents", "vf-fix-worker.md"),
	[
		"---",
		"description: Verified fan-out live e2e worker (ticket 09)",
		`model: ${CANDIDATE_MODEL}`,
		"llm-as-a-verifier: true",
		"llm-as-a-verifier-candidates: 3",
		"llm-as-a-verifier-criteria: code-change",
		"llm-as-a-verifier-model: deepseek/deepseek-v4-flash",
		"---",
		"You are a careful code-fixing worker. Reproduce failures before editing, keep changes minimal, and verify with the project's own test command before reporting.",
		"",
	].join("\n"),
);
git(repo, "init", "-q");
git(repo, "config", "user.email", "vf-e2e@localhost");
git(repo, "config", "user.name", "VF E2E");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base: buggy median + failing test");
const baseCommit = git(repo, "rev-parse", "HEAD");

const pre = spawnSync(process.execPath, ["--test", "test/stats.test.js"], { cwd: repo, encoding: "utf8" });
assert(pre.status !== 0, "fixture test must fail at the base commit");

// --- candidate router: real pi for two slots, broken fixture for one --------

const router = join(__dirname, "live-vf-candidate-router.mjs");
process.env.PI_SUBAGENT_PI_COMMAND = `${process.execPath} ${router}`;
process.env.VF_E2E_CAPTURE_DIR = captureDir;
process.env.VF_E2E_BROKEN_SLOT = String(BROKEN_SLOT);
process.env.VF_E2E_REAL_PI = process.env.VF_E2E_REAL_PI ?? "pi";

// --- launch the fan-out through the real orchestration path ----------------

const { launchVerifiedFanOut } = await import("../src/vf/run/launch.ts");
const { loadAgentDefaults } = await import("../src/agents/definitions.ts");
const { resolveSubagentCwd } = await import("../src/launch/runtime-paths.ts");
const { readVerifiedRunManifest } = await import("../src/vf/run/types.ts");
const { candidateWorktreeBranchName } = await import("../src/vf/worktrees.ts");

const ctx = {
	cwd: repo,
	sessionManager: {
		getSessionFile: () => join(sessionsDir, "parent-session.jsonl"),
		getSessionId: () => "vf-e2e-parent",
		getLeafId: () => null,
	},
};
const agentDefs = loadAgentDefaults("vf-fix-worker", undefined, repo, resolveSubagentCwd);
assert(agentDefs?.llmAsVerifier === true, "agent definition must parse as a verified fan-out agent");

const task =
	"Your current working directory is an isolated copy of a small repository containing lib/stats.js and test/stats.test.js. " +
	"All paths in this task are relative to that directory; work only inside it and never modify files elsewhere. " +
	"The median() function in lib/stats.js returns the wrong value for even-length inputs. " +
	"Run `node --test test/stats.test.js` to see the failure, fix lib/stats.js so both tests pass, " +
	"run the tests again to confirm, and finish with a short report. Do not modify the test file.";

console.error("[vf-e2e] launching verified fan-out (3 candidates, code-change criteria, DeepSeek verifier)...");
const launchStartedAt = Date.now();
const { running, runDir, runId } = await launchVerifiedFanOut(
	{ name: "vf-e2e", title: "VF live e2e", task, agent: "vf-fix-worker" },
	agentDefs,
	ctx,
);

let result;
try {
	result = await Promise.race([
		running.completionPromise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`run did not finish within ${RUN_TIMEOUT_MS}ms`)), RUN_TIMEOUT_MS)),
	]);
} catch (error) {
	try {
		const { cancelVerifiedRun } = await import("../src/vf/run/client.ts");
		cancelVerifiedRun(runDir);
	} catch {}
	throw error;
}

// --- assertions -------------------------------------------------------------

const elapsedMin = ((Date.now() - launchStartedAt) / 60_000).toFixed(1);
const manifest = readVerifiedRunManifest(runDir);
const selection = manifest.result?.selection;
const apply = manifest.result?.apply;

assert(manifest.state === "completed", `run state is ${manifest.state}, failure: ${manifest.result?.failure?.message}`);
assert(manifest.result?.ok === true, "run result must be ok");
assert(result.exitCode === 0, `routed result exit code ${result.exitCode}: ${result.errorMessage}`);

// The single logical result carries the verification footer.
assert(/\[llm-as-a-verifier [^\]]+: winner w[12] of 3 attempts/.test(result.summary), `footer winner line: ${result.summary.slice(-400)}`);
assert(/criteria root_cause\+code_review\+verification/.test(result.summary), "footer shows the code-change criteria ids");
assert(/verifier deepseek-v4-flash \(\d+ calls, \d+ in \/ \d+ out tokens\)/.test(result.summary), "footer shows verifier usage");
assert(/staged — inspect/.test(result.summary), "footer reports the winner as staged with inspect command");

// The deliberately-broken candidate must rank LAST against live candidates.
assert(selection, "selection recorded");
assert(selection.ranking.length >= 2, "at least two distinct candidates were ranked");
assert(
	selection.ranking[selection.ranking.length - 1] === BROKEN_SLOT,
	`deliberately-broken candidate w${BROKEN_SLOT} must rank last; ranking: ${JSON.stringify(selection.ranking)}`,
);
assert(selection.winnerIndex !== BROKEN_SLOT, "winner must be a real candidate");
assert(selection.usage.calls > 0 && selection.usage.inputTokens > 0, "live DeepSeek usage recorded");
assert(selection.model === "deepseek-v4-flash", `verifier model echo: ${selection.model}`);

// Criteria precedence in the live path: the frontmatter value won.
assert(
	/[/\\]code-change\.md$/.test(manifest.request.verifier.criteriaPath),
	`frontmatter criteria must be threaded live: ${manifest.request.verifier.criteriaPath}`,
);

// The broken trace is the fixture transcript; the winner actually verified.
const brokenTrace = readFileSync(join(runDir, "traces", `w${BROKEN_SLOT}.txt`), "utf8");
assert(/\[Command\] write lib\/stats\.js/.test(brokenTrace), "broken trace shows the unverified write");
assert(!/\[Command\] node/.test(brokenTrace), "broken trace never runs a command");
const winnerTrace = readFileSync(join(runDir, "traces", `w${selection.winnerIndex}.txt`), "utf8");
assert(/--test|stats\.test\.js/.test(winnerTrace), "winner trace shows real verification");

// Real pi candidates really ran on the requested model with byte-identical prompts.
const captures = readdirSync(captureDir).filter((name) => name.startsWith("argv-"));
assert(captures.length === 3, `expected 3 candidate launches, saw ${captures.length}`);
const captured = captures.map((name) => JSON.parse(readFileSync(join(captureDir, name), "utf8")));
for (const capture of captured) {
	assert(/glm-5-turbo/.test(capture.modelArg ?? ""), `candidate --model must be glm-5-turbo: ${capture.modelArg}`);
}
const taskArgs = captured.map((capture) => capture.taskArg);
assert(new Set(taskArgs).size === 1, `byte-identical task artifact arg: ${JSON.stringify(taskArgs)}`);

// Guarded apply: winner staged onto the unmoved base, worktrees gone, branches kept.
assert(apply?.applied === true, `winner applied: ${apply?.code}`);
assert(git(repo, "rev-parse", "HEAD") === baseCommit, "apply must not move HEAD");
const staged = git(repo, "status", "--porcelain");
assert(/^M\s+lib\/stats\.js$/m.test(staged), `staged winner change: ${staged}`);
const post = spawnSync(process.execPath, ["--test", "test/stats.test.js"], { cwd: repo, encoding: "utf8" });
assert(post.status === 0, `applied winner fix must pass the test suite:\n${post.stdout}\n${post.stderr}`);
const worktreeDirs = readdirSync(tmpRoot).filter((name) => name.includes("-vf-"));
assert(worktreeDirs.length === 0, `worktree dirs must be removed after apply: ${worktreeDirs.join(", ")}`);
for (let index = 1; index <= 3; index++) {
	const branch = candidateWorktreeBranchName(runId, index);
	const refCheck = spawnSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	assert(refCheck.status === 0, `candidate branch ${branch} must be retained for audit`);
}

console.error(`[vf-e2e] PASS in ${elapsedMin} min`);
console.error(`[vf-e2e] ranking: ${JSON.stringify(selection.ranking)} (w${BROKEN_SLOT} deliberately broken, ranked last)`);
console.error(`[vf-e2e] winner w${selection.winnerIndex} score ${selection.winnerScore.toFixed(3)}, verifier ${JSON.stringify(selection.usage)}`);
console.error(`[vf-e2e] artifacts: ${runDir}`);

if (!keepTmp) {
	try {
		rmSync(tmpRoot, { recursive: true, force: true });
	} catch {}
}
