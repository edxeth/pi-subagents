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
const tmpRoot = join(tmpdir(), `pi-subagents-live-extensions-${process.pid}`);
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const agentsDir = join(configDir, "agents");
const extensionsDir = join(configDir, "extensions");
const allowedExtensionFile = join(extensionsDir, "live-e2e-allowed.ts");
const blockedExtensionFile = join(extensionsDir, "live-e2e-blocked.ts");
const snapshotsDir = join(tmpRoot, "snapshots");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const prompt = [
  "The subagent tool is available in this session.",
  "Use exactly this sequence.",
  'Call subagent with name "Live Default Child", agent "live-e2e-ext-default", task "Follow your exact built-in instructions.", and parentClosePolicy "terminate".',
  'Call subagent with name "Live Allow Child", agent "live-e2e-ext-allow", task "Follow your exact built-in instructions.", and parentClosePolicy "terminate".',
  'After both tool calls return, reply with exactly "LIVE_E2E_EXTENSIONS_OK" and nothing else.',
  "Do not call any other tools.",
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(extensionsDir, { recursive: true });
mkdirSync(snapshotsDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

writeFileSync(
  join(agentsDir, "live-e2e-ext-default.md"),
  `---\nname: live-e2e-ext-default\ndescription: Live extensions default-load smoke test agent.\nthinking: high\nauto-exit: true\nmode: background\nblocking: true\nspawning: false\n---\n\nFirst call \`allowed_probe_tool\`.\nThen call \`blocked_probe_tool\`.\nThen reply with exactly \`LIVE_EXT_DEFAULT_OK\`.`,
  "utf8",
);
writeFileSync(
  join(agentsDir, "live-e2e-ext-allow.md"),
  `---\nname: live-e2e-ext-allow\ndescription: Live extensions allowlist smoke test agent.\nthinking: high\nauto-exit: true\nmode: background\nblocking: true\nspawning: false\nextensions: ./extensions/live-e2e-allowed.ts\n---\n\nCall \`allowed_probe_tool\` exactly once.\nThen reply with exactly \`LIVE_EXT_ALLOW_OK\`.`,
  "utf8",
);

writeFileSync(
  allowedExtensionFile,
  `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "allowed_probe_tool",
    label: "Allowed Probe Tool",
    description: "Live extensions allowlist probe",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "ALLOWED_PROBE_OK" }],
        details: {},
      };
    },
  });

  pi.on("session_start", () => {
    const agent = process.env.PI_SUBAGENT_AGENT;
    if (!agent || !agent.startsWith("live-e2e-ext-")) return;
    const outDir = process.env.PI_E2E_EXT_SNAPSHOT_DIR;
    if (!outDir) return;
    setTimeout(() => {
      mkdirSync(outDir, { recursive: true });
      const out = join(outDir, agent + ".json");
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

writeFileSync(
  blockedExtensionFile,
  `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "blocked_probe_tool",
    label: "Blocked Probe Tool",
    description: "Live extensions blocked probe",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "BLOCKED_PROBE_OK" }],
        details: {},
      };
    },
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

function getToolResults(events, toolName, predicate = () => true) {
  return events.filter(
    (event) =>
      event.type === "message" &&
      event.message?.role === "toolResult" &&
      event.message.toolName === toolName &&
      predicate(event.message),
  ).map((event) => event.message);
}

function getParentEvents() {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes("LIVE_E2E_EXTENSIONS_OK")) {
      return { file, events };
    }
  }
  return null;
}

function readSnapshot(agentName) {
  const file = join(snapshotsDir, `${agentName}.json`);
  if (!existsSync(file)) {
    throw new Error(`Missing snapshot for ${agentName}: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
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
        PI_E2E_EXT_SNAPSHOT_DIR: snapshotsDir,
        PI_SUBAGENT_AGENT: "",
        PI_SUBAGENT_NAME: "",
        PI_SUBAGENT_AUTO_EXIT: "",
        PI_SUBAGENT_EXTENSIONS: "",
        PI_DENY_TOOLS: "",
        PI_ARTIFACT_PROJECT_ROOT: "",
      },
    },
  );

  const parent = getParentEvents();
  if (!parent) throw new Error("Could not find parent session events.");

  const assistantTexts = getAssistantTexts(parent.events);
  if (!assistantTexts.includes("LIVE_E2E_EXTENSIONS_OK")) {
    throw new Error("Parent did not produce LIVE_E2E_EXTENSIONS_OK.");
  }

  const subagentResults = getToolResults(
    parent.events,
    "subagent",
    (message) => message.details?.status === "completed" && !!message.details?.sessionFile,
  );
  if (subagentResults.length !== 2) {
    throw new Error(`Expected 2 subagent tool results, got ${subagentResults.length}.`);
  }

  const byName = new Map();
  for (const result of subagentResults) {
    const details = result.details ?? {};
    if (details.status !== "completed") {
      throw new Error(`Expected completed status, got ${details.status ?? "missing"}.`);
    }
    if (details.blocking !== true) {
      throw new Error(`Expected blocking true, got ${details.blocking ?? "missing"}.`);
    }
    if (!details.sessionFile || !existsSync(details.sessionFile)) {
      throw new Error("Missing child sessionFile.");
    }
    byName.set(details.name, details);
  }

  const defaultDetails = byName.get("Live Default Child");
  const allowDetails = byName.get("Live Allow Child");
  if (!defaultDetails || !allowDetails) {
    throw new Error(`Missing expected child results. Names seen: ${JSON.stringify([...byName.keys()])}`);
  }

  const defaultEvents = parseJsonl(defaultDetails.sessionFile);
  const allowEvents = parseJsonl(allowDetails.sessionFile);
  if (!getAssistantTexts(defaultEvents).some((text) => text.includes("LIVE_EXT_DEFAULT_OK"))) {
    throw new Error("Default child did not produce LIVE_EXT_DEFAULT_OK.");
  }
  if (!getAssistantTexts(allowEvents).some((text) => text.includes("LIVE_EXT_ALLOW_OK"))) {
    throw new Error("Allowlist child did not produce LIVE_EXT_ALLOW_OK.");
  }

  const defaultSnapshot = readSnapshot("live-e2e-ext-default");
  const allowSnapshot = readSnapshot("live-e2e-ext-allow");

  if (!defaultSnapshot.all?.includes("allowed_probe_tool") || !defaultSnapshot.all?.includes("blocked_probe_tool")) {
    throw new Error(`Default child did not load all probe extensions. Snapshot: ${JSON.stringify(defaultSnapshot)}`);
  }
  if (!defaultSnapshot.active?.includes("allowed_probe_tool") || !defaultSnapshot.active?.includes("blocked_probe_tool")) {
    throw new Error(`Default child did not keep both probe tools active. Snapshot: ${JSON.stringify(defaultSnapshot)}`);
  }
  if (!allowSnapshot.all?.includes("allowed_probe_tool")) {
    throw new Error(`Allowlist child did not load allowed_probe_tool. Snapshot: ${JSON.stringify(allowSnapshot)}`);
  }
  if (allowSnapshot.all?.includes("blocked_probe_tool") || allowSnapshot.active?.includes("blocked_probe_tool")) {
    throw new Error(`Allowlist child still loaded blocked_probe_tool. Snapshot: ${JSON.stringify(allowSnapshot)}`);
  }

  console.log(`live extensions ok: unrestricted child loaded both probe tools, allowlisted child loaded only allowed_probe_tool (${defaultDetails.id}, ${allowDetails.id})`);
} finally {
  for (const file of [allowedExtensionFile, blockedExtensionFile]) {
    try {
      unlinkSync(file);
    } catch {}
  }
  if (!keepTmp) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}
