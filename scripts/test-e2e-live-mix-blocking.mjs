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

requireLiveWindowOptIn("test-e2e-live-mix-blocking");
const releaseLiveWindowLock = acquireLiveWindowLock("test-e2e-live-mix-blocking");
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagents-live-mix-"));
const tmuxSocket = join(tmpRoot, "tmux.sock");
const tmuxConfig = join(tmpRoot, "tmux.conf");
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const tmuxSession = `pi-live-mix-${process.pid}`;
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const deadline = Date.now() + 120_000;
const liveAgentModel = LIVE_TEST_MODEL.split(":")[0];
const prompt = [
  "The subagent tool is available in this session.",
  "Use exactly this sequence.",
  'First call subagent with agent: "live-e2e-mix-async-a", name: "Mix Async A", task: "Follow your exact built-in instructions.", and parentClosePolicy: "terminate".',
  'Second call subagent with agent: "live-e2e-mix-async-b", name: "Mix Async B", task: "Follow your exact built-in instructions.", and parentClosePolicy: "terminate".',
  'Third call subagent with agent: "live-e2e-mix-blocking", name: "Mix Blocking Child", task: "Follow your exact built-in instructions.", blocking: true, and parentClosePolicy: "terminate".',
  'Do not do any work that overlaps with Mix Blocking Child until it finishes.',
  'Do not inspect files, do not use any tool except subagent, and do not start any additional subagents.',
  'After the third call returns, reply with exactly "LIVE_E2E_MIX_OK" and nothing else.',
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(configDir, "agents"), { recursive: true });
writeFileSync(tmuxConfig, "set -g extended-keys on\n", "utf8");
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}
writeFileSync(
  join(configDir, "agents", "live-e2e-mix-async-a.md"),
  `---\nname: live-e2e-mix-async-a\ndescription: Live async mix smoke test agent A.\nmodel: ${liveAgentModel}\nthinking: high\nsystem-prompt: replace\nauto-exit: true\nmode: background\nspawning: false\ntools: bash\n---\n\nFirst run a bash command that sleeps for 30 seconds.\nThen reply with exactly \`LIVE_MIX_ASYNC_A_OK\`.`,
  "utf8",
);
writeFileSync(
  join(configDir, "agents", "live-e2e-mix-async-b.md"),
  `---\nname: live-e2e-mix-async-b\ndescription: Live async mix smoke test agent B.\nmodel: ${liveAgentModel}\nthinking: high\nsystem-prompt: replace\nauto-exit: true\nmode: background\nspawning: false\ntools: bash\n---\n\nFirst run a bash command that sleeps for 30 seconds.\nThen reply with exactly \`LIVE_MIX_ASYNC_B_OK\`.`,
  "utf8",
);
writeFileSync(
  join(configDir, "agents", "live-e2e-mix-blocking.md"),
  `---\nname: live-e2e-mix-blocking\ndescription: Live blocking mix smoke test agent.\nmodel: ${liveAgentModel}\nthinking: high\nsystem-prompt: replace\nauto-exit: true\nmode: interactive\nblocking: true\nspawning: false\ntools: bash\n---\n\nFirst run a bash command that sleeps for 2 seconds.\nThen reply with exactly \`LIVE_MIX_BLOCKING_OK\`.`,
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

function findAssistantTextEvent(events, text) {
  return events.find(
    (event) =>
      event.type === "message" &&
      event.message?.role === "assistant" &&
      (event.message.content ?? []).some((part) => part.type === "text" && part.text.trim() === text),
  );
}

function findLastAssistantTextEvent(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "message" || event.message?.role !== "assistant") continue;
    const textPart = (event.message.content ?? []).find(
      (part) => part.type === "text" && part.text.trim().length > 0,
    );
    if (textPart) return event;
  }
  return null;
}

function getSubagentResults(events) {
  return events
    .filter(
      (event) =>
        event.type === "message" &&
        event.message?.role === "toolResult" &&
        event.message.toolName === "subagent",
    )
    .map((event) => event.message);
}

function getParentEvents() {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes("LIVE_E2E_MIX_OK")) {
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

async function waitForPath(path, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (path && existsSync(path)) return true;
    await sleep(250);
  }
  return !!path && existsSync(path);
}

const piCommand = [
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
  keepLabel: "kept live mix temp dir",
});

let sawBlockingPane = false;
let verified = false;

try {
  while (Date.now() < deadline) {
    const sessionAlive = hasTmuxSession();
    if (sessionAlive) {
      try {
        const paneCount = execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
          .split("\n")
          .filter(Boolean).length;
        if (paneCount >= 2) sawBlockingPane = true;
      } catch {}
    }

    const parent = getParentEvents();
    if (!parent) {
      await sleep(500);
      continue;
    }

    const assistantTexts = getAssistantTexts(parent.events);
    const subagentResults = getSubagentResults(parent.events);
    const asyncA = subagentResults.find((message) => message.details?.name === "Mix Async A");
    const asyncB = subagentResults.find((message) => message.details?.name === "Mix Async B");
    const blocking = subagentResults.find((message) => message.details?.name === "Mix Blocking Child");
    if (!asyncA || !asyncB || !blocking || !assistantTexts.includes("LIVE_E2E_MIX_OK")) {
      await sleep(500);
      continue;
    }

    const asyncADetails = asyncA.details ?? {};
    const asyncBDetails = asyncB.details ?? {};
    const blockingDetails = blocking.details ?? {};
    if (asyncADetails.status !== "started" || asyncBDetails.status !== "started") {
      throw new Error("Expected async children to return immediate started results.");
    }
    if (asyncADetails.mode !== "background" || asyncBDetails.mode !== "background") {
      throw new Error("Expected async children to run in background mode.");
    }
    if (asyncADetails.deliveryState !== "detached" || asyncBDetails.deliveryState !== "detached") {
      throw new Error("Expected async children to stay detached.");
    }
    if (asyncADetails.blocking !== false || asyncBDetails.blocking !== false) {
      throw new Error("Expected async children to stay non-blocking.");
    }
    if (blockingDetails.status !== "completed" || blockingDetails.deliveryState !== "awaited" || blockingDetails.blocking !== true) {
      throw new Error("Expected blocking child to return awaited completed result.");
    }
    if (!blockingDetails.sessionFile || !(await waitForPath(blockingDetails.sessionFile))) {
      throw new Error("Blocking child missing sessionFile.");
    }
    if (!asyncADetails.sessionFile || !(await waitForPath(asyncADetails.sessionFile))) {
      throw new Error("Async child A missing sessionFile.");
    }
    if (!asyncBDetails.sessionFile || !(await waitForPath(asyncBDetails.sessionFile))) {
      throw new Error("Async child B missing sessionFile.");
    }
    if (!sawBlockingPane) {
      throw new Error("Did not observe the interactive blocking child pane.");
    }

    const blockingLaunchEvent = parent.events.find(
      (event) =>
        event.type === "message" &&
        event.message?.role === "assistant" &&
        (event.message.content ?? []).some((part) => part.type === "toolCall" && part.name === "subagent" && part.arguments?.name === "Mix Blocking Child"),
    );
    const blockingResultEvent = parent.events.find(
      (event) =>
        event.type === "message" &&
        event.message?.role === "toolResult" &&
        event.message.toolName === "subagent" &&
        event.message.details?.name === "Mix Blocking Child",
    );
    const parentFinalEvent = findAssistantTextEvent(parent.events, "LIVE_E2E_MIX_OK");
    if (!blockingLaunchEvent || !blockingResultEvent || !parentFinalEvent) {
      throw new Error("Missing blocking launch/result/final parent events.");
    }

    const assistantDuringBlocking = parent.events.filter(
      (event) =>
        event.type === "message" &&
        event.message?.role === "assistant" &&
        event.timestamp > blockingLaunchEvent.timestamp &&
        event.timestamp < blockingResultEvent.timestamp,
    );
    if (assistantDuringBlocking.length > 0) {
      throw new Error("Parent did extra assistant work during the blocking turn.");
    }
    if (parentFinalEvent.timestamp < blockingResultEvent.timestamp) {
      throw new Error("Parent replied before the blocking child completed.");
    }

    const blockingEvents = parseJsonl(blockingDetails.sessionFile);
    if (!getAssistantTexts(blockingEvents).some((text) => text.includes("LIVE_MIX_BLOCKING_OK"))) {
      throw new Error("Blocking child did not finish correctly.");
    }

    while (Date.now() < deadline) {
      const asyncAEvents = parseJsonl(asyncADetails.sessionFile);
      const asyncBEvents = parseJsonl(asyncBDetails.sessionFile);
      const doneA = !!findAssistantTextEvent(asyncAEvents, "LIVE_MIX_ASYNC_A_OK") || !!findLastAssistantTextEvent(asyncAEvents);
      const doneB = !!findAssistantTextEvent(asyncBEvents, "LIVE_MIX_ASYNC_B_OK") || !!findLastAssistantTextEvent(asyncBEvents);
      if (doneA && doneB) break;
      await sleep(500);
    }

    const finalAsyncAEvents = parseJsonl(asyncADetails.sessionFile);
    const finalAsyncBEvents = parseJsonl(asyncBDetails.sessionFile);
    const asyncAFinalEvent = findAssistantTextEvent(finalAsyncAEvents, "LIVE_MIX_ASYNC_A_OK") ?? findLastAssistantTextEvent(finalAsyncAEvents);
    const asyncBFinalEvent = findAssistantTextEvent(finalAsyncBEvents, "LIVE_MIX_ASYNC_B_OK") ?? findLastAssistantTextEvent(finalAsyncBEvents);
    if (!asyncAFinalEvent) {
      throw new Error("Async child A never finished.");
    }
    if (!asyncBFinalEvent) {
      throw new Error("Async child B never finished.");
    }

    const releaseTime = blockingResultEvent.timestamp;
    const asyncAFinishedAfterRelease = asyncAFinalEvent.timestamp >= releaseTime;
    const asyncBFinishedAfterRelease = asyncBFinalEvent.timestamp >= releaseTime;
    if (!asyncAFinishedAfterRelease && !asyncBFinishedAfterRelease) {
      throw new Error("Expected at least one async child to keep running until the blocking child released the parent.");
    }

    if (!(await waitForPaneCountAtMost(1))) {
      throw new Error("Async mix panes did not auto-close.");
    }

    verified = true;
    console.log(`live mix ok: ${blockingDetails.id}`);
    break;
  }

  if (!verified) {
    throw new Error(
      [
        "Timed out waiting for live mixed blocking verification.",
        `Prompt: ${prompt}`,
        `Panes:\n${getPaneSnapshot()}`,
        `Capture:\n${getCapture()}`,
      ].join("\n\n"),
    );
  }
} finally {
  cleanup();
}
