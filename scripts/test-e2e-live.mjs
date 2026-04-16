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

requireLiveWindowOptIn("test-e2e-live");
const releaseLiveWindowLock = acquireLiveWindowLock("test-e2e-live");
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagents-live-e2e-"));
const tmuxSocket = join(tmpRoot, "tmux.sock");
const tmuxConfig = join(tmpRoot, "tmux.conf");
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const tmuxSession = `pi-live-e2e-${process.pid}`;
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const deadline = Date.now() + 120_000;
const liveAgentModel = LIVE_TEST_MODEL.split(":")[0];
const stageOnePrompt = [
  "Use exactly this sequence.",
  'Use subagent with agent: "live-e2e-wait", name: "Live Wait Child", task: "Run the live wait smoke test."',
  'After the tool returns, reply with exactly "LIVE_E2E_STAGE1_OK" and nothing else.',
  "Do not call any other tools.",
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(configDir, "agents"), { recursive: true });
writeFileSync(tmuxConfig, "set -g extended-keys on\n", "utf8");
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}
writeFileSync(
  join(configDir, "agents", "live-e2e-wait.md"),
  `---\nname: live-e2e-wait\ndescription: Live Ghostty+tmux wait smoke test agent.\nmodel: ${liveAgentModel}\nthinking: high\nauto-exit: true\nmode: interactive\nblocking: false\nspawning: false\ntools: bash\n---\n\nFirst run a bash command that sleeps for 2 seconds.\nThen use write_artifact with name \`live-e2e/child.md\` and content \`LIVE_CHILD_ARTIFACT\`.\nThen reply with exactly \`LIVE_CHILD_OK\`.`,
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
    if (getUserText(events).includes("LIVE_E2E_STAGE1_OK")) {
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

const piCommand = [
  `PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
  "pi",
  `--model ${LIVE_TEST_MODEL}`,
  "--no-extensions",
  "-e ./src/subagents/index.ts",
  "-e ./src/session-artifacts/index.ts",
  `--session-dir ${shellQuote(sessionDir)}`,
  shellQuote(stageOnePrompt),
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
  keepLabel: "kept live e2e temp dir",
});

let sawMultiplePanes = false;
let stageTwoSent = false;
let verified = false;

try {
  while (Date.now() < deadline) {
    const sessionAlive = hasTmuxSession();
    if (sessionAlive) {
      try {
        const paneCount = execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
          .split("\n")
          .filter(Boolean).length;
        if (paneCount >= 2) sawMultiplePanes = true;
      } catch {}
    }

    const parent = getParentEvents();
    if (!parent) {
      await sleep(500);
      continue;
    }

    const assistantTexts = getAssistantTexts(parent.events);
    const startResult = getToolResult(parent.events, "subagent");
    if (!startResult || !assistantTexts.includes("LIVE_E2E_STAGE1_OK")) {
      await sleep(500);
      continue;
    }

    const started = startResult.details ?? {};
    if (!stageTwoSent) {
      const stageTwoPrompt = [
        `Call subagent_wait with id \"${started.id}\" and timeout 60.`,
        'Then call read_artifact with name "live-e2e/child.md".',
        'After both tools return, reply with exactly "LIVE_E2E_PARENT_OK" and nothing else.',
        'Do not call any other tools.',
      ].join(" ");
      execTmux(["send-keys", "-t", `${tmuxSession}:0.0`, "-l", stageTwoPrompt]);
      execTmux(["send-keys", "-t", `${tmuxSession}:0.0`, "Enter"]);
      stageTwoSent = true;
      await sleep(500);
      continue;
    }

    const waitResult = getToolResult(parent.events, "subagent_wait");
    const readArtifactResult = getToolResult(parent.events, "read_artifact");
    if (!waitResult || !readArtifactResult || !assistantTexts.includes("LIVE_E2E_PARENT_OK")) {
      await sleep(500);
      continue;
    }

    const waited = waitResult.details ?? {};
    if (started.mode !== "interactive") throw new Error(`Expected interactive child mode, got ${started.mode ?? "missing"}.`);
    if (started.deliveryState !== "detached") throw new Error(`Expected detached launch deliveryState, got ${started.deliveryState ?? "missing"}.`);
    if (started.blocking !== false) throw new Error(`Expected non-blocking child launch, got ${started.blocking ?? "missing"}.`);
    if (waited.id !== started.id) throw new Error(`Waited for ${waited.id ?? "missing"} but started ${started.id ?? "missing"}.`);
    if (waited.status !== "completed") throw new Error(`Expected completed wait status, got ${waited.status ?? "missing"}.`);
    if (waited.deliveryState !== "awaited") throw new Error(`Expected awaited wait deliveryState, got ${waited.deliveryState ?? "missing"}.`);
    if (!waited.sessionFile || !existsSync(waited.sessionFile)) throw new Error("subagent_wait did not return an existing sessionFile.");

    const childEvents = parseJsonl(waited.sessionFile);
    if (!getAssistantTexts(childEvents).some((text) => text.includes("LIVE_CHILD_OK"))) {
      throw new Error("Child did not produce LIVE_CHILD_OK.");
    }
    const childWrite = getToolResult(childEvents, "write_artifact");
    if (!childWrite) {
      throw new Error("Child did not call write_artifact.");
    }
    if (readArtifactResult.content?.[0]?.text?.trim() !== "LIVE_CHILD_ARTIFACT") {
      throw new Error("Parent did not read the child artifact content.");
    }
    if (!sawMultiplePanes) {
      throw new Error("Did not observe a second tmux pane while the interactive child was running.");
    }

    verified = true;
    console.log(`live wait ok: ${started.id}`);
    break;
  }

  if (!verified) {
    throw new Error(
      [
        "Timed out waiting for live wait verification.",
        `Prompt: ${stageOnePrompt}`,
        `Panes:\n${getPaneSnapshot()}`,
        `Capture:\n${getCapture()}`,
      ].join("\n\n"),
    );
  }
} finally {
  cleanup();
}
