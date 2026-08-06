#!/usr/bin/env node
// MANUAL diagnostic: attempt to drive a live child past pi-core's compaction
// threshold. NOT part of the automated suite — model compliance is unreliable
// (some models refuse "useless padding" tasks, others cache aggressively),
// so this script is best-effort.
//
// The PRIMARY verification of compaction-handler integration lives in
// test/runtime/compaction-integration.test.ts, which imports pi-core's
// actual shouldCompact / calculateContextTokens / DEFAULT_COMPACTION_SETTINGS
// and proves the contract without needing a live LLM.
//
// Use this script only when investigating a specific real-world compaction
// regression. Most diagnostic value lives in the integration test.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PARENT_MODEL = process.env.FORK_LIVE_PARENT_MODEL ?? "nahcrof/deepseek-v4-flash:medium";
const CHILD_AGENT = "fork-compact-probe";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");

const tmpRoot = mkdtempSync(join(tmpdir(), "pi-fork-compact-"));
const sessionDir = join(tmpRoot, "sessions");

mkdirSync(sessionDir, { recursive: true });

// The child agent file must already be installed in ~/.pi/agent/agents/.
const userAgentsDir = join(homedir(), ".pi", "agent", "agents");
const installedAgentPath = join(userAgentsDir, `${CHILD_AGENT}.md`);
if (!existsSync(installedAgentPath)) {
	console.error(`[live-fork-compact] missing agent at ${installedAgentPath}`);
	process.exit(2);
}

const padCmd =
	'yes "padding line one padding line two padding line three padding line four padding line five padding line six padding line seven padding line eight" | head -3000';
const turnCount = 60;
const sequenceLines = [];
for (let i = 1; i <= turnCount; i++) {
	sequenceLines.push(`${i}. Call bash with the command. Wait for result.`);
}
sequenceLines.push(`${turnCount + 1}. Reply with exactly: DONE`);
const childTask = [
	"You are a test fixture. Run a sequence of bash calls.",
	"",
	`IMPORTANT: Make exactly ONE bash call per turn. Do NOT batch parallel tool calls. Wait for each result before issuing the next call. There must be ${turnCount} separate bash calls total, one per assistant turn.`,
	"",
	"The command to run is exactly:",
	padCmd,
	"",
	"Sequence:",
	...sequenceLines,
	"",
	"Rules:",
	"- ONE bash call per turn. Never multiple in one turn.",
	"- No other tool calls.",
	"- Do NOT investigate the workspace.",
	"- Do NOT read any file.",
	"- Just call bash, get the result, call bash again, repeat.",
].join("\n");
const parentPrompt = [
	`Immediately call the subagent tool with name "fork-compact-trim", agent "${CHILD_AGENT}", title "Fork compaction probe", and task ${JSON.stringify(childTask)}.`,
	`After the subagent returns, reply with exactly its result line and nothing else.`,
].join(" ");

console.log("[live-fork-compact] tmp:", tmpRoot);
console.log("[live-fork-compact] parent model:", PARENT_MODEL);

const piBin = "/home/devkit/.bun/bin/pi";
const env = {
	...process.env,
	PI_PACKAGE_DIR: "",
	PI_CODING_AGENT_SESSION_DIR: sessionDir,
	PI_SUBAGENT_FORK_TRIM_DEBUG: "1",
	PI_SUBAGENT_FORK_TRIM_DEBUG_LOG: join(tmpRoot, "fork-trim.log"),
};
delete env.PI_CODING_AGENT_DIR;

const args = [
	"-p",
	"--model",
	PARENT_MODEL,
	"--session-dir",
	sessionDir,
	"--no-extensions",
	"--extension",
	extensionSource,
	parentPrompt,
];

console.log("[live-fork-compact] running pi…");
const t0 = Date.now();
const result = spawnSync(piBin, args, {
	env,
	cwd: tmpRoot,
	stdio: ["ignore", "pipe", "pipe"],
	encoding: "utf8",
	timeout: 540_000,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[live-fork-compact] pi exited: status=${result.status} signal=${result.signal} elapsed=${elapsed}s`);

if (result.stderr) {
	const tail = result.stderr.slice(-512);
	if (tail.trim()) console.log("[live-fork-compact] stderr (last 512B):", tail);
}

const sessions = readdirSync(sessionDir, { withFileTypes: true })
	.filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
	.map((d) => join(sessionDir, d.name))
	.sort();

let childSession = null;
for (const path of sessions) {
	const firstLine = readFileSync(path, "utf8")
		.split("\n")
		.find((l) => l.trim());
	if (!firstLine) continue;
	let parsed;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		continue;
	}
	// Two ways to identify the child: `parentSession` (fork mode) or a
	// session `name` set by the subagent launcher (standalone mode). The
	// parent session never has either.
	if (parsed?.parentSession || (typeof parsed?.name === "string" && parsed.name.includes("agent]"))) {
		childSession = path;
	}
}
console.log("[live-fork-compact] child session:", childSession);

let pass = true;
if (!childSession) {
	console.log("  FAIL no child session produced");
	pass = false;
} else {
	const entries = readFileSync(childSession, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

	const compactions = entries.filter((e) => e?.type === "compaction");
	const assistants = entries.filter((e) => e?.type === "message" && e?.message?.role === "assistant");
	const usages = assistants.map((e) => e.message.usage?.input ?? 0).filter((v) => v > 0);
	const maxUsage = usages.length > 0 ? Math.max(...usages) : 0;

	console.log(`[live-fork-compact] assistants: ${assistants.length}`);
	console.log(`[live-fork-compact] max assistant usage.input: ${maxUsage}`);
	console.log(`[live-fork-compact] compaction entries: ${compactions.length}`);
	console.log(`[live-fork-compact] child session bytes: ${readFileSync(childSession).byteLength}`);

	if (compactions.length === 0) {
		console.log("  FAIL zero compaction entries — pi-core compaction did not fire");
		pass = false;
	} else {
		console.log(`  OK   ${compactions.length} compaction entries (pi-core compaction fired in child)`);
	}
	// The compaction trigger requires the child to have actually crossed the
	// threshold. If usage stayed below ~150K we have not really tested anything.
	if (maxUsage < 150_000) {
		console.log(
			`  WARN max usage ${maxUsage} stayed below 150K; the test may not have actually exercised the threshold`,
		);
	}
}

const debugPath = join(tmpRoot, "fork-trim.log");
if (existsSync(debugPath)) {
	console.log("[live-fork-compact] trim debug log:");
	console.log(readFileSync(debugPath, "utf8"));
}

if (process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1") {
	console.log("[live-fork-compact] keeping tmp:", tmpRoot);
} else {
	rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(pass ? 0 : 1);
