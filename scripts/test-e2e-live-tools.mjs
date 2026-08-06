#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LIVE_TEST_MODEL } from "./live-test-guard.mjs";

const piBin = process.env.PI_E2E_PI_BIN ?? "pi";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const tmpRoot = join(tmpdir(), `pi-subagents-live-tools-${process.pid}`);
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const outputDir = join(tmpRoot, "snapshots");
const globalExtensionsDir = join(configDir, "extensions");
const extensionFile = join(globalExtensionsDir, "live-e2e-tools-snapshot.ts");
// Always source from the real user config.
const sourceConfigDir = join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const builtinTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const cases = [
	{ agent: "live-e2e-tools-omitted" },
	{ agent: "live-e2e-tools-all" },
	{ agent: "live-e2e-tools-none" },
	{ agent: "live-e2e-tools-read" },
	{ agent: "live-tools-probe" },
];
function getParentSentinel(agent) {
	return `LIVE_E2E_TOOLS_${agent.toUpperCase().replaceAll("-", "_")}_OK`;
}

function getPrompt(agent) {
	return [
		"The subagent tool is available in this session.",
		"Use exactly one subagent tool call and do not call any other tools.",
		`Call subagent with name "${agent}", agent "${agent}", title "${agent} live tools check", task "Follow your exact built-in instructions.", async false.`,
		`After the subagent tool call returns, reply with exactly "${getParentSentinel(agent)}" and nothing else.`,
	].join("\n");
}

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(configDir, "agents"), { recursive: true });
mkdirSync(globalExtensionsDir, { recursive: true });
mkdirSync(outputDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
	const source = join(sourceConfigDir, name);
	if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

function writeAgent(name, toolsLine) {
	writeFileSync(
		join(configDir, "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: Live tools frontmatter smoke test agent.\nthinking: off\nauto-exit: true\nmode: background\nasync: false\nspawning: false\nextensions: ${extensionFile}\n${toolsLine ? `${toolsLine}\n` : ""}---\n\nReply with exactly \`${name.toUpperCase().replaceAll("-", "_")}_OK\`.`,
		"utf8",
	);
}

writeAgent("live-e2e-tools-omitted", "");
writeAgent("live-e2e-tools-all", "tools: all");
writeAgent("live-e2e-tools-none", "tools: none");
writeAgent("live-e2e-tools-read", "tools: read");
writeAgent("live-tools-probe", "tools: read,e2e_snapshot_probe");
writeAgent("live-tools-typo", "tools: read,edti");

writeFileSync(
	extensionFile,
	`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "e2e_snapshot_probe",
    label: "E2E Snapshot Probe",
    description: "Live tools snapshot probe",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "SNAPSHOT_PROBE_OK" }], details: {} };
    },
  });

  function snapshot(phase: string) {
    const agent = process.env.PI_SUBAGENT_AGENT;
    if (!agent || (!agent.startsWith("live-e2e-tools-") && agent !== "live-tools-probe")) return;
    const outDir = process.env.PI_E2E_TOOLS_SNAPSHOT_DIR;
    if (!outDir) return;
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, agent + ".json");
    writeFileSync(
      out,
      JSON.stringify({
        phase,
        active: pi.getActiveTools(),
        all: pi.getAllTools().map((tool) => tool.name),
      }, null, 2),
      "utf8",
    );
  }

  pi.on("session_start", () => setTimeout(() => snapshot("session_start"), 250));
  pi.on("before_agent_start", () => setTimeout(() => snapshot("before_agent_start"), 0));
}
`,
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

function getParentEvents(agent) {
	const sentinel = getParentSentinel(agent);
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes(sentinel)) {
			return { file, events };
		}
	}
	return null;
}

function activeBuiltins(snapshot) {
	const active = snapshot.active ?? [];
	return builtinTools.filter((tool) => active.includes(tool));
}

function assertToolSnapshot(agent, snapshot) {
	const active = snapshot.active ?? [];
	if (!active.includes("caller_ping")) {
		throw new Error(`${agent} lost caller_ping extension tool. Snapshot: ${JSON.stringify(snapshot)}`);
	}
	if (agent === "live-e2e-tools-none" && !active.includes("e2e_snapshot_probe")) {
		throw new Error(`tools:none did not preserve extension tools. Snapshot: ${JSON.stringify(snapshot)}`);
	}
}

try {
	const snapshots = new Map();
	for (const { agent } of cases) {
		execFileSync(
			piBin,
			[
				"-p",
				"--model",
				LIVE_TEST_MODEL,
				"--no-extensions",
				"-e",
				extensionSource,
				"--session-dir",
				sessionDir,
				getPrompt(agent),
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_PACKAGE_DIR: "",
					PI_CODING_AGENT_DIR: configDir,
					PI_E2E_TOOLS_SNAPSHOT_DIR: outputDir,
					PI_SUBAGENT_AGENT: "",
					PI_SUBAGENT_NAME: "",
					PI_SUBAGENT_AUTO_EXIT: "",
					PI_DENY_TOOLS: "",
					PI_SUBAGENT_PI_COMMAND: piBin,
					PI_ARTIFACT_PROJECT_ROOT: "",
				},
			},
		);

		const parent = getParentEvents(agent);
		if (!parent) throw new Error(`${agent}: could not find parent session events.`);
		const assistantTexts = getAssistantTexts(parent.events);
		const sentinel = getParentSentinel(agent);
		if (!assistantTexts.includes(sentinel)) {
			throw new Error(`${agent}: parent did not produce ${sentinel}.`);
		}

		const subagentResults = getToolResults(parent.events, "subagent");
		if (subagentResults.length !== 1) {
			throw new Error(`${agent}: expected 1 subagent tool result, got ${subagentResults.length}.`);
		}
		const result = subagentResults[0];
		if (result.details?.agent !== agent && result.details?.name !== agent) {
			throw new Error(
				`${agent}: subagent result belonged to ${result.details?.agent ?? result.details?.name ?? "unknown"}.`,
			);
		}
		const details = result.details ?? {};
		if (details.status !== "completed")
			throw new Error(`${agent}: expected completed status, got ${details.status ?? "missing"}.`);
		if (details.async !== false)
			throw new Error(`${agent}: expected blocking true, got ${details.blocking ?? "missing"}.`);
		if (!details.sessionFile || !existsSync(details.sessionFile))
			throw new Error(`${agent}: missing child sessionFile.`);

		const childEvents = parseJsonl(details.sessionFile);
		const expectedText = `${agent.toUpperCase().replaceAll("-", "_")}_OK`;
		if (!getAssistantTexts(childEvents).some((text) => text.includes(expectedText))) {
			throw new Error(`${agent}: child did not produce ${expectedText}.`);
		}

		const snapshotFile = join(outputDir, `${agent}.json`);
		if (!existsSync(snapshotFile)) throw new Error(`${agent}: child did not write active tool snapshot.`);
		const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
		assertToolSnapshot(agent, snapshot);
		snapshots.set(agent, snapshot);
	}

	const omittedBuiltins = activeBuiltins(snapshots.get("live-e2e-tools-omitted"));
	const allBuiltins = activeBuiltins(snapshots.get("live-e2e-tools-all"));
	const noneBuiltins = activeBuiltins(snapshots.get("live-e2e-tools-none"));
	const readBuiltins = activeBuiltins(snapshots.get("live-e2e-tools-read"));
	const readProbe = snapshots.get("live-tools-probe");
	const readProbeBuiltins = activeBuiltins(readProbe);
	if (JSON.stringify(allBuiltins) !== JSON.stringify(omittedBuiltins)) {
		throw new Error(
			`tools:all differed from omitted tools. omitted=${omittedBuiltins.join(",")} all=${allBuiltins.join(",")}`,
		);
	}
	if (noneBuiltins.length !== 0) {
		throw new Error(`tools:none left built-ins active: ${noneBuiltins.join(",")}`);
	}
	if (JSON.stringify(readBuiltins) !== JSON.stringify(["read"])) {
		throw new Error(`tools:read active built-ins mismatch: ${readBuiltins.join(",")}`);
	}
	if (JSON.stringify(readProbeBuiltins) !== JSON.stringify(["read"])) {
		throw new Error(`tools:read,e2e_snapshot_probe active built-ins mismatch: ${readProbeBuiltins.join(",")}`);
	}
	if (!readProbe.active?.includes("e2e_snapshot_probe")) {
		throw new Error(
			`tools:read,e2e_snapshot_probe did not keep the extension tool active. Snapshot: ${JSON.stringify(readProbe)}`,
		);
	}

	// Typo warning (non-blocking): a likely built-in typo must NOT block the
	// launch; the child still runs, and the warning surfaces in the result so
	// the silent-drop is no longer silent. Driven through its own parent
	// invocation so the completion-asserting cases loop is unaffected.
	const typoAgent = "live-tools-typo";
	const typoSentinel = getParentSentinel(typoAgent);
	execFileSync(
		piBin,
		[
			"-p",
			"--model",
			LIVE_TEST_MODEL,
			"--no-extensions",
			"-e",
			extensionSource,
			"--session-dir",
			sessionDir,
			[
				"The subagent tool is available in this session.",
				"Use exactly one subagent tool call and do not call any other tools.",
				`Call subagent with name "${typoAgent}", agent "${typoAgent}", title "${typoAgent} live tools check", task "Follow your exact built-in instructions.", async false.`,
				`After the subagent tool call returns, reply with exactly "${typoSentinel}" and nothing else.`,
			].join("\n"),
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PI_PACKAGE_DIR: "",
				PI_CODING_AGENT_DIR: configDir,
				PI_E2E_TOOLS_SNAPSHOT_DIR: outputDir,
				PI_SUBAGENT_AGENT: "",
				PI_SUBAGENT_NAME: "",
				PI_SUBAGENT_AUTO_EXIT: "",
				PI_DENY_TOOLS: "",
				PI_SUBAGENT_PI_COMMAND: piBin,
				PI_ARTIFACT_PROJECT_ROOT: "",
			},
		},
	);
	const typoParent = getParentEvents(typoAgent);
	if (!typoParent) throw new Error(`${typoAgent}: could not find parent session events.`);
	if (!getAssistantTexts(typoParent.events).includes(typoSentinel)) {
		throw new Error(`${typoAgent}: parent did not produce ${typoSentinel}.`);
	}
	const typoResults = getToolResults(typoParent.events, "subagent");
	if (typoResults.length !== 1) {
		throw new Error(`${typoAgent}: expected 1 subagent tool result, got ${typoResults.length}.`);
	}
	const typoResult = typoResults[0];
	const typoText = (typoResult.content ?? []).map((c) => c.text ?? "").join(" ");
	if (!/may be a typo of built-in "edit"/.test(typoText)) {
		throw new Error(
			`${typoAgent}: expected non-blocking typo warning in the result. Result: ${JSON.stringify(typoResult)}`,
		);
	}
	if (typoResult.details?.status !== "completed") {
		throw new Error(
			`${typoAgent}: warning must be non-blocking; expected the child to still complete, got ${typoResult.details?.status}. Result: ${JSON.stringify(typoResult)}`,
		);
	}

	console.log(
		`live tools ok: omitted/all matched (${omittedBuiltins.join(",")}), none disabled built-ins, read narrowed built-ins, custom allowlist preserved extension tool, typo warning non-blocking (${LIVE_TEST_MODEL})`,
	);
} finally {
	try {
		unlinkSync(extensionFile);
	} catch {}
	if (!keepTmp) {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	}
}
