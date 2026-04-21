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
const tmpRoot = join(tmpdir(), `pi-subagents-live-deny-${process.pid}`);
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const outputFile = join(tmpRoot, "active-tools.json");
const globalExtensionsDir = join(configDir, "extensions");
const extensionFile = join(globalExtensionsDir, "live-e2e-deny-tools.ts");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const prompt = [
  "The subagent tool is available in this session.",
  "Use exactly this sequence.",
  'Call subagent with name "Live Deny Child", agent "live-e2e-deny", task "Follow your exact built-in instructions.", and parentClosePolicy "terminate".',
  'After the tool returns, reply with exactly "LIVE_E2E_DENY_OK" and nothing else.',
  "Do not call any other tools.",
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(configDir, "agents"), { recursive: true });
mkdirSync(globalExtensionsDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}
writeFileSync(
  join(configDir, "agents", "live-e2e-deny.md"),
  `---\nname: live-e2e-deny\ndescription: Live deny-tools smoke test agent.\nthinking: off\nauto-exit: true\nmode: background\nblocking: true\nspawning: false\ndeny-tools: e2e_probe_tool\n---\n\nReply with exactly \`LIVE_DENY_CHILD_OK\`.`,
  "utf8",
);
writeFileSync(
  extensionFile,
  `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "e2e_probe_tool",
    label: "E2E Probe Tool",
    description: "Live deny-tools probe",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "E2E probe active." }],
        details: {},
      };
    },
  });

  pi.on("session_start", () => {
    if (process.env.PI_SUBAGENT_AGENT !== "live-e2e-deny") return;
    const out = process.env.PI_E2E_DENY_TOOLS_OUT;
    if (!out) return;
    setTimeout(() => {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify({
          active: pi.getActiveTools(),
          all: pi.getAllTools().map((tool) => tool.name),
        }, null, 2),
        "utf8",
      );
    }, 0);
  });
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

function getToolResult(events, toolName) {
  return events.find(
    (event) =>
      event.type === "message" &&
      event.message?.role === "toolResult" &&
      event.message.toolName === toolName,
  )?.message;
}

function getParentEvents() {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes("LIVE_E2E_DENY_OK")) {
      return { file, events };
    }
  }
  return null;
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
        PI_E2E_DENY_TOOLS_OUT: outputFile,
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
  if (!assistantTexts.includes("LIVE_E2E_DENY_OK")) {
    throw new Error("Parent did not produce LIVE_E2E_DENY_OK.");
  }

  const subagentResult = getToolResult(parent.events, "subagent");
  if (!subagentResult) throw new Error("Parent did not emit a subagent tool result.");
  const details = subagentResult.details ?? {};
  if (details.status !== "completed") throw new Error(`Expected completed status, got ${details.status ?? "missing"}.`);
  if (details.blocking !== true) throw new Error(`Expected blocking true, got ${details.blocking ?? "missing"}.`);
  if (!details.sessionFile || !existsSync(details.sessionFile)) throw new Error("Missing child sessionFile.");

  const childEvents = parseJsonl(details.sessionFile);
  if (!getAssistantTexts(childEvents).some((text) => text.includes("LIVE_DENY_CHILD_OK"))) {
    throw new Error("Child did not produce LIVE_DENY_CHILD_OK.");
  }

  if (!existsSync(outputFile)) throw new Error("Child did not write active tool snapshot.");
  const snapshot = JSON.parse(readFileSync(outputFile, "utf8"));
  const active = snapshot.active ?? [];
  const all = snapshot.all ?? [];

  if (!all.includes("e2e_probe_tool")) {
    throw new Error(`Probe tool was not loaded. Snapshot: ${JSON.stringify(snapshot)}`);
  }
  if (active.includes("e2e_probe_tool")) {
    throw new Error(`Probe tool was still active after deny-tools filtering. Snapshot: ${JSON.stringify(snapshot)}`);
  }

  console.log(`live deny-tools ok: denied e2e_probe_tool while loaded in child session (${details.id})`);
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
