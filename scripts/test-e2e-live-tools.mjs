#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LIVE_TEST_MODEL } from "./live-test-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tmpRoot = join(tmpdir(), `pi-subagents-live-tools-${process.pid}`);
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const outputDir = join(tmpRoot, "snapshots");
const globalExtensionsDir = join(configDir, "extensions");
const extensionFile = join(globalExtensionsDir, "live-e2e-tools-snapshot.ts");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const builtinTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const cases = [
  { agent: "live-e2e-tools-omitted" },
  { agent: "live-e2e-tools-all" },
  { agent: "live-e2e-tools-none" },
  { agent: "live-e2e-tools-read" },
];
const prompt = [
  "The subagent tool is available in this session.",
  "Use exactly this sequence and do not call any other tools.",
  ...cases.map(
    ({ agent }) =>
      `Call subagent with name "${agent}", agent "${agent}", task "Follow your exact built-in instructions.", and parentClosePolicy "terminate".`,
  ),
  'After all subagent tool calls return, reply with exactly "LIVE_E2E_TOOLS_OK" and nothing else.',
].join("\n");

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
    `---\nname: ${name}\ndescription: Live tools frontmatter smoke test agent.\nthinking: off\nauto-exit: true\nmode: background\nblocking: true\nspawning: false\n${toolsLine ? `${toolsLine}\n` : ""}---\n\nReply with exactly \`${name.toUpperCase().replaceAll("-", "_")}_OK\`.`,
    "utf8",
  );
}

writeAgent("live-e2e-tools-omitted", "");
writeAgent("live-e2e-tools-all", "tools: all");
writeAgent("live-e2e-tools-none", "tools: none");
writeAgent("live-e2e-tools-read", "tools: read");

writeFileSync(
  extensionFile,
  `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
    if (!agent || !agent.startsWith("live-e2e-tools-")) return;
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
        event.type === "message" &&
        event.message?.role === "toolResult" &&
        event.message.toolName === toolName,
    )
    .map((event) => event.message);
}

function getParentEvents() {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes("LIVE_E2E_TOOLS_OK")) {
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
  execFileSync(
    "pi",
    [
      "-p",
      "--model",
      LIVE_TEST_MODEL,
      "--no-extensions",
      "-e",
      "./src/subagents/index.ts",
      "-e",
      "./src/session-artifacts/index.ts",
      "--session-dir",
      sessionDir,
      prompt,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: configDir,
        PI_E2E_TOOLS_SNAPSHOT_DIR: outputDir,
        PI_SUBAGENT_AGENT: "",
        PI_SUBAGENT_NAME: "",
        PI_SUBAGENT_AUTO_EXIT: "",
        PI_DENY_TOOLS: "",
        PI_ARTIFACT_PROJECT_ROOT: "",
      },
    },
  );

  const parent = getParentEvents();
  if (!parent) throw new Error("Could not find parent session events.");
  const assistantTexts = getAssistantTexts(parent.events);
  if (!assistantTexts.includes("LIVE_E2E_TOOLS_OK")) {
    throw new Error("Parent did not produce LIVE_E2E_TOOLS_OK.");
  }

  const subagentResults = getToolResults(parent.events, "subagent");
  if (subagentResults.length !== cases.length) {
    throw new Error(`Expected ${cases.length} subagent tool results, got ${subagentResults.length}.`);
  }
  const snapshots = new Map();
  for (const { agent } of cases) {
    const result = subagentResults.find(
      (message) => message.details?.agent === agent || message.details?.name === agent,
    );
    if (!result) throw new Error(`Missing subagent result for ${agent}.`);
    const details = result.details ?? {};
    if (details.status !== "completed") throw new Error(`${agent}: expected completed status, got ${details.status ?? "missing"}.`);
    if (details.blocking !== true) throw new Error(`${agent}: expected blocking true, got ${details.blocking ?? "missing"}.`);
    if (!details.sessionFile || !existsSync(details.sessionFile)) throw new Error(`${agent}: missing child sessionFile.`);

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
  if (JSON.stringify(allBuiltins) !== JSON.stringify(omittedBuiltins)) {
    throw new Error(`tools:all differed from omitted tools. omitted=${omittedBuiltins.join(",")} all=${allBuiltins.join(",")}`);
  }
  if (noneBuiltins.length !== 0) {
    throw new Error(`tools:none left built-ins active: ${noneBuiltins.join(",")}`);
  }
  if (JSON.stringify(readBuiltins) !== JSON.stringify(["read"])) {
    throw new Error(`tools:read active built-ins mismatch: ${readBuiltins.join(",")}`);
  }

  console.log(`live tools ok: omitted/all matched (${omittedBuiltins.join(",")}), none disabled built-ins, read narrowed built-ins (${LIVE_TEST_MODEL})`);
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
