#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { installLiveTestCleanup } from "./live-test-cleanup.mjs";
import { acquireLiveWindowLock, LIVE_TEST_MODEL, requireLiveWindowOptIn } from "./live-test-guard.mjs";

requireLiveWindowOptIn("test-e2e-live-blocking");
const releaseLiveWindowLock = acquireLiveWindowLock("test-e2e-live-blocking");
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagents-live-blocking-"));
const tmuxSocket = join(tmpRoot, "tmux.sock");
const tmuxConfig = join(tmpRoot, "tmux.conf");
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const tmuxSession = `pi-live-blocking-${process.pid}`;
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const deadline = Date.now() + 120_000;
const liveAgentModel = LIVE_TEST_MODEL.split(":")[0];
const prompt = [
  "The subagent tool is available in this session.",
  "Use exactly this sequence.",
  'Call subagent with name "Live Blocking Child", agent "live-e2e-blocking", task "Follow your exact built-in instructions.", blocking: true, and parentClosePolicy "terminate".',
  'After the tool returns, reply with exactly "LIVE_E2E_BLOCKING_OK" and nothing else.',
  'Do not call any other tools.',
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(configDir, "agents"), { recursive: true });
writeFileSync(tmuxConfig, "set -g extended-keys on\n", "utf8");
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}
writeFileSync(
  join(configDir, "agents", "live-e2e-blocking.md"),
  `---\nname: live-e2e-blocking\ndescription: Live Ghostty+tmux blocking smoke test agent.\nmodel: ${liveAgentModel}\nthinking: high\nauto-exit: true\nmode: interactive\nblocking: true\nspawning: false\ntools: bash\n---\n\nFirst run a bash command that sleeps for 2 seconds.\nThen reply with exactly \`LIVE_BLOCKING_CHILD_OK\`.`,
  "utf8",
);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execTmux(args, options = {}) {
  return execFileSync("tmux", ["-S", tmuxSocket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function hasTmuxSession() {
  try {
    execTmux(["has-session", "-t", tmuxSession]);
    return true;
  } catch {
    return false;
  }
}

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
    if (getUserText(events).includes("LIVE_E2E_BLOCKING_OK")) {
      return { file, events };
    }
  }
  return null;
}

function getPaneSnapshot() {
  try {
    return execTmux(["list-panes", "-a", "-F", "#{session_name} #{window_index}.#{pane_index} #{pane_current_command}"]);
  } catch {
    return "";
  }
}

function getCapture() {
  try {
    return execTmux(["capture-pane", "-pt", `${tmuxSession}:0.0`]);
  } catch {
    return "";
  }
}

async function waitForPaneCountAtMost(expectedMax, timeoutMs = 15_000) {
  const paneDeadline = Date.now() + timeoutMs;
  while (Date.now() < paneDeadline) {
    if (!hasTmuxSession()) return true;
    try {
      const paneCount = execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
        .split("\n")
        .filter(Boolean).length;
      if (paneCount <= expectedMax) return true;
    } catch {
      if (!hasTmuxSession()) return true;
    }
    await sleep(250);
  }
  return false;
}

const piCommand = [
  "PI_DENY_TOOLS=",
  "PI_SUBAGENT_AGENT=",
  "PI_SUBAGENT_NAME=",
  "PI_SUBAGENT_AUTO_EXIT=",
  `PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
  "pi",
  `--model ${LIVE_TEST_MODEL}`,
  "--no-extensions",
  "-e ./src/subagents/index.ts",
  "-e ./src/session-artifacts/index.ts",
  `--session-dir ${shellQuote(sessionDir)}`,
  shellQuote(prompt),
].join(" ");

const launchCommand = [
  `cd ${shellQuote(repoRoot)}`,
  `exec tmux -S ${shellQuote(tmuxSocket)} -f ${shellQuote(tmuxConfig)} new-session -A -s ${shellQuote(tmuxSession)} ${shellQuote(`cd ${repoRoot} && env -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AUTO_EXIT -u PI_DENY_TOOLS -u PI_ARTIFACT_PROJECT_ROOT PI_SUBAGENT_MUX=tmux ${piCommand}`)}`,
].join(" && ");

const ghostty = spawn("ghostty", ["-e", "bash", "-lc", launchCommand], {
  cwd: repoRoot,
  stdio: "ignore",
  env: (() => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS" || key === "PI_ARTIFACT_PROJECT_ROOT") {
        delete env[key];
      }
    }
    return env;
  })(),
});
ghostty.unref();

const cleanup = installLiveTestCleanup({
  hasTmuxSession,
  execTmux,
  tmuxSession,
  ghostty,
  releaseLiveWindowLock,
  keepTmp,
  tmpRoot,
  keepLabel: "kept live blocking temp dir",
});

let sawTwoPanes = false;
let verified = false;

try {
  while (Date.now() < deadline) {
    const sessionAlive = hasTmuxSession();
    if (sessionAlive) {
      try {
        const paneCount = execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
          .split("\n")
          .filter(Boolean).length;
        if (paneCount >= 2) sawTwoPanes = true;
      } catch {}
    }

    const parent = getParentEvents();
    if (!parent) {
      await sleep(500);
      continue;
    }

    const assistantTexts = getAssistantTexts(parent.events);
    const subagentResult = getToolResult(parent.events, "subagent");
    if (!subagentResult || !assistantTexts.includes("LIVE_E2E_BLOCKING_OK")) {
      await sleep(500);
      continue;
    }

    const details = subagentResult.details ?? {};
    if (details.status !== "completed") throw new Error(`Expected completed blocking result, got ${details.status ?? "missing"}.`);
    if (details.deliveryState !== "awaited") throw new Error(`Expected awaited blocking result, got ${details.deliveryState ?? "missing"}.`);
    if (details.blocking !== true) throw new Error(`Expected blocking true, got ${details.blocking ?? "missing"}.`);
    if (!details.sessionFile || !existsSync(details.sessionFile)) throw new Error("Blocking result missing sessionFile.");
    if (!sawTwoPanes) throw new Error("Did not observe a second tmux pane while the blocking child was running.");

    const assistantMessages = parent.events.filter((event) => event.type === "message" && event.message?.role === "assistant");
    if (assistantMessages.length > 2) {
      throw new Error("Parent did extra assistant work during the blocking turn.");
    }

    const childEvents = parseJsonl(details.sessionFile);
    if (!getAssistantTexts(childEvents).some((text) => text.includes("LIVE_BLOCKING_CHILD_OK"))) {
      throw new Error("Blocking child did not produce LIVE_BLOCKING_CHILD_OK.");
    }
    if (!(await waitForPaneCountAtMost(1))) {
      throw new Error("Blocking child pane did not auto-close before the session ended.");
    }

    verified = true;
    console.log(`live blocking ok: ${details.id}`);
    break;
  }

  if (!verified) {
    throw new Error(
      [
        "Timed out waiting for live blocking verification.",
        `Prompt: ${prompt}`,
        `Panes:\n${getPaneSnapshot()}`,
        `Capture:\n${getCapture()}`,
      ].join("\n\n"),
    );
  }
} finally {
  cleanup();
}
