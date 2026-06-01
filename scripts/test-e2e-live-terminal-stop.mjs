#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { LIVE_TEST_MODEL } from "./live-test-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagents-live-terminal-stop-"));
const configDir = join(tmpRoot, "agent");
const sessionDir = join(tmpRoot, "sessions");
const workDir = join(tmpRoot, "work");
const agentsDir = join(workDir, ".pi", "agents");
const fakePi = join(tmpRoot, "fake-pi.mjs");
const sourceConfigDir = join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

mkdirSync(configDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

writeFileSync(
  join(agentsDir, "terminal-stop.md"),
  `---\nname: terminal-stop\ndescription: Background child that reproduces terminal no-text stop handling.\nmode: background\nauto-exit: true\nasync: false\n---\n\nThis body is not used by the fake child.`,
  "utf8",
);

writeFileSync(
  fakePi,
  `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const sessionFile = process.env.PI_SUBAGENT_SESSION;
if (!sessionFile) throw new Error("PI_SUBAGENT_SESSION missing");
mkdirSync(dirname(sessionFile), { recursive: true });
const now = new Date().toISOString();
const entries = [
  {
    type: "message",
    id: "fake-status",
    timestamp: now,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I'll review the diff now." }],
    },
  },
  {
    type: "message",
    id: "fake-tool-result",
    timestamp: now,
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "intermediate command output" }],
    },
  },
  {
    type: "message",
    id: "fake-terminal-stop",
    timestamp: now,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "still reviewing" }],
      stopReason: "length",
    },
  },
];
for (const entry of entries) appendFileSync(sessionFile, JSON.stringify(entry) + "\\n", "utf8");
`,
  { mode: 0o755 },
);

function listJsonlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsonlFiles(fullPath));
    else if (entry.isFile() && fullPath.endsWith(".jsonl")) files.push(fullPath);
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

function findParentSession(marker) {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes(marker)) return { file, events };
  }
  throw new Error(`Could not find parent session for ${marker}.`);
}

try {
  const marker = "LIVE_TERMINAL_STOP_MARKER";
  const stdout = execFileSync(
    "pi",
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
        marker,
        "Call subagent exactly once with name terminal-stop-child, agent terminal-stop, title Terminal stop regression, and task Run terminal stop regression.",
        "Do not call any other tools.",
      ].join("\n"),
    ],
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
        PI_SUBAGENT_PI_COMMAND: `node ${fakePi}`,
        PI_ARTIFACT_PROJECT_ROOT: "",
      },
    },
  );

  const parent = findParentSession(marker);
  const subagentResults = getToolResults(parent.events, "subagent");
  if (subagentResults.length !== 1) {
    throw new Error(`Expected one subagent result, got ${subagentResults.length}.`);
  }
  const resultText = subagentResults[0].content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n") ?? "";
  const resultDetails = subagentResults[0].details ?? {};
  const parentText = `${stdout}\n${getAssistantTexts(parent.events).join("\n")}`;

  if (!resultText.includes("Subagent stopped before producing a result (stopReason: length)")) {
    throw new Error(`Expected terminal stop summary, got: ${resultText}`);
  }
  if (resultDetails.status !== "failed") {
    throw new Error(`Expected failed subagent status, got: ${JSON.stringify(resultDetails)}`);
  }
  if (resultText.includes("I'll review the diff now.") || parentText.includes("I'll review the diff now.")) {
    throw new Error(`Parent used stale child status as completion: ${parentText}`);
  }
  console.log(`live terminal-stop ok: terminal no-text stop surfaced (${LIVE_TEST_MODEL})`);
} finally {
  if (keepTmp) {
    console.error(`kept temp dir: ${tmpRoot}`);
  } else {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
