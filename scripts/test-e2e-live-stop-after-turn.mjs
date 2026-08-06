#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LIVE_TEST_MODEL } from "./live-test-guard.mjs";

const piBin = process.env.PI_E2E_PI_BIN ?? "pi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const tmpRoot = join(tmpdir(), `pi-subagents-live-stop-after-turn-${process.pid}`);
const configDir = join(tmpRoot, "agent");
const workDir = join(tmpRoot, "work");
const agentsDir = join(workDir, ".pi", "agents");
const optOutSingleSessionDir = join(tmpRoot, "opt-out-single-sessions");
// Always source from the real user config.
const sourceConfigDir = join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

mkdirSync(configDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(optOutSingleSessionDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
	const source = join(sourceConfigDir, name);
	if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

writeFileSync(
	join(agentsDir, "live-stop-bg.md"),
	`---\nname: live-stop-bg\ndescription: Async child for stop-after-turn live regression.\nthinking: off\nauto-exit: true\nmode: background\nasync: true\n---\n\nReply exactly: LIVE_STOP_BG_OK`,
	"utf8",
);

function listJsonlFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listJsonlFiles(fullPath));
			continue;
		}
		if (entry.isFile() && fullPath.endsWith(".jsonl")) files.push(fullPath);
	}
	return files;
}

function parseJsonl(file) {
	const events = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
	return events;
}

function getUserText(events) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === "user")
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getAssistantTexts(events) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === "assistant")
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim());
}

function getToolResults(events, toolName) {
	return events
		.filter(
			(event) =>
				event.type === "message" && event.message?.role === "toolResult" && event.message.toolName === toolName,
		)
		.map((event) => event.message);
}

function findParentSession(sessionDir, marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes(marker)) return { file, events };
	}
	throw new Error(`Could not find parent session for ${marker}.`);
}

function runPi(sessionDir, prompt, extraEnv = {}) {
	execFileSync(
		piBin,
		["-p", "--model", LIVE_TEST_MODEL, "--no-extensions", "-e", extensionSource, "--session-dir", sessionDir, prompt],
		{
			cwd: workDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_PACKAGE_DIR: "",
				PI_CODING_AGENT_DIR: configDir,
				PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS: "1",
				PI_SUBAGENT_AGENT: "",
				PI_SUBAGENT_NAME: "",
				PI_SUBAGENT_AUTO_EXIT: "",
				PI_DENY_TOOLS: "",
				PI_SUBAGENT_PI_COMMAND: piBin,
				PI_ARTIFACT_PROJECT_ROOT: "",
				PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN: "",
				...extraEnv,
			},
		},
	);
}

try {
	const optOutSingleMarker = "LIVE_STOP_OPT_OUT_SINGLE_MARKER";
	runPi(
		optOutSingleSessionDir,
		[
			optOutSingleMarker,
			"Use exactly this sequence.",
			'First call subagent with name "live-stop-bg", agent "live-stop-bg", title "Live opt out async check", task "Run the opt-out async check."., and async true.',
			'After the subagent tool result, write exactly "OPT_OUT_SINGLE_CONTINUED" and nothing else.',
			"Do not call any other tools.",
		].join("\n"),
		{ PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN: "1" },
	);

	const optOutSingle = findParentSession(optOutSingleSessionDir, optOutSingleMarker);
	const optOutSingleResults = getToolResults(optOutSingle.events, "subagent");
	if (optOutSingleResults.length !== 1) {
		throw new Error(`Expected one opt-out async subagent result, got ${optOutSingleResults.length}.`);
	}
	const optOutSingleDetails = optOutSingleResults[0].details ?? {};
	if (!optOutSingleDetails.sessionFile || !existsSync(optOutSingleDetails.sessionFile)) {
		throw new Error("Opt-out async subagent result missing sessionFile.");
	}
	const optOutSingleTexts = getAssistantTexts(optOutSingle.events).join("\n");
	if (!optOutSingleTexts.includes("OPT_OUT_SINGLE_CONTINUED")) {
		throw new Error("Opt-out single run did not continue after async subagent launch.");
	}

	console.log(`live stop-after-turn ok: opt-out continuation verified (${LIVE_TEST_MODEL})`);
} finally {
	if (!keepTmp) {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	}
}
