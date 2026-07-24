#!/usr/bin/env node
import { execFileSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { acquireLiveWindowLock } from "./live-test-guard.mjs";

const SCRIPT_NAME = "test-live-herdr-pi";
const OPT_IN_ENV = "PI_SUBAGENT_ALLOW_LIVE_WINDOWS";
const LIVE_MODEL_ENV = "PI_SUBAGENT_LIVE_MODEL";
const HERDR_TIMEOUT_MS = 10_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const CHILD_CLEANUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const piBin = process.env.PI_E2E_PI_BIN ?? "pi";

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function trimForError(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}…` : trimmed;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runHerdrRaw(args, options = {}) {
  return execFileSync("herdr", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: HERDR_TIMEOUT_MS,
    ...options,
  });
}

function runHerdrQuiet(args) {
  try {
    execFileSync("herdr", args, {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: HERDR_TIMEOUT_MS,
    });
  } catch {}
}

function parseHerdrJson(operation, output) {
  try {
    return JSON.parse(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `herdr ${operation} returned malformed JSON: ${message}; output: ${trimForError(output) || "(empty)"}`,
    );
  }
}

function runHerdrJson(operation, args, options = {}) {
  const output = runHerdrRaw(args, options);
  const parsed = parseHerdrJson(operation, output);
  if (parsed && typeof parsed === "object" && "error" in parsed) {
    const error = parsed.error;
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "unknown";
    const message = error && typeof error === "object" && typeof error.message === "string" ? error.message : trimForError(output);
    throw new Error(`herdr ${operation} failed: ${code}: ${message}`);
  }
  return parsed;
}

function herdrResult(operation, args) {
  const envelope = runHerdrJson(operation, args);
  if (!envelope || typeof envelope !== "object" || !envelope.result || typeof envelope.result !== "object") {
    throw new Error(`herdr ${operation} returned malformed API envelope`);
  }
  return envelope.result;
}

function listTabs() {
  const result = herdrResult("tab list", ["tab", "list"]);
  return Array.isArray(result.tabs) ? result.tabs : [];
}

function listPanes() {
  const result = herdrResult("pane list", ["pane", "list"]);
  return Array.isArray(result.panes) ? result.panes : [];
}

function closePaneQuiet(paneId) {
  if (!paneId) return;
  runHerdrQuiet(["pane", "close", paneId]);
}

function closeTabQuiet(tabId) {
  if (!tabId) return;
  runHerdrQuiet(["tab", "close", tabId]);
}

function sweepTabsByLabels(labels) {
  if (!labels.length) return;
  for (const tab of listTabs()) {
    const label = typeof tab?.label === "string" ? tab.label : "";
    if (!labels.some((needle) => label.includes(needle))) continue;
    if (typeof tab.tab_id === "string") closeTabQuiet(tab.tab_id);
  }
}

function requireCompatibleHerdrServer() {
  let status;
  try {
    status = runHerdrJson("status server", ["status", "server", "--json"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("herdr is not on PATH");
    }
    throw error;
  }

  if (!status || typeof status !== "object") {
    throw new Error("herdr status server returned a non-object status");
  }
  if (status.running !== true) {
    throw new Error(`herdr server is not running: ${JSON.stringify(status)}`);
  }
  if (status.compatible !== true) {
    throw new Error(`herdr server protocol is not compatible: ${JSON.stringify(status)}`);
  }
  return status;
}

function copyUserConfig(configDir) {
  const envConfigDir = process.env.PI_CODING_AGENT_DIR;
  const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
    ? envConfigDir
    : join(homedir(), ".pi", "agent");

  for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
    const source = join(sourceConfigDir, name);
    if (existsSync(source)) copyFileSync(source, join(configDir, name));
  }
}

function parseJsonl(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function listJsonlFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
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

function getMessageText(events, role) {
  return events
    .filter((event) => event.type === "message" && event.message?.role === role)
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

function getSubagentToolResults(events) {
  return events
    .filter((event) => event.type === "message" && event.message?.role === "toolResult")
    .map((event) => event.message)
    .filter((message) => message.toolName === "subagent");
}

function getLaunchMetadata(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    if (entry?.type === "custom" && entry.customType === "pi-subagents_launch_metadata") {
      return entry.data;
    }
  }
  return undefined;
}

function hasAssistantToolCall(events, toolName) {
  return events.some((event) => {
    if (event.type !== "message" || event.message?.role !== "assistant") return false;
    return (event.message.content ?? []).some((part) => part.type === "toolCall" && part.name === toolName);
  });
}

function hasToolResult(events, toolName) {
  return events.some(
    (event) => event.type === "message" && event.message?.role === "toolResult" && event.message.toolName === toolName,
  );
}

function getSessionHeader(events) {
  return events.find((entry) => entry?.type === "session");
}

function findParentSession(sessionDir, doneText) {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getMessageText(events, "user").includes(doneText)) return { file, events };
  }
  return null;
}

function childPaneMatches(scenario, pane) {
  const title = [pane?.label, pane?.terminal_title_stripped, pane?.terminal_title]
    .filter((value) => typeof value === "string")
    .join(" ");
  return title.includes(`[${scenario.agentName}]`);
}

function findObservedChildPane(scenario, parentPaneId) {
  for (const pane of listPanes()) {
    if (pane?.pane_id === parentPaneId) continue;
    if (childPaneMatches(scenario, pane) && typeof pane.pane_id === "string") {
      return pane.pane_id;
    }
  }
  return "";
}

function isChildPaneOpen(scenario, childPaneId) {
  return listPanes().some(
    (pane) => pane?.pane_id === childPaneId || childPaneMatches(scenario, pane),
  );
}

function findChildSession(sessionDir, scenario) {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    const metadata = getLaunchMetadata(events);
    if (metadata?.name === scenario.childName && metadata?.agent === scenario.agentName) {
      return { file, events, metadata };
    }
  }
  return null;
}

function childHasDoneText(child, scenario) {
  return getAssistantTexts(child.events).some((text) => text.includes(scenario.childDoneText));
}

async function waitForManualInteractiveChildReady(ctx, scenario, childPaneId) {
  const child = findChildSession(ctx.sessionDir, scenario);
  if (!child || !childHasDoneText(child, scenario)) return false;
  if (!isChildPaneOpen(scenario, childPaneId)) {
    throw new Error(`Manual interactive child ${scenario.childName} closed before operator close`);
  }
  await sleep(2000);
  if (!isChildPaneOpen(scenario, childPaneId)) {
    throw new Error(`Manual interactive child ${scenario.childName} auto-closed instead of waiting for the operator`);
  }
  return true;
}

function getParentScreen(parentPaneId) {
  try {
    return runHerdrRaw([
      "pane",
      "read",
      parentPaneId,
      "--source",
      "recent",
      "--lines",
      "100",
      "--format",
      "text",
    ]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function waitForParentPiStartup(parentPaneId) {
  const deadline = Date.now() + 30_000;
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = getParentScreen(parentPaneId);
    if (
      lastScreen.includes("escape interrupt") ||
      lastScreen.includes("Model scope:") ||
      lastScreen.includes("Press ctrl+o to show full startup help")
    ) {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for parent Pi startup screen:\n${trimForError(lastScreen)}`);
}

async function waitForParentEditorText(parentPaneId, text) {
  const deadline = Date.now() + 30_000;
  let lastScreen = "";
  while (Date.now() < deadline) {
    lastScreen = getParentScreen(parentPaneId);
    if (lastScreen.includes(text)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for parent editor text ${text}:\n${trimForError(lastScreen)}`);
}

async function submitParentPromptUntilAssistant(ctx, scenario, parentPaneId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    runHerdrRaw(["pane", "send-keys", parentPaneId, "Enter"]);
    const settle = Date.now() + 8_000;
    while (Date.now() < settle) {
      await sleep(POLL_INTERVAL_MS);
      const parent = findParentSession(ctx.sessionDir, scenario.doneText);
      const hasAssistantTurn = parent?.events.some(
        (event) => event.type === "message" && event.message?.role === "assistant",
      );
      if (hasAssistantTurn) return;
    }
  }
  throw new Error(`Parent never produced an assistant turn after submitting the prompt for ${scenario.name}`);
}

async function waitForScenarioOutcome(ctx, scenario, parentPaneId) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS;
  let observedChildPaneId = "";
  let lastParent = null;
  let operatorClosedChild = false;

  while (Date.now() < deadline) {
    observedChildPaneId ||= findObservedChildPane(scenario, parentPaneId);
    if (scenario.operatorCloses && observedChildPaneId && !operatorClosedChild) {
      const ready = await waitForManualInteractiveChildReady(ctx, scenario, observedChildPaneId);
      if (ready) {
        closePaneQuiet(observedChildPaneId);
        operatorClosedChild = true;
      }
    }

    const parent = findParentSession(ctx.sessionDir, scenario.doneText);
    if (parent) {
      lastParent = parent;
      const assistantTexts = getAssistantTexts(parent.events);
      const toolResult = getSubagentToolResults(parent.events).at(-1);
      const status = toolResult?.details?.status;
      if (status === "failed" || status === "cancelled") {
        throw new Error(`Parent-visible subagent result was ${status}: ${JSON.stringify(toolResult?.details, null, 2)}`);
      }
      if (assistantTexts.includes(scenario.doneText) && status === "completed") {
        return { parent, toolResult, observedChildPaneId, operatorClosedChild };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const parentScreen = getParentScreen(parentPaneId);
  const parentSummary = lastParent
    ? JSON.stringify({ file: lastParent.file, assistants: getAssistantTexts(lastParent.events), toolResults: getSubagentToolResults(lastParent.events).map((result) => result.details) }, null, 2)
    : "no parent session found";
  throw new Error(
    `Timed out waiting for ${scenario.name} live Pi Herdr smoke. Parent summary: ${parentSummary}\nParent pane output:\n${trimForError(parentScreen)}`,
  );
}

async function waitForChildSurfaceCleanup(scenario, childPaneId) {
  const deadline = Date.now() + CHILD_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isChildPaneOpen(scenario, childPaneId)) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Herdr child surface ${scenario.childName} (${childPaneId}) was still present after child completion`);
}

async function waitForFile(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, "utf8");
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function writeChildAgent(ctx, scenario, liveModel) {
  const [model, thinking] = liveModel.split(":", 2);
  const thinkingLine = thinking ? `thinking: ${thinking}\n` : "";
  const envValue = `${scenario.name}-env`;
  const childCwd = join(ctx.workDir, scenario.childWorkspaceName);
  const probeCommand = `printf 'scenario=%s\\ncwd=%s\\nenv=%s\\n' ${shellQuote(scenario.name)} "$PWD" "$LIVE_HERDR_CHILD_ENV" > ${shellQuote(scenario.probePath)}; sleep 2`;
  const lifecycleInstruction = scenario.autoExit
    ? `Then reply with exactly \`${scenario.childDoneText}\` and nothing else.`
    : scenario.childMode === "background"
      ? `Then write a final assistant message containing exactly \`${scenario.childDoneText}\` and no other text. Immediately after that final message, call the subagent_done tool.`
      : `Then reply with exactly \`${scenario.childDoneText}\` and nothing else. Stay in this Herdr pane and wait for the operator to close it; do not exit on your own.`;

  writeFileSync(
    join(ctx.agentsDir, `${scenario.agentName}.md`),
    `---
name: ${scenario.agentName}
description: Live Herdr Pi smoke child for ${scenario.name} ${scenario.childMode} auto-exit ${scenario.autoExit}.
mode: ${scenario.childMode}
auto-exit: ${scenario.autoExit ? "true" : "false"}
async: false
parent-close-policy: terminate
spawning: false
tools: bash
model: ${model}
${thinkingLine}trust-project: true
cwd: ${childCwd}
env: |
  LIVE_HERDR_CHILD_ENV=${envValue}
---

You are the ${scenario.name} live Herdr child smoke probe.
First run this exact bash command:

\`${probeCommand}\`

${lifecycleInstruction}
`,
    "utf8",
  );
}

function buildParentPrompt(scenario) {
  return [
    `Call subagent with name "${scenario.childName}", agent "${scenario.agentName}", title "${scenario.title}", task "Follow your exact built-in instructions. Do not change the bash command.".`,
    `After the subagent tool returns, reply exactly "${scenario.doneText}".`,
  ].join(" ");
}

function buildParentCommand(ctx, scenario, liveModel) {
  const unset = [
    "PI_SUBAGENT_AGENT",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_DENY_TOOLS",
    "PI_ARTIFACT_PROJECT_ROOT",
    "PI_SUBAGENT_SURFACE",
    "PI_SUBAGENT_MUX",
  ].map((key) => `-u ${key}`).join(" ");
  const assignments = [
    "PI_PACKAGE_DIR=",
    "PI_SUBAGENT_EXTENSIONS=",
    "PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS=1",
    "PI_SUBAGENT_SHELL_READY_DELAY_MS=1000",
    `PI_SUBAGENT_PI_COMMAND=${shellQuote(piBin)}`,
    `PI_CODING_AGENT_DIR=${shellQuote(ctx.configDir)}`,
    `PI_ARTIFACT_PROJECT_ROOT=${shellQuote(ctx.artifactsDir)}`,
    `PI_SUBAGENT_TRACE_LOG=${shellQuote(join(ctx.tmpRoot, "subagent-trace.log"))}`,
    ...(scenario.forceMux ? ["PI_SUBAGENT_MUX=herdr"] : []),
  ].join(" ");
  const args = [
    shellQuote(piBin),
    "--model",
    shellQuote(liveModel),
    "--no-approve",
    "--no-extensions",
    "-e",
    shellQuote(extensionSource),
    "--session-dir",
    shellQuote(ctx.sessionDir),
    "--no-context-files",
  ].join(" ");

  return `cd ${shellQuote(ctx.workDir)} && env ${unset} ${assignments} ${args}`;
}

function validateParentOutcome(scenario, toolResult) {
  const details = toolResult.details ?? {};
  if (details.status !== "completed") throw new Error(`Expected completed child status, got ${details.status ?? "missing"}`);
  if (details.mode !== scenario.childMode) throw new Error(`Expected ${scenario.childMode} child mode, got ${details.mode ?? "missing"}`);
  if (details.deliveryState !== "awaited") throw new Error(`Expected awaited delivery, got ${details.deliveryState ?? "missing"}`);
  if (details.async !== false) throw new Error(`Expected blocking child async=false, got ${details.async ?? "missing"}`);
  if (details.autoExit !== scenario.autoExit) throw new Error(`Expected autoExit=${scenario.autoExit}, got ${details.autoExit ?? "missing"}`);
  if (details.parentClosePolicy !== "terminate") throw new Error(`Expected parentClosePolicy=terminate, got ${details.parentClosePolicy ?? "missing"}`);
  if (details.name !== scenario.childName) throw new Error(`Expected child name ${scenario.childName}, got ${details.name ?? "missing"}`);
  if (!details.sessionFile || !existsSync(details.sessionFile)) throw new Error("Parent-visible child result missing existing sessionFile");
  return details.sessionFile;
}

function validateChildSession(ctx, scenario, childSessionFile) {
  const events = parseJsonl(childSessionFile);
  const metadata = getLaunchMetadata(events);
  if (!metadata) throw new Error(`Child session ${childSessionFile} missing launch metadata`);

  const expectedChildCwd = join(ctx.workDir, scenario.childWorkspaceName);
  if (metadata.mode !== scenario.childMode) throw new Error(`Child metadata mode was ${metadata.mode ?? "missing"}`);
  if (metadata.autoExit !== scenario.autoExit) throw new Error(`Child metadata autoExit was ${metadata.autoExit ?? "missing"}`);
  if (metadata.async !== false) throw new Error(`Child metadata async was ${metadata.async ?? "missing"}`);
  if (metadata.parentClosePolicy !== "terminate") throw new Error(`Child metadata parentClosePolicy was ${metadata.parentClosePolicy ?? "missing"}`);
  if (metadata.agent !== scenario.agentName) throw new Error(`Child metadata agent was ${metadata.agent ?? "missing"}`);
  if (metadata.name !== scenario.childName) throw new Error(`Child metadata name was ${metadata.name ?? "missing"}`);
  if (metadata.cwd !== expectedChildCwd) throw new Error(`Child metadata cwd ${metadata.cwd ?? "missing"} did not match ${expectedChildCwd}`);
  if (metadata.env !== `LIVE_HERDR_CHILD_ENV=${scenario.name}-env`) throw new Error(`Child metadata env was ${metadata.env ?? "missing"}`);
  if (metadata.trustProject !== true) throw new Error(`Child metadata trustProject was ${metadata.trustProject ?? "missing"}`);
  if (!Array.isArray(metadata.denyTools) || !metadata.denyTools.includes("subagent")) {
    throw new Error(`Child metadata did not preserve non-spawning deny tools: ${JSON.stringify(metadata.denyTools)}`);
  }
  if (!getAssistantTexts(events).some((text) => text.includes(scenario.childDoneText))) {
    throw new Error(`Child session ${childSessionFile} did not include ${scenario.childDoneText}`);
  }
  if (scenario.childMode === "background" && scenario.autoExit === false) {
    if (!hasAssistantToolCall(events, "subagent_done")) {
      throw new Error(`Manual background child ${childSessionFile} did not call subagent_done`);
    }
    if (!hasToolResult(events, "subagent_done")) {
      throw new Error(`Manual background child ${childSessionFile} did not complete subagent_done`);
    }
  }

  const header = getSessionHeader(events);
  if (header?.cwd !== expectedChildCwd) throw new Error(`Child session cwd ${header?.cwd ?? "missing"} did not match ${expectedChildCwd}`);
  return { metadata, header };
}

async function validateChildProbe(scenario, expectedCwd) {
  const probe = await waitForFile(scenario.probePath);
  if (!probe.includes(`scenario=${scenario.name}`)) throw new Error(`Probe file missing scenario marker: ${probe}`);
  if (!probe.includes(`cwd=${expectedCwd}`)) throw new Error(`Probe file missing cwd ${expectedCwd}: ${probe}`);
  if (!probe.includes(`env=${scenario.name}-env`)) throw new Error(`Probe file missing env marker: ${probe}`);
}

async function runScenario(ctx, scenario, liveModel) {
  let parentPaneId = "";
  let parentTabId = "";
  let observedChildPaneId = "";

  mkdirSync(join(ctx.workDir, scenario.childWorkspaceName), { recursive: true });
  writeChildAgent(ctx, scenario, liveModel);

  try {
    const created = herdrResult("tab create", [
      "tab",
      "create",
      "--cwd",
      ctx.workDir,
      "--label",
      `${ctx.marker} parent ${scenario.name}`,
      "--no-focus",
    ]);
    const parentPane = created.root_pane ?? created.pane;
    const parentTab = created.tab;
    if (!parentPane || typeof parentPane.pane_id !== "string") {
      throw new Error(`herdr tab create did not return a parent root pane: ${JSON.stringify(created)}`);
    }
    if (!parentTab || typeof parentTab.tab_id !== "string") {
      throw new Error(`herdr tab create did not return a parent tab: ${JSON.stringify(created)}`);
    }
    parentPaneId = parentPane.pane_id;
    parentTabId = parentTab.tab_id;

    await sleep(500);
    const prompt = buildParentPrompt(scenario);
    const command = buildParentCommand(ctx, scenario, liveModel);
    runHerdrRaw(["pane", "run", parentPaneId, command]);
    await waitForParentPiStartup(parentPaneId);
    runHerdrRaw(["pane", "send-text", parentPaneId, prompt]);
    await waitForParentEditorText(parentPaneId, scenario.doneText);
    await submitParentPromptUntilAssistant(ctx, scenario, parentPaneId);

    const outcome = await waitForScenarioOutcome(ctx, scenario, parentPaneId);
    observedChildPaneId = outcome.observedChildPaneId;
    if (scenario.expectChildPane && !observedChildPaneId) {
      throw new Error(`Did not observe a Herdr child pane for ${scenario.childName} while ${scenario.name} ran`);
    }
    if (!scenario.expectChildPane && observedChildPaneId) {
      throw new Error(`Background scenario ${scenario.name} unexpectedly opened Herdr child pane ${observedChildPaneId}`);
    }
    if (scenario.operatorCloses && !outcome.operatorClosedChild) {
      throw new Error(`Manual interactive scenario ${scenario.name} did not reach operator-close validation`);
    }

    const childSessionFile = validateParentOutcome(scenario, outcome.toolResult);
    const { metadata } = validateChildSession(ctx, scenario, childSessionFile);
    await validateChildProbe(scenario, metadata.cwd);
    if (scenario.expectChildPane) {
      await waitForChildSurfaceCleanup(scenario, observedChildPaneId);
    }

    return {
      scenario: scenario.name,
      mode: scenario.childMode,
      autoExit: scenario.autoExit,
      forcedMux: scenario.forceMux,
      parentSessionFile: outcome.parent.file,
      childSessionFile,
      childPaneObserved: observedChildPaneId || null,
      childSurfaceCleaned: scenario.expectChildPane ? true : null,
      backgroundSurfaceAbsent: scenario.expectChildPane ? null : true,
      operatorClosedChild: outcome.operatorClosedChild,
      cwdVerified: true,
      envVerified: true,
      parentVisibleOutcome: outcome.toolResult.details.status,
    };
  } finally {
    sweepTabsByLabels([ctx.marker, scenario.agentName, scenario.childName]);
    closeTabQuiet(parentTabId);
    closePaneQuiet(parentPaneId);
    closePaneQuiet(observedChildPaneId);
  }
}

function createContext() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "pi-herdr-live-pi-"));
  const configDir = join(tmpRoot, "agent");
  const agentsDir = join(configDir, "agents");
  const sessionDir = join(tmpRoot, "sessions");
  const artifactsDir = join(tmpRoot, "artifacts");
  const workDir = join(tmpRoot, "work");
  const runToken = process.pid.toString(36);
  const marker = `pi-subagents-herdr-pi-smoke-${Date.now()}-${process.pid}`;

  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  copyUserConfig(configDir);

  const scenarios = [
    {
      name: "default",
      childMode: "interactive",
      autoExit: true,
      expectChildPane: true,
      operatorCloses: false,
      forceMux: false,
      agentName: "live-herdr-child-default",
      childName: `herdr-${runToken}-default`,
      title: "Live Herdr default child",
      childWorkspaceName: "child-workspace-default",
      doneText: "LIVE_HERDR_PI_DEFAULT_DONE",
      childDoneText: "LIVE_HERDR_PI_DEFAULT_CHILD_OK",
      probePath: join(tmpRoot, "default-probe.txt"),
    },
    {
      name: "forced",
      childMode: "interactive",
      autoExit: true,
      expectChildPane: true,
      operatorCloses: false,
      forceMux: true,
      agentName: "live-herdr-child-forced",
      childName: `herdr-${runToken}-forced`,
      title: "Live Herdr forced child",
      childWorkspaceName: "child-workspace-forced",
      doneText: "LIVE_HERDR_PI_FORCED_DONE",
      childDoneText: "LIVE_HERDR_PI_FORCED_CHILD_OK",
      probePath: join(tmpRoot, "forced-probe.txt"),
    },
    {
      name: "interactive-manual",
      childMode: "interactive",
      autoExit: false,
      expectChildPane: true,
      operatorCloses: true,
      forceMux: true,
      agentName: "live-herdr-child-manual",
      childName: `herdr-${runToken}-manual`,
      title: "Live Herdr manual child",
      childWorkspaceName: "child-workspace-manual",
      doneText: "LIVE_HERDR_PI_MANUAL_DONE",
      childDoneText: "LIVE_HERDR_PI_MANUAL_CHILD_OK",
      probePath: join(tmpRoot, "manual-probe.txt"),
    },
    {
      name: "background-auto",
      childMode: "background",
      autoExit: true,
      expectChildPane: false,
      operatorCloses: false,
      forceMux: true,
      agentName: "live-herdr-child-bg-auto",
      childName: `herdr-${runToken}-bg-auto`,
      title: "Live Herdr background auto child",
      childWorkspaceName: "child-workspace-bg-auto",
      doneText: "LIVE_HERDR_PI_BG_AUTO_DONE",
      childDoneText: "LIVE_HERDR_PI_BG_AUTO_CHILD_OK",
      probePath: join(tmpRoot, "bg-auto-probe.txt"),
    },
    {
      name: "background-manual",
      childMode: "background",
      autoExit: false,
      expectChildPane: false,
      operatorCloses: false,
      forceMux: true,
      agentName: "live-herdr-child-bg-manual",
      childName: `herdr-${runToken}-bg-manual`,
      title: "Live Herdr background manual child",
      childWorkspaceName: "child-workspace-bg-manual",
      doneText: "LIVE_HERDR_PI_BG_MANUAL_DONE",
      childDoneText: "LIVE_HERDR_PI_BG_MANUAL_CHILD_OK",
      probePath: join(tmpRoot, "bg-manual-probe.txt"),
    },
  ];

  return { tmpRoot, configDir, agentsDir, sessionDir, artifactsDir, workDir, marker, scenarios };
}

function reportSkipIfMissingOptIn() {
  const missing = [];
  if (process.env[OPT_IN_ENV] !== "1") missing.push(`${OPT_IN_ENV}=1`);
  if (!process.env[LIVE_MODEL_ENV]) missing.push(LIVE_MODEL_ENV);
  if (missing.length === 0) return false;
  console.log(
    `SKIP ${SCRIPT_NAME}: set ${missing.join(" and ")} to run the real live Pi Herdr smoke. No Herdr panes or tabs were created.`,
  );
  return true;
}

async function runOuter() {
  if (reportSkipIfMissingOptIn()) return;

  const liveModel = process.env[LIVE_MODEL_ENV];
  const releaseLock = acquireLiveWindowLock(SCRIPT_NAME);
  const ctx = createContext();
  let status;

  try {
    status = requireCompatibleHerdrServer();
    const results = [];
    for (const scenario of ctx.scenarios) {
      results.push(await runScenario(ctx, scenario, liveModel));
    }

    console.log(
      JSON.stringify(
        {
          status: "passed",
          script: SCRIPT_NAME,
          herdr: {
            version: status.version,
            protocol: status.protocol,
            compatible: status.compatible,
          },
          liveModel,
          scenarios: results,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      sweepTabsByLabels([ctx.marker, ...ctx.scenarios.flatMap((scenario) => [scenario.agentName, scenario.childName])]);
    } catch {}
    try {
      execFileSync("pkill", ["-f", ctx.tmpRoot], { stdio: "ignore" });
    } catch {}
    releaseLock();
    if (process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1") {
      console.error(`kept temp dir: ${ctx.tmpRoot}`);
    } else {
      rmSync(ctx.tmpRoot, { recursive: true, force: true });
    }
  }
}

await runOuter();
