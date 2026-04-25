import { describe, it, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir, homedir } from "node:os";

import {
  getEntries,
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
} from "../src/subagents/session.ts";

import subagentsExtension from "../src/subagents/index.ts";

import {
  createSurface,
  createSurfaceSplit,
  closeSurface,
  exitStatusVar,
  getMuxBackend,
  isCmuxAvailable,
  isFishShell,
  isMuxAvailable,
  isTmuxAvailable,
  isWezTermAvailable,
  isZellijAvailable,
  muxSetupHint,
  pollForExit,
  readScreen,
  readScreenAsync,
  renameCurrentTab,
  sendShellCommand,
  renameWorkspace,
  sendCommand,
  shellEscape,
} from "../src/subagents/mux.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
} from "../src/subagents/auto-exit.ts";
import subagentDoneExtension, {
  filterToolNames,
  getDeniedToolNames,
  installDeniedToolGuards,
  shouldRegisterSubagentDone,
} from "../src/subagents/subagent-done.ts";
import {
  buildPiPromptArgsForTest,
  detachSubagentForTest,
  getAmbientCatalogEntriesForTest,
  getCompletedSubagentResultForTest,
  getEffectiveAgentDefinitionsForTest,
  getExtensionLaunchArgsForTest,
  getShellReadyDelayMs,
  getSubagentCatalogSignatureForTest,
  getSubagentToolAllowlistForTest,
  getSubagentToolLaunchArgsForTest,
  getSubagentToolDeniedNamesForTest,
  getSubagentToolsConfigErrorForTest,
  resolveDenyToolsForTest,
  renderSubagentCatalogReminderForTest,
  getLaunchedSubagentResultForTest,
  getStartedSubagentDetailsForTest,
  getSubagentAgentRequirementErrorForTest,
  getSubagentAgentOverrideErrorForTest,
  joinSubagentsForTest,
  loadAgentDefaults,
  resolveEffectiveSessionModeForTest,
  resolveSubagentExtensionsForTest,
  resolveSubagentNoContextFilesForTest,
  renderSubagentWidgetForTest,
  resetSubagentStateForTest,
  resolveSubagentBlockingForTest,
  resolveSubagentConfigDir,
  resolveSubagentRuntimePathsForTest,
  routeDetachedSubagentCompletionForTest,
  setRunningSubagentForTest,
  shutdownSubagentsForTest,
  waitForSubagentForTest,
  writeSystemPromptArtifactForTest,
  getTerminalAssistantSummaryForTest,
} from "../src/subagents/index.ts";
import {
  getArtifactProjectName,
  getProjectArtifactsDir,
  getSessionArtifactDir,
  resolveArtifactProjectRoot,
  resolveSessionArtifactPath,
} from "../src/shared/artifacts.ts";
import sessionArtifactsExtension from "../src/session-artifacts/index.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeExecutable(dir: string, name: string, content: string): string {
  const file = join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
}

function getAgentConfigDirForTest(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function resolveSubagentCwdForTest(rawCwd: string | null, baseCwd = process.cwd()): string {
  if (!rawCwd) return baseCwd;
  return rawCwd.startsWith("/") ? rawCwd : join(baseCwd, rawCwd);
}

function loadAgentDefaultsForTest(agentName: string, cwdHint?: string | null) {
  const baseCwd = resolveSubagentCwdForTest(cwdHint ?? null);
  const configDir = getAgentConfigDirForTest();
  const paths = [
    { path: join(baseCwd, ".pi", "agents", `${agentName}.md`), cwdBase: baseCwd },
    { path: join(configDir, "agents", `${agentName}.md`), cwdBase: configDir },
  ];
  for (const { path, cwdBase } of paths) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    const get = (key: string) => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };
    const systemPromptRaw = get("system-prompt");
    const noContextFilesRaw = get("no-context-files");
    const extensionsRaw = get("extensions");
    const modeRaw = get("mode");
    return {
      systemPromptMode:
        systemPromptRaw === "append" || systemPromptRaw === "replace"
          ? systemPromptRaw
          : undefined,
      cwd: get("cwd"),
      cwdBase,
      extensions: extensionsRaw,
      noContextFiles:
        noContextFilesRaw === "true"
          ? true
          : noContextFilesRaw === "false"
            ? false
            : undefined,
      mode: modeRaw === "background" || modeRaw === "interactive" ? modeRaw : undefined,
    };
  }
  return null;
}

function createForkSessionFileForTest(parentSessionFile: string, childSessionFile: string): void {
  const entries = getEntries(parentSessionFile) as any[];
  let truncateAt = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "user") {
      truncateAt = i;
      break;
    }
  }
  const cleanEntries = entries.slice(0, truncateAt);
  const contentEntries = cleanEntries.filter((entry) => entry?.type !== "session");
  const header = {
    type: "session",
    version: 3,
    id: `child-${Date.now()}`,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    parentSession: parentSessionFile,
  };
  writeFileSync(
    childSessionFile,
    [header, ...contentEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

const TRACKED_ENV_KEYS = [
  "CMUX_SOCKET_PATH",
  "CMUX_SURFACE_ID",
  "FAKE_CMUX_LOG",
  "FAKE_CMUX_SCREEN",
  "FAKE_TMUX_LOG",
  "FAKE_WEZTERM_LOG",
  "FAKE_WEZTERM_SCREEN",
  "FAKE_ZELLIJ_LOG",
  "FAKE_ZELLIJ_PANE_ID",
  "FAKE_ZELLIJ_SCREEN",
  "PATH",
  "PI_ARTIFACT_PROJECT_ROOT",
  "PI_CODING_AGENT_DIR",
  "PI_SUBAGENT_MUX",
  "PI_SUBAGENT_RENAME_TMUX_SESSION",
  "PI_SUBAGENT_RENAME_TMUX_WINDOW",
  "SHELL",
  "TMUX",
  "TMUX_PANE",
  "WEZTERM_PANE",
  "WEZTERM_UNIX_SOCKET",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
] as const;

const ORIGINAL_ENV = Object.fromEntries(
  TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined>;

function restoreTrackedEnv(): void {
  for (const key of TRACKED_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreTrackedEnv();
});

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, sketch something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my outline..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated outline with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getEntries", () => {
    it("throws with file path and line number for invalid json", () => {
      const file = join(dir, "invalid-session.jsonl");
      writeFileSync(file, '{"type":"session","id":"ok"}\nnot-json\n');

      assert.throws(
        () => getEntries(file),
        /Invalid session JSONL at .*invalid-session\.jsonl:2:/,
      );
    });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("reports the correct original line number for invalid new entries", () => {
      const file = join(dir, "invalid-new-entries.jsonl");
      writeFileSync(
        file,
        [JSON.stringify(SESSION_HEADER), JSON.stringify(MODEL_CHANGE), "not-json"].join("\n") + "\n",
      );

      assert.throws(
        () => getNewEntries(file, 2),
        /Invalid session JSONL at .*invalid-new-entries\.jsonl:3:/,
      );
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated outline with details.");
    });

    it("joins multiple text blocks with newlines", () => {
      const entries = [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "First line" },
              { type: "text", text: "Second line" },
            ],
          },
        },
      ] as any[];

      assert.equal(findLastAssistantMessage(entries), "First line\nSecond line");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated outline with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my outline...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The outline was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4);

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The outline was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });

    it("returns an empty array when there is nothing to merge", () => {
      const sourceFile = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const targetFile = join(dir, "merge-empty-target.jsonl");
      writeFileSync(targetFile, readFileSync(sourceFile, "utf8"));

      assert.deepEqual(mergeNewEntries(sourceFile, targetFile, 2), []);
      assert.equal(readFileSync(targetFile, "utf8"), readFileSync(sourceFile, "utf8"));
    });
  });
});

describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("stays open after user takeover for that cycle", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), false);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("defaults to auto-exit when there are no assistant messages", () => {
      const messages = [{ role: "user" }, { role: "toolResult" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("defaults to auto-exit when messages are missing", () => {
      assert.equal(shouldAutoExitOnAgentEnd(false, undefined), true);
    });
  });

  describe("shouldRegisterSubagentDone", () => {
    it("hides subagent_done for auto-exit agents", () => {
      assert.equal(shouldRegisterSubagentDone(true, []), false);
    });

    it("respects explicit deny lists", () => {
      assert.equal(shouldRegisterSubagentDone(false, ["subagent_done"]), false);
    });

    it("keeps subagent_done for manual-close agents", () => {
      assert.equal(shouldRegisterSubagentDone(false, []), true);
    });
  });

  describe("deny-tools enforcement", () => {
    it("adds subagent_done to denied tools for auto-exit agents", () => {
      assert.deepEqual(getDeniedToolNames(true, "ask_user_question"), ["ask_user_question", "subagent_done"]);
    });

    it("filters denied tool names and de-duplicates survivors", () => {
      assert.deepEqual(
        filterToolNames(["read", "ask_user_question", "read", "write_artifact"], ["ask_user_question"]),
        ["read", "write_artifact"],
      );
    });

    it("keeps subagent protocol tools available when built-in tools are narrowed", () => {
      assert.deepEqual(getSubagentToolAllowlistForTest("bash"), [
        "bash",
        "caller_ping",
        "subagent_done",
        "write_artifact",
        "read_artifact",
        "set_tab_title",
      ]);
    });

    it("removes denied subagent protocol tools from the launch allowlist", () => {
      assert.deepEqual(getSubagentToolAllowlistForTest("bash,read", ["write_artifact", "caller_ping"]), [
        "bash",
        "read",
        "subagent_done",
        "read_artifact",
        "set_tab_title",
      ]);
    });

    it("keeps non-requested built-ins out of narrowed child launch allowlists", () => {
      assert.deepEqual(getSubagentToolAllowlistForTest("bash").includes("edit"), false);
      assert.deepEqual(getSubagentToolAllowlistForTest("bash").includes("write"), false);
      assert.deepEqual(getSubagentToolAllowlistForTest(undefined), []);
    });

    it("maps omitted and all tools to default launch behavior", () => {
      assert.deepEqual(getSubagentToolLaunchArgsForTest(undefined), []);
      assert.deepEqual(getSubagentToolLaunchArgsForTest("all"), []);
      assert.deepEqual(getSubagentToolLaunchArgsForTest(" all "), []);
    });

    it("maps tools none to no built-in tools while preserving extension tools", () => {
      assert.deepEqual(getSubagentToolAllowlistForTest("none"), []);
      assert.deepEqual(getSubagentToolLaunchArgsForTest("none"), ["--no-builtin-tools"]);
      assert.deepEqual(getSubagentToolDeniedNamesForTest("none"), [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
      ]);
    });

    it("maps narrowed built-in tools to a tool allowlist with protocol tools", () => {
      assert.deepEqual(getSubagentToolLaunchArgsForTest("bash", ["write_artifact"]), [
        "--tools",
        "bash,caller_ping,subagent_done,read_artifact,set_tab_title",
      ]);
    });

    it("rejects unknown tools values instead of falling back to full access", () => {
      const error = getSubagentToolsConfigErrorForTest("bash,nope", "worker");
      assert.equal(error?.details.error, "invalid_tools");
      assert.deepEqual(error?.details.invalid, ["nope"]);
      assert.match(error?.content[0]?.text ?? "", /invalid tools value for agent "worker": nope/);
    });

    it("preserves CLI-disabled built-ins while applying denied tool filters", () => {
      const allTools = [{ name: "read" }, { name: "bash" }, { name: "caller_ping" }];
      let activeTools = ["caller_ping"];
      const pi = {
        getAllTools: () => allTools,
        getActiveTools: () => activeTools,
        setActiveTools: (toolNames: string[]) => {
          activeTools = [...toolNames];
        },
        registerTool(definition: { name: string }) {
          allTools.push({ name: definition.name });
          activeTools.push(definition.name);
        },
      } as any;

      const { applyDeniedTools } = installDeniedToolGuards(pi, false);
      assert.deepEqual(applyDeniedTools(), ["caller_ping"]);
      assert.deepEqual(activeTools, ["caller_ping"]);
    });

    it("keeps denied tools out of the active set after registration and later setActiveTools calls", () => {
      const allTools = [{ name: "read" }, { name: "bash" }, { name: "ask_user_question" }];
      let activeTools = allTools.map((tool) => tool.name);
      const changes: Array<{ active: string[]; denied: string[] }> = [];
      const pi = {
        getAllTools: () => allTools,
        getActiveTools: () => activeTools,
        setActiveTools: (toolNames: string[]) => {
          activeTools = [...toolNames];
        },
        registerTool: (definition: { name: string }) => {
          allTools.push({ name: definition.name });
        },
      } as any;

      const original = process.env.PI_DENY_TOOLS;
      process.env.PI_DENY_TOOLS = "ask_user_question,write_artifact";
      try {
        const { applyDeniedTools } = installDeniedToolGuards(pi, false, (active, denied) => {
          changes.push({ active: [...active], denied: [...denied] });
        });

        assert.deepEqual(applyDeniedTools(), ["read", "bash"]);
        assert.deepEqual(activeTools, ["read", "bash"]);

        pi.registerTool({ name: "write_artifact" });
        assert.deepEqual(activeTools, ["read", "bash"]);

        pi.setActiveTools(["read", "ask_user_question", "write_artifact", "bash"]);
        assert.deepEqual(activeTools, ["read", "bash"]);
        assert.equal(changes.at(-1)?.denied.join(","), "ask_user_question,write_artifact");
      } finally {
        if (original == null) delete process.env.PI_DENY_TOOLS;
        else process.env.PI_DENY_TOOLS = original;
      }
    });
  });

  describe("caller_ping extension tools", () => {
    it("registers caller_ping and writes a ping exit sidecar", async () => {
      const tools = new Map<string, any>();
      const handlers = new Map<string, any>();
      subagentDoneExtension({
        getAllTools: () => [],
        getActiveTools: () => [],
        setActiveTools() {},
        registerTool(definition: { name: string }) {
          tools.set(definition.name, definition);
          return definition;
        },
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerShortcut() {},
      } as any);

      const pingTool = tools.get("caller_ping");
      assert.ok(pingTool);

      const dir = createTestDir();
      const sessionFile = join(dir, "child.jsonl");
      writeFileSync(sessionFile, "");

      const originalSession = process.env.PI_SUBAGENT_SESSION;
      const originalName = process.env.PI_SUBAGENT_NAME;
      try {
        process.env.PI_SUBAGENT_SESSION = sessionFile;
        process.env.PI_SUBAGENT_NAME = "Ping Child";
        handlers.get("message_end")?.({ message: { role: "assistant", usage: { output: 11 } } });
        let shutdowns = 0;
        await pingTool.execute(
          "tool-1",
          { message: "Need help" },
          undefined,
          undefined,
          { shutdown() { shutdowns += 1; } },
        );
        await sleep(0);

        assert.equal(shutdowns, 1);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
          type: "ping",
          name: "Ping Child",
          message: "Need help",
          outputTokens: 11,
        });
      } finally {
        if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
        else process.env.PI_SUBAGENT_SESSION = originalSession;
        if (originalName == null) delete process.env.PI_SUBAGENT_NAME;
        else process.env.PI_SUBAGENT_NAME = originalName;
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("writes a done exit sidecar when subagent_done runs", async () => {
      const tools = new Map<string, any>();
      const handlers = new Map<string, any>();
      subagentDoneExtension({
        getAllTools: () => [],
        getActiveTools: () => [],
        setActiveTools() {},
        registerTool(definition: { name: string }) {
          tools.set(definition.name, definition);
          return definition;
        },
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerShortcut() {},
      } as any);

      const doneTool = tools.get("subagent_done");
      assert.ok(doneTool);

      const dir = createTestDir();
      const sessionFile = join(dir, "child.jsonl");
      writeFileSync(sessionFile, "");

      const originalSession = process.env.PI_SUBAGENT_SESSION;
      try {
        process.env.PI_SUBAGENT_SESSION = sessionFile;
        handlers.get("message_end")?.({ message: { role: "assistant", usage: { output: 17 } } });
        let shutdowns = 0;
        await doneTool.execute(
          "tool-2",
          {},
          undefined,
          undefined,
          { shutdown() { shutdowns += 1; } },
        );
        await sleep(0);

        assert.equal(shutdowns, 1);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { type: "done", outputTokens: 17 });
      } finally {
        if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
        else process.env.PI_SUBAGENT_SESSION = originalSession;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("shared/artifacts.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  beforeEach(() => {
    delete process.env.PI_ARTIFACT_PROJECT_ROOT;
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers PI_ARTIFACT_PROJECT_ROOT when set", () => {
    const explicitRoot = join(dir, "explicit-root");
    mkdirSync(explicitRoot, { recursive: true });
    process.env.PI_ARTIFACT_PROJECT_ROOT = explicitRoot;

    assert.equal(resolveArtifactProjectRoot(join(dir, "nested")), explicitRoot);
  });

  it("finds the nearest package root when no git root exists", () => {
    const pkgRoot = join(dir, "pkg-root");
    const nested = join(pkgRoot, "src", "feature");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), "{}");

    assert.equal(resolveArtifactProjectRoot(nested), pkgRoot);
  });

  it("prefers a git root over package.json roots", () => {
    const gitRoot = join(dir, "git-root");
    const pkgRoot = join(gitRoot, "packages", "feature");
    const nested = join(pkgRoot, "src");
    mkdirSync(join(gitRoot, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), "{}");

    assert.equal(resolveArtifactProjectRoot(nested), gitRoot);
  });

  it("falls back to the cwd when no markers exist", () => {
    const base = existsSync("/dev/shm")
      ? mkdtempSync(join("/dev/shm", "subagents-test-"))
      : join(dir, "plain-root");
    const plain = join(base, "plain", "folder");
    try {
      mkdirSync(plain, { recursive: true });

      assert.equal(resolveArtifactProjectRoot(plain), plain);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("builds project and session artifact paths from the resolved root", () => {
    const projectRoot = join(dir, "artifact-project");
    const nested = join(projectRoot, "src");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    assert.equal(getArtifactProjectName(nested), "artifact-project");
    assert.equal(
      getProjectArtifactsDir(nested),
      join(homedir(), ".pi", "history", "artifact-project", "artifacts"),
    );
    assert.equal(
      getSessionArtifactDir(nested, "session-123"),
      join(homedir(), ".pi", "history", "artifact-project", "artifacts", "session-123"),
    );
    assert.equal(
      resolveSessionArtifactPath(nested, "session-123", "context/notes.md"),
      join(homedir(), ".pi", "history", "artifact-project", "artifacts", "session-123", "context/notes.md"),
    );
  });
});

describe("session-artifacts/index.ts", () => {
  it("hides write_artifact in root sessions and keeps it for spawned subagents", async () => {
    const projectRoot = createTestDir();
    const cwd = join(projectRoot, "src");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const registerTools = () => {
      const tools = new Map<string, any>();
      sessionArtifactsExtension({
        registerTool(definition: { name: string }) {
          tools.set(definition.name, definition);
        },
      } as any);
      return tools;
    };

    const originalName = process.env.PI_SUBAGENT_NAME;
    const originalAgent = process.env.PI_SUBAGENT_AGENT;
    const originalDenied = process.env.PI_DENY_TOOLS;
    const projectArtifactsDir = getProjectArtifactsDir(cwd);
    const sessionId = `session-${Date.now()}`;
    const nextSessionId = `${sessionId}-next`;

    try {
      delete process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_AGENT;
      delete process.env.PI_DENY_TOOLS;

      const rootTools = registerTools();
      assert.equal(rootTools.has("write_artifact"), false);
      const rootReadArtifact = rootTools.get("read_artifact");
      assert.ok(rootReadArtifact);

      process.env.PI_SUBAGENT_NAME = "Artifact Child";
      process.env.PI_SUBAGENT_AGENT = "artifact-child";

      const childTools = registerTools();
      const writeArtifact = childTools.get("write_artifact");
      const readArtifact = childTools.get("read_artifact");
      assert.ok(writeArtifact);
      assert.ok(readArtifact);

      const writeResult = await writeArtifact.execute(
        "tool-1",
        { name: "context/note.md", content: "artifact body" },
        undefined,
        undefined,
        {
          cwd,
          sessionManager: { getSessionId: () => sessionId },
        },
      );
      assert.equal(writeResult.details.sessionId, sessionId);
      assert.equal(
        readFileSync(join(getSessionArtifactDir(cwd, sessionId), "context", "note.md"), "utf8"),
        "artifact body",
      );

      delete process.env.PI_SUBAGENT_NAME;
      delete process.env.PI_SUBAGENT_AGENT;

      const sameSessionRead = await rootReadArtifact.execute(
        "tool-2",
        { name: "context/note.md" },
        undefined,
        undefined,
        {
          cwd,
          sessionManager: { getSessionId: () => sessionId },
        },
      );
      assert.equal(sameSessionRead.details.sessionId, sessionId);
      assert.equal(sameSessionRead.details.content, "artifact body");

      const crossSessionRead = await rootReadArtifact.execute(
        "tool-3",
        { name: "context/note.md" },
        undefined,
        undefined,
        {
          cwd,
          sessionManager: { getSessionId: () => nextSessionId },
        },
      );
      assert.equal(crossSessionRead.details.content, "artifact body");
      assert.equal(crossSessionRead.details.sessionId, nextSessionId);

      const missing = await rootReadArtifact.execute(
        "tool-4",
        { name: "missing.md" },
        undefined,
        undefined,
        {
          cwd,
          sessionManager: { getSessionId: () => nextSessionId },
        },
      );
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /Available artifacts:/);
      assert.match(missing.content[0].text, /context\/note\.md/);
    } finally {
      if (originalName == null) delete process.env.PI_SUBAGENT_NAME;
      else process.env.PI_SUBAGENT_NAME = originalName;
      if (originalAgent == null) delete process.env.PI_SUBAGENT_AGENT;
      else process.env.PI_SUBAGENT_AGENT = originalAgent;
      if (originalDenied == null) delete process.env.PI_DENY_TOOLS;
      else process.env.PI_DENY_TOOLS = originalDenied;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(projectArtifactsDir, { recursive: true, force: true });
    }
  });
});

describe("subagents/index.ts helpers", () => {
  afterEach(() => {
    resetSubagentStateForTest();
  });

  it("uses PI_CODING_AGENT_DIR for the global agent config root", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent-root";
    assert.equal(getAgentConfigDirForTest(), "/tmp/custom-agent-root");
  });

  it("loads global agent defaults from PI_CODING_AGENT_DIR and records cwd base", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\nsystem-prompt: append\ncwd: ./roles/tester\nmode: background\nasync: false\n---\n\nYou are the tester.`,
    );
    process.env.PI_CODING_AGENT_DIR = configDir;

    const defs = loadAgentDefaults("tester");
    assert.equal(defs?.systemPromptMode, "append");
    assert.equal(defs?.cwd, "./roles/tester");
    assert.equal(defs?.cwdBase, configDir);
    assert.equal(defs?.mode, "background");
    assert.equal(defs?.async, false);
    assert.equal(resolveSubagentBlockingForTest({}, defs), true);
  });

  it("defaults context-file injection to on and can disable it in agent frontmatter", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;

    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\nno-context-files: true\n---\n\nYou are the tester.`,
    );

    const defs = loadAgentDefaults("tester");
    assert.equal(defs?.noContextFiles, true);
    assert.equal(resolveSubagentNoContextFilesForTest(defs), true);
    assert.equal(resolveSubagentNoContextFilesForTest(null), false);

    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\n---\n\nYou are the tester.`,
    );

    const defaults = loadAgentDefaults("tester");
    assert.equal(defaults?.noContextFiles, undefined);
    assert.equal(resolveSubagentNoContextFilesForTest(defaults), false);
  });

  it("reads extensions from extensions frontmatter", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\nextensions: ./extensions/caveman.ts, npm:@foo/bar, https://example.com/ext.ts\n---\n\nYou are the tester.`,
    );
    process.env.PI_CODING_AGENT_DIR = configDir;

    const defs = loadAgentDefaults("tester");
    assert.equal(defs?.extensions, "./extensions/caveman.ts, npm:@foo/bar, https://example.com/ext.ts");
    assert.deepEqual(resolveSubagentExtensionsForTest(defs), [
      join(configDir, "extensions", "caveman.ts"),
      "npm:@foo/bar",
      "https://example.com/ext.ts",
    ]);
    assert.deepEqual(
      getExtensionLaunchArgsForTest(resolveSubagentExtensionsForTest(defs), "/tmp/subagent-done.ts"),
      [
        "--no-extensions",
        "-e",
        "/tmp/subagent-done.ts",
        "-e",
        join(configDir, "extensions", "caveman.ts"),
        "-e",
        "npm:@foo/bar",
        "-e",
        "https://example.com/ext.ts",
      ],
    );
  });

  it("reads skills from skills frontmatter only", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\nskill: debugger\nskills: pua\n---\n\nYou are the tester.`,
    );
    process.env.PI_CODING_AGENT_DIR = configDir;

    const defs = loadAgentDefaults("tester");
    assert.equal(defs?.skills, "pua");
  });

  it("parses session-mode frontmatter and lets fork override it per launch", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;

    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\nsession-mode: lineage-only\n---\n\nYou are the tester.`,
    );

    const defs = loadAgentDefaults("tester");
    assert.equal(defs?.sessionMode, "lineage-only");
    assert.equal(resolveEffectiveSessionModeForTest({ agent: "tester" }, defs), "lineage-only");
    assert.equal(resolveEffectiveSessionModeForTest({ agent: "tester", fork: true }, defs), "fork");

    writeFileSync(
      join(agentsDir, "compat.md"),
      `---\nname: compat\nfork: true\n---\n\nCompatibility body.`,
    );
    const compat = loadAgentDefaults("compat");
    assert.equal(compat?.sessionMode, "fork");
  });

  it("skips disabled agents and falls back to the next available definition", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    const projectAgentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(projectAgentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "tester.md"),
      `---\nname: tester\ndescription: Global tester\nmode: background\n---\n\nYou are the global tester.`,
    );
    writeFileSync(
      join(projectAgentsDir, "tester.md"),
      `---\nname: tester\nenabled: false\ndescription: Disabled local tester\nmode: interactive\n---\n\nYou are the disabled local tester.`,
    );
    process.env.PI_CODING_AGENT_DIR = configDir;

    const defs = loadAgentDefaults("tester", null, dir);
    assert.equal(defs?.mode, "background");
    assert.equal(defs?.cwdBase, configDir);
  });

  it("resolves the effective agent set deterministically after overrides", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    const projectAgentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(projectAgentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;

    writeFileSync(
      join(agentsDir, "zeta.md"),
      `---\nname: zeta\ndescription: Global zeta\nmode: background\n---\n\nYou are zeta.`,
    );
    writeFileSync(
      join(agentsDir, "alpha.md"),
      `---\nname: alpha\ndescription: Global alpha\nmode: background\n---\n\nYou are alpha.`,
    );
    writeFileSync(
      join(projectAgentsDir, "middle.md"),
      `---\nname: middle\ndescription: Project middle\nmode: interactive\n---\n\nYou are middle.`,
    );
    writeFileSync(
      join(projectAgentsDir, "zeta.md"),
      `---\nname: zeta\ndescription: Project zeta\nmode: interactive\n---\n\nYou are project zeta.`,
    );

    const defs = getEffectiveAgentDefinitionsForTest(dir);
    assert.deepEqual(defs.map((entry) => entry.name), ["alpha", "middle", "zeta"]);
    assert.deepEqual(
      defs.map((entry) => entry.source),
      ["global", "project", "project"],
    );
    assert.equal(defs.at(-1)?.description, "Project zeta");
    assert.equal(defs.at(-1)?.mode, "interactive");
  });

  it("uses descriptions for ambient catalog eligibility", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    const projectAgentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(projectAgentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;

    writeFileSync(
      join(agentsDir, "global-agent.md"),
      `---\nname: global-agent\ndescription: Use the global route\nmode: background\n---\n\nGlobal body.`,
    );
    writeFileSync(
      join(agentsDir, "description-only.md"),
      `---\nname: description-only\ndescription: Fallback description\nmode: interactive\n---\n\nDescription body.`,
    );
    writeFileSync(
      join(agentsDir, "disabled.md"),
      `---\nname: disabled\nenabled: false\ndescription: Should never appear\n---\n\nDisabled body.`,
    );
    writeFileSync(
      join(projectAgentsDir, "project-agent.md"),
      `---\nname: project-agent\ndescription: Project description\nmode: interactive\n---\n\nProject body.`,
    );
    writeFileSync(
      join(projectAgentsDir, "hidden-agent.md"),
      `---\nname: hidden-agent\nmode: background\n---\n\nHidden body.`,
    );
    writeFileSync(
      join(projectAgentsDir, "lenient-enabled.md"),
      `---\nname: lenient-enabled\nenabled: maybe\ndescription: Lenient enabled fallback\n---\n\nLenient body.`,
    );

    const defs = getEffectiveAgentDefinitionsForTest(dir);
    assert.equal(defs.find((entry) => entry.name === "project-agent")?.description, "Project description");
    assert.equal(defs.find((entry) => entry.name === "global-agent")?.description, "Use the global route");
    assert.equal(defs.some((entry) => entry.name === "disabled"), false);
    assert.equal(defs.some((entry) => entry.name === "lenient-enabled"), true);

    const ambient = getAmbientCatalogEntriesForTest(dir);
    assert.deepEqual(
      ambient.map((entry) => entry.name),
      ["description-only", "global-agent", "lenient-enabled", "project-agent"],
    );
    assert.equal(ambient.find((entry) => entry.name === "project-agent")?.description, "Project description");
    assert.equal(ambient.find((entry) => entry.name === "description-only")?.description, "Fallback description");
    assert.equal(ambient.some((entry) => entry.name === "hidden-agent"), false);
  });

  it("defaults spawning to false for named agent definitions", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;

    writeFileSync(
      join(agentsDir, "worker.md"),
      `---\nname: worker\ndescription: Do focused work\n---\n\nWorker body.`,
    );
    writeFileSync(
      join(agentsDir, "coordinator.md"),
      `---\nname: coordinator\ndescription: Coordinate work\nspawning: true\n---\n\nCoordinator body.`,
    );

    const defs = getEffectiveAgentDefinitionsForTest(dir);
    const worker = defs.find((entry) => entry.name === "worker");
    const coordinator = defs.find((entry) => entry.name === "coordinator");
    assert.equal(worker?.spawning, false);
    assert.equal(coordinator?.spawning, true);
    assert.deepEqual(
      [...resolveDenyToolsForTest(worker ?? null)].sort(),
      ["subagent", "subagent_resume", "subagents_list"],
    );
    assert.deepEqual([...resolveDenyToolsForTest(coordinator ?? null)], []);
  });

  it("keeps catalog signatures stable until the effective ambient catalog changes", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;

    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
    );

    const first = getAmbientCatalogEntriesForTest(dir);
    const second = getAmbientCatalogEntriesForTest(dir);
    assert.equal(
      getSubagentCatalogSignatureForTest(first),
      getSubagentCatalogSignatureForTest(second),
    );

    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review critical changes for regressions\nmode: background\n---\n\nReviewer body.`,
    );

    const changed = getAmbientCatalogEntriesForTest(dir);
    assert.notEqual(
      getSubagentCatalogSignatureForTest(first),
      getSubagentCatalogSignatureForTest(changed),
    );
  });

  it("lists descriptions and sparse launchable agents in subagents_list when ambient awareness is disabled", async () => {
    const dir = createTestDir();
    const prevCwd = process.cwd();
    const prevKillSwitch = process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS;
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    const projectAgentsDir = join(dir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(projectAgentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS = "1";

    writeFileSync(
      join(agentsDir, "global-reviewer.md"),
      `---\nname: global-reviewer\ndescription: Review changes\nmode: background\n---\n\nReviewer body.`,
    );
    writeFileSync(
      join(projectAgentsDir, "sparse-agent.md"),
      `---\nname: sparse-agent\nmode: interactive\n---\n\nSparse body.`,
    );
    writeFileSync(
      join(projectAgentsDir, "disabled-agent.md"),
      `---\nname: disabled-agent\nenabled: false\ndescription: hidden\n---\n\nDisabled body.`,
    );

    const tools = new Map<string, any>();
    try {
      process.chdir(dir);
      subagentsExtension({
        on() {},
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool(definition: any) {
          tools.set(definition.name, definition);
          return definition;
        },
      } as any);

      const listTool = tools.get("subagents_list");
      assert.ok(listTool);
      const result = await listTool.execute();
      const listed = result.details.agents;
      assert.deepEqual(
        listed.map((entry: any) => entry.name),
        getEffectiveAgentDefinitionsForTest(dir).map((entry) => entry.name),
      );
      assert.equal(listed.some((entry: any) => entry.name === "disabled-agent"), false);
      assert.equal(listed.some((entry: any) => entry.name === "sparse-agent"), true);
      assert.equal(listed.find((entry: any) => entry.name === "global-reviewer")?.description, "Review changes");
      assert.match(result.content[0].text, /global-reviewer — Review changes/);
      assert.doesNotMatch(result.content[0].text, /\(background\)|\[.*claude.*\]|\[.*glm.*\]|\| use:/i);
      assert.match(result.content[0].text, /sparse-agent/);
    } finally {
      process.chdir(prevCwd);
      if (prevKillSwitch == null) delete process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS;
      else process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS = prevKillSwitch;
    }
  });

  it("registers conservative delegation guidance on the subagent tool", () => {
    const tools = new Map<string, any>();

    subagentsExtension({
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      registerTool(definition: any) {
        tools.set(definition.name, definition);
        return definition;
      },
    } as any);

    const tool = tools.get("subagent");
    assert.ok(tool);
    assert.match(tool.description, /specialist or parallelizable work/);
    assert.match(tool.promptSnippet, /Use subagents for specialist, complex, or parallelizable work/);
    assert.match(tool.promptSnippet, /Terminology: async means the parent agent does not wait/);
    assert.match(tool.promptSnippet, /CRITICAL parallel-launch rule/);
    assert.match(tool.promptSnippet, /same assistant message\/tool-call batch/);
    assert.match(tool.promptSnippet, /Keep launches explicit and use one subagent tool call per child/);
    assert.match(tool.promptSnippet, /call-time duplicates for named agents are ignored/);
    assert.match(tool.promptSnippet, /Handle trivial single-file reads, quick direct answers, and tiny one-shot edits yourself instead of delegating/);
    assert.match(tool.promptSnippet, /Delegation ownership rule/);
    assert.match(tool.promptSnippet, /explicitly non-overlapping parent-owned work/);
    assert.match(tool.promptSnippet, /end the response and let async results arrive by steer/);
    assert.match(tool.promptSnippet, /subagent_wait\/subagent_join only for explicit sync gates or short non-blocking status probes/);
    assert.match(tool.promptSnippet, /Pi built-in implementation tools such as bash\/read\/edit\/write/);
    assert.match(tool.promptSnippet, /PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1/);
  });

  it("blocks immediate parent implementation tools after a detached launch", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "scout.md"),
      `---\nname: scout\nmode: background\nblocking: false\n---\n\nScout body.`,
    );

    const handlers = new Map<string, any>();
    try {
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool() {},
      } as any);

      handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_subagent",
        toolName: "subagent",
        input: { name: "Child", agent: "scout", task: "Do work" },
      });
      const blocked = handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_read",
        toolName: "read",
        input: { path: "README.md" },
      });
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /async subagent was launched in this response/);
      assert.match(blocked.reason, /Pi built-in implementation tools such as bash, read, edit, or write/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows parent implementation tools after detached launch when scoped guard is disabled", () => {
    const prev = process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
    writeFileSync(
      join(agentsDir, "scout.md"),
      `---\nname: scout\nmode: background\nblocking: false\n---\n\nScout body.`,
    );

    const handlers = new Map<string, any>();
    try {
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool() {},
      } as any);

      handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_subagent",
        toolName: "subagent",
        input: { name: "Child", agent: "scout", task: "Do work" },
      });
      const allowed = handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_read",
        toolName: "read",
        input: { path: "README.md" },
      });
      assert.deepEqual(allowed, {});
    } finally {
      if (prev == null) delete process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
      else process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows safe coordination tools while the detached-launch guard is active", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "scout.md"),
      `---\nname: scout\nmode: background\nblocking: false\n---\n\nScout body.`,
    );

    const handlers = new Map<string, any>();
    try {
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool() {},
      } as any);

      handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_subagent",
        toolName: "subagent",
        input: { name: "Child", agent: "scout", task: "Do work" },
      });
      for (const toolName of ["subagent", "subagent_detach", "subagent_kill", "subagent_resume", "subagents_list", "ask_user_question"]) {
        const allowed = handlers.get("tool_call")({
          type: "tool_call",
          toolCallId: `call_${toolName}`,
          toolName,
          input: {},
        });
        assert.deepEqual(allowed, {});
      }
      for (const [toolName, input] of [
        ["subagent_wait", { id: "Child", timeout: 1, onTimeout: "return_pending" }],
        ["subagent_join", { ids: ["Child"], timeout: 1, onTimeout: "return_partial" }],
      ] as const) {
        const allowed = handlers.get("tool_call")({
          type: "tool_call",
          toolCallId: `call_${toolName}`,
          toolName,
          input,
        });
        assert.deepEqual(allowed, {});
      }
      for (const [toolName, input] of [
        ["subagent_wait", { id: "Child" }],
        ["subagent_join", { ids: ["Child"] }],
        ["task_update", {}],
      ] as const) {
        const blocked = handlers.get("tool_call")({
          type: "tool_call",
          toolCallId: `call_${toolName}`,
          toolName,
          input,
        });
        assert.equal(blocked.block, true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the detached-launch guard after a failed subagent launch", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "scout.md"),
      `---\nname: scout\nmode: background\nblocking: false\n---\n\nScout body.`,
    );

    const handlers = new Map<string, any>();
    try {
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool() {},
      } as any);

      handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_subagent",
        toolName: "subagent",
        input: { name: "Child", agent: "scout", task: "Do work" },
      });
      handlers.get("tool_result")({
        type: "tool_result",
        toolCallId: "call_subagent",
        toolName: "subagent",
        details: { error: "no session file" },
      });
      const allowed = handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_read",
        toolName: "read",
        input: { path: "README.md" },
      });
      assert.deepEqual(allowed, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the detached-launch guard after validation-like sync failure", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "scout.md"),
      `---\nname: scout\nmode: background\nblocking: false\n---\n\nScout body.`,
    );

    const handlers = new Map<string, any>();
    try {
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool() {},
      } as any);

      handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_subagent",
        toolName: "subagent",
        input: { name: "Child", agent: "scout", task: "Do work" },
      });
      handlers.get("tool_result")({
        type: "tool_result",
        toolCallId: "call_wait",
        toolName: "subagent_wait",
        details: {},
      });
      const allowed = handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_read",
        toolName: "read",
        input: { path: "README.md" },
      });
      assert.deepEqual(allowed, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the detached-launch guard after synchronization", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "scout.md"),
      `---\nname: scout\nmode: background\nblocking: false\n---\n\nScout body.`,
    );

    const handlers = new Map<string, any>();
    try {
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool() {},
      } as any);

      handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_subagent",
        toolName: "subagent",
        input: { name: "Child", agent: "scout", task: "Do work" },
      });
      handlers.get("tool_result")({
        type: "tool_result",
        toolCallId: "call_wait",
        toolName: "subagent_wait",
        details: { id: "child-guard", name: "Child", status: "completed" },
      });
      const allowed = handlers.get("tool_call")({
        type: "tool_call",
        toolCallId: "call_read",
        toolName: "read",
        input: { path: "README.md" },
      });
      assert.deepEqual(allowed, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps parent tools available after waiting for detached children", async () => {
    const running = {
      id: "child-guard",
      name: "Child",
      task: "Do work",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-guard.jsonl",
      completionPromise: Promise.resolve({
        name: "Child",
        task: "Do work",
        summary: "Done",
        sessionFile: "/tmp/child-guard.jsonl",
        exitCode: 0,
        elapsed: 1,
      }),
    };

    setRunningSubagentForTest(running);
    const waited = await waitForSubagentForTest({ id: "Child" });
    assert.equal(waited.details.status, "completed");
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
  });

  it("injects one hidden startup catalog for top-level actionable sessions", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
    );

    const handlers = new Map<string, any>();
    subagentsExtension({
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool() {},
      sendMessage() {},
    } as any);

    handlers.get("session_start")(
      { type: "session_start", reason: "startup" },
      {
        cwd: dir,
        hasUI: false,
        ui: { setWidget() {} },
        sessionManager: { getHeader: () => ({ id: "root", type: "session", timestamp: "", cwd: dir }) },
      },
    );

    const result = handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "hi", systemPrompt: "sys" });
    const message = result?.message;
    assert.ok(message);
    assert.equal(message.customType, "subagent_catalog");
    assert.equal(message.display, false);
    assert.equal(message.details.entries[0].name, "reviewer");
    assert.equal(message.details.signature, getSubagentCatalogSignatureForTest(message.details.entries));
    assert.match(message.content, /^<system-reminder>\n/);
    assert.match(message.content, /Available named subagents:/);
    assert.match(message.content, /reviewer \(background\) — Review changes for regressions/);
    assert.match(message.content, /\n<\/system-reminder>$/);
    assert.equal(renderSubagentCatalogReminderForTest(message.details.entries), message.content);
    assert.doesNotMatch(message.content, /subagents_list/);
    assert.match(
      message.content,
      /Launch independent children in parallel whenever possible; to do that, use a single message with multiple subagent tool calls\./,
    );
    assert.equal(handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "again", systemPrompt: "sys" }), undefined);
  });

  it("does not register subagents_list for top-level ambient-aware sessions", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
    );

    const tools = new Map<string, any>();
    subagentsExtension({
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      registerTool(definition: any) {
        tools.set(definition.name, definition);
        return definition;
      },
    } as any);

    assert.ok(tools.get("subagent"));
    assert.equal(tools.has("subagents_list"), false);
  });

  it("queues reload catalog changes for the next turn instead of interrupting immediately", () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review changes for regressions\n---\n\nReviewer body.`,
    );

    const handlers = new Map<string, any>();
    const ctx = {
      cwd: dir,
      hasUI: false,
      ui: { setWidget() {} },
      sessionManager: { getHeader: () => ({ id: "root", type: "session", timestamp: "", cwd: dir }) },
    };

    subagentsExtension({
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool() {},
      sendMessage() {},
    } as any);

    handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
    const startup = handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "start", systemPrompt: "sys" });
    assert.ok(startup?.message);
    assert.equal(startup.message.details.supersedes, undefined);

    writeFileSync(
      join(agentsDir, "researcher.md"),
      `---\nname: researcher\ndescription: Investigate open-ended questions\nmode: background\n---\n\nResearcher body.`,
    );

    handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
    const reloaded = handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "continue", systemPrompt: "sys" });
    assert.ok(reloaded?.message);
    assert.equal(reloaded.message.details.supersedes, true);
    assert.match(reloaded.message.content, /researcher \(background\) — Investigate open-ended questions/);

    handlers.get("session_start")({ type: "session_start", reason: "reload" }, ctx);
    assert.equal(handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "continue again", systemPrompt: "sys" }), undefined);
  });

  it("skips startup catalog injection for child or denied-spawning sessions", () => {
    const dir = createTestDir();
    const prevDenied = process.env.PI_DENY_TOOLS;
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review changes for regressions\n---\n\nReviewer body.`,
    );

    const start = () => {
      const handlers = new Map<string, any>();
      const sent: any[] = [];
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerTool() {},
        sendMessage(message: any) {
          sent.push(message);
        },
      } as any);
      return { handlers, sent };
    };

    try {
      const child = start();
      child.handlers.get("session_start")(
        { type: "session_start", reason: "startup" },
        {
          cwd: dir,
          hasUI: false,
          ui: { setWidget() {} },
          sessionManager: { getHeader: () => ({ id: "child", type: "session", timestamp: "", cwd: dir, parentSession: "/tmp/root.jsonl" }) },
        },
      );
      assert.equal(child.sent.length, 0);

      process.env.PI_DENY_TOOLS = "subagent";
      const denied = start();
      denied.handlers.get("session_start")(
        { type: "session_start", reason: "startup" },
        {
          cwd: dir,
          hasUI: false,
          ui: { setWidget() {} },
          sessionManager: { getHeader: () => ({ id: "root", type: "session", timestamp: "", cwd: dir }) },
        },
      );
      assert.equal(denied.sent.length, 0);
    } finally {
      if (prevDenied == null) delete process.env.PI_DENY_TOOLS;
      else process.env.PI_DENY_TOOLS = prevDenied;
    }
  });

  it("disables ambient awareness via env var without breaking explicit listing", async () => {
    const dir = createTestDir();
    const prevCwd = process.cwd();
    const prevKillSwitch = process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS;
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS = "1";
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: Review changes\nmode: background\n---\n\nReviewer body.`,
    );

    const handlers = new Map<string, any>();
    const tools = new Map<string, any>();
    const sent: any[] = [];

    try {
      process.chdir(dir);
      subagentsExtension({
        on(event: string, handler: any) {
          handlers.set(event, handler);
        },
        registerCommand() {},
        registerMessageRenderer() {},
        registerTool(definition: any) {
          tools.set(definition.name, definition);
          return definition;
        },
        sendMessage(message: any) {
          sent.push(message);
        },
      } as any);

      handlers.get("session_start")(
        { type: "session_start", reason: "startup" },
        {
          cwd: dir,
          hasUI: false,
          ui: { setWidget() {} },
          sessionManager: { getHeader: () => ({ id: "root", type: "session", timestamp: "", cwd: dir }) },
        },
      );
      assert.equal(sent.length, 0);

      const listTool = tools.get("subagents_list");
      assert.ok(listTool);
      const result = await listTool.execute();
      assert.equal(result.details.agents[0].name, "reviewer");
      assert.equal(result.details.agents[0].description, "Review changes");
      assert.match(result.content[0].text, /reviewer/);
      assert.doesNotMatch(result.content[0].text, /\(background\)|\[|\| use:/);
    } finally {
      process.chdir(prevCwd);
      if (prevKillSwitch == null) delete process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS;
      else process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS = prevKillSwitch;
    }
  });

  it("rejects missing or unknown named agents", () => {
    const missing = getSubagentAgentRequirementErrorForTest({ name: "No agent", task: "Work" }, null);
    assert.equal(missing?.details.error, "agent_required");

    const unknown = getSubagentAgentRequirementErrorForTest(
      { name: "Unknown", task: "Work", agent: "does-not-exist" },
      null,
    );
    assert.equal(unknown?.details.error, "agent_not_found");
    assert.equal(unknown?.details.agent, "does-not-exist");
  });

  it("ignores frontmatter-governed call-time duplicates for named agents", () => {
    const defs = {
      path: "/tmp/reviewer.md",
      mode: "interactive" as const,
      blocking: false,
      cwd: "./agents/reviewer",
    };

    const override = getSubagentAgentOverrideErrorForTest(
      {
        agent: "reviewer",
        background: true,
        blocking: true,
        model: "gpt-x",
        systemPrompt: "override",
        skills: "debugger",
        tools: "bash",
        cwd: "packages/worker",
      },
      defs,
    );

    assert.equal(override, null);
  });

  it("allows fork as an explicit launch-time session override", () => {
    const defs = {
      path: "/tmp/reviewer.md",
      mode: "interactive" as const,
      blocking: false,
      sessionMode: "lineage-only" as const,
    };

    assert.equal(
      getSubagentAgentOverrideErrorForTest({ agent: "reviewer", fork: true }, defs),
      null,
    );
    assert.equal(resolveEffectiveSessionModeForTest({ agent: "reviewer" }, defs), "lineage-only");
    assert.equal(resolveEffectiveSessionModeForTest({ agent: "reviewer", fork: true }, defs), "fork");
  });

  it("allows async:false as parent-side sync policy without weakening sync agents", () => {
    assert.equal(resolveSubagentBlockingForTest({ async: false }, { async: true }), true);
    assert.equal(resolveSubagentBlockingForTest({ async: true }, { async: false }), true);
    assert.equal(resolveSubagentBlockingForTest({ async: false }, null), true);
    assert.equal(resolveSubagentBlockingForTest({}, { async: false }), true);
    assert.equal(resolveSubagentBlockingForTest({}, { async: true }), false);
    assert.equal(resolveSubagentBlockingForTest({}, null), false);
    assert.equal(resolveSubagentBlockingForTest({ blocking: true }, { blocking: false }), true);
    assert.equal(resolveSubagentBlockingForTest({ blocking: false }, { blocking: true }), true);
    assert.equal(resolveSubagentBlockingForTest({ async: true }, { blocking: true }), true);

    const blockingOverride = getSubagentAgentOverrideErrorForTest(
      { agent: "reviewer", async: false },
      { path: "/tmp/reviewer.md", mode: "interactive" },
    );
    assert.equal(blockingOverride, null);

    const harmlessAsync = getSubagentAgentOverrideErrorForTest(
      { agent: "reviewer", async: true },
      { path: "/tmp/reviewer.md", mode: "interactive", async: true },
    );
    assert.equal(harmlessAsync, null);
  });

  it("ignores named-agent duplicate fields before session checks", async () => {
    const dir = createTestDir();
    const configDir = join(dir, "agent-root");
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = configDir;
    writeFileSync(
      join(agentsDir, "reviewer.md"),
      `---\nname: reviewer\nmode: interactive\nblocking: false\n---\n\nReviewer body.`,
    );

    const tools = new Map<string, any>();
    const prevCwd = process.cwd();
    try {
      process.chdir(dir);
      subagentsExtension({
        on() {},
        registerCommand() {},
        registerMessageRenderer() {},
        sendMessage() {},
        registerTool(definition: any) {
          tools.set(definition.name, definition);
          return definition;
        },
      } as any);

      const tool = tools.get("subagent");
      assert.ok(tool);
      const result = await tool.execute(
        "call-1",
        { name: "Review", task: "check", agent: "reviewer", background: true, cwd: "packages/worker" },
        undefined,
        undefined,
        {
          cwd: dir,
          hasUI: false,
          ui: { setWidget() {} },
          sessionManager: { getSessionFile: () => null },
        },
      );

      assert.equal(result.details.error, "no session file");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("resolves relative cwd values against the provided base", () => {
    assert.equal(
      resolveSubagentCwdForTest("roles/tester", "/tmp/custom-agent-root"),
      "/tmp/custom-agent-root/roles/tester",
    );
    assert.equal(resolveSubagentCwdForTest("/tmp/already-absolute", "/tmp/base"), "/tmp/already-absolute");
  });

  it("prefers a target project's .pi/agent dir for subagent config isolation", () => {
    const dir = createTestDir();
    const target = join(dir, "target");
    const localAgentDir = join(target, ".pi", "agent");
    mkdirSync(localAgentDir, { recursive: true });

    assert.equal(resolveSubagentConfigDir("target", dir), localAgentDir);
    assert.equal(resolveSubagentConfigDir("missing", dir), null);
    assert.equal(resolveSubagentConfigDir(null, dir), null);
  });

  it("stores child sessions under the child agent dir when cwd has its own .pi/agent", () => {
    const dir = createTestDir();
    const target = join(dir, "packages", "worker");
    const localAgentDir = join(target, ".pi", "agent");
    mkdirSync(localAgentDir, { recursive: true });

    const parentSessionDir = join(dir, "parent-sessions");
    const paths = resolveSubagentRuntimePathsForTest({ cwd: "packages/worker" }, null, dir, parentSessionDir);
    assert.equal(paths.effectiveCwd, target);
    assert.equal(paths.localAgentConfigDir, localAgentDir);
    assert.equal(paths.effectiveAgentConfigDir, localAgentDir);
    assert.equal(paths.targetCwdForSession, target);
    assert.equal(paths.sessionDir, join(localAgentDir, "sessions", `--tmp-${basename(dir)}-packages-worker--`));
  });

  it("falls back to the global agent dir for child sessions when no local config exists", () => {
    const dir = createTestDir();
    const globalAgentDir = join(dir, "global-agent");
    mkdirSync(globalAgentDir, { recursive: true });
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;

    try {
      const parentSessionDir = join(dir, "parent-sessions");
      const paths = resolveSubagentRuntimePathsForTest({ cwd: "missing-child" }, null, dir, parentSessionDir);
      assert.equal(paths.localAgentConfigDir, null);
      assert.equal(paths.effectiveAgentConfigDir, globalAgentDir);
      assert.equal(paths.targetCwdForSession, join(dir, "missing-child"));
      assert.equal(paths.sessionDir, parentSessionDir);
    } finally {
      if (original == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = original;
    }
  });

  it("writes system prompts to artifact files for CLI-safe routing", () => {
    const dir = createTestDir();
    const sessionId = "session-123";
    const systemPrompt = `You are a specialist.\n\nQuotes: ' \" $HOME`;
    const artifactPath = writeSystemPromptArtifactForTest("Spec Agent", systemPrompt, {
      cwd: dir,
      sessionManager: { getSessionId: () => sessionId },
    });

    assert.equal(readFileSync(artifactPath, "utf8"), systemPrompt);
    assert.ok(
      artifactPath.startsWith(join(getSessionArtifactDir(dir, sessionId), "context", "spec-agent-sysprompt-")),
    );
    assert.match(artifactPath, /\.md$/);
  });

  it("detects terminal assistant summaries only after final non-tool-use output", () => {
    assert.equal(
      getTerminalAssistantSummaryForTest([
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "DONE" }],
          },
        },
      ] as any[]),
      "DONE",
    );

    assert.equal(
      getTerminalAssistantSummaryForTest([
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "text", text: "Not final" }],
          },
        },
      ] as any[]),
      null,
    );

    assert.equal(
      getTerminalAssistantSummaryForTest([
        {
          type: "message",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Done" }],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "later" }],
          },
        },
      ] as any[]),
      null,
    );
  });

  it("creates forked child session files directly", () => {
    const dir = createTestDir();
    const parent = join(dir, "parent.jsonl");
    const child = join(dir, "child.jsonl");
    const triggerUser = {
      type: "message",
      id: "user-trigger",
      parentId: "asst-001",
      message: {
        role: "user",
        content: [{ type: "text", text: "Use subagent to fork this session" }],
      },
    };
    writeFileSync(
      parent,
      [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, triggerUser]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );

    createForkSessionFileForTest(parent, child);
    const entries = getEntries(child) as any[];

    assert.equal(entries[0].type, "session");
    assert.equal(entries[0].parentSession, parent);
    assert.equal(entries.at(-1)?.id, "asst-001");
    assert.ok(!JSON.stringify(entries).includes("Use subagent to fork this session"));
  });

  it("returns detached launch metadata and routes completion exactly once via steer", () => {
    const sent: Array<{ message: any; options: any }> = [];
    const running = {
      id: "child-123",
      name: "Detached child",
      task: "Do the work",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      blocking: false,
      startTime: Date.now(),
      sessionFile: "/tmp/child-session.jsonl",
    };

    const started = getStartedSubagentDetailsForTest(running);
    assert.equal(started.status, "started");
    assert.equal(started.mode, "background");
    assert.equal(started.deliveryState, "detached");
    assert.equal(started.parentClosePolicy, "terminate");
    assert.equal(started.blocking, false);

    const cached = routeDetachedSubagentCompletionForTest(
      {
        sendMessage(message: any, options: any) {
          sent.push({ message, options });
        },
      },
      running,
      {
        name: running.name,
        task: running.task,
        summary: "Detached completion summary",
        sessionFile: running.sessionFile,
        exitCode: 0,
        elapsed: 1,
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.deliverAs, "steer");
    assert.equal(sent[0].message.details.id, running.id);
    assert.equal(sent[0].message.details.deliveryState, "detached");
    assert.equal(sent[0].message.details.parentClosePolicy, "terminate");
    assert.equal(sent[0].message.details.status, "completed");
    assert.equal(sent[0].message.details.blocking, false);

    assert.equal(cached.deliveredTo, "steer");
    assert.equal(cached.deliveryState, "detached");
    assert.equal(cached.parentClosePolicy, "terminate");
    assert.equal(cached.status, "completed");
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
  });

  it("returns an awaited result immediately when launched as blocking", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveCompletion!: (result: any) => void;
    const completionPromise = new Promise<any>((resolve) => {
      resolveCompletion = resolve;
    });
    const running = {
      id: "child-blocking-1",
      name: "Blocking child",
      task: "Finish before returning",
      mode: "interactive" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      blocking: true,
      startTime: Date.now(),
      sessionFile: "/tmp/child-blocking-1.jsonl",
      completionPromise,
    };

    setRunningSubagentForTest(running);
    completionPromise.then((result) => {
      routeDetachedSubagentCompletionForTest(
        {
          sendMessage(message: any, options: any) {
            sent.push({ message, options });
          },
        },
        running,
        result,
      );
    });

    const launchedPromise = getLaunchedSubagentResultForTest(running);
    resolveCompletion({
      name: running.name,
      task: running.task,
      summary: "Blocking completion summary",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 2,
    });

    const launched = await launchedPromise;
    assert.equal(launched.details.status, "completed");
    assert.equal(launched.details.deliveryState, "awaited");
    assert.equal(launched.details.blocking, true);
    assert.equal(sent.length, 0);
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
  });

  it("keeps detached siblings running while a blocking child gates the parent", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveAsyncA!: (result: any) => void;
    let resolveAsyncB!: (result: any) => void;
    let resolveBlocking!: (result: any) => void;
    const asyncAPromise = new Promise<any>((resolve) => {
      resolveAsyncA = resolve;
    });
    const asyncBPromise = new Promise<any>((resolve) => {
      resolveAsyncB = resolve;
    });
    const blockingPromise = new Promise<any>((resolve) => {
      resolveBlocking = resolve;
    });

    const asyncA = {
      id: "child-mix-async-a",
      name: "Async A",
      task: "Keep running",
      mode: "interactive" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      blocking: false,
      startTime: Date.now(),
      sessionFile: "/tmp/child-mix-async-a.jsonl",
      completionPromise: asyncAPromise,
    };
    const asyncB = {
      id: "child-mix-async-b",
      name: "Async B",
      task: "Keep running",
      mode: "interactive" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      blocking: false,
      startTime: Date.now(),
      sessionFile: "/tmp/child-mix-async-b.jsonl",
      completionPromise: asyncBPromise,
    };
    const blocking = {
      id: "child-mix-blocking",
      name: "Blocking gate",
      task: "Gate the parent",
      mode: "interactive" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      blocking: true,
      startTime: Date.now(),
      sessionFile: "/tmp/child-mix-blocking.jsonl",
      completionPromise: blockingPromise,
    };

    for (const running of [asyncA, asyncB, blocking]) {
      setRunningSubagentForTest(running);
      running.completionPromise.then((result: any) => {
        routeDetachedSubagentCompletionForTest(
          {
            sendMessage(message: any, options: any) {
              sent.push({ message, options });
            },
          },
          running,
          result,
        );
      });
    }

    const launchedPromise = getLaunchedSubagentResultForTest(blocking);
    resolveBlocking({
      name: blocking.name,
      task: blocking.task,
      summary: "Blocking gate summary",
      sessionFile: blocking.sessionFile,
      exitCode: 0,
      elapsed: 3,
    });

    const launched = await launchedPromise;
    assert.equal(launched.details.status, "completed");
    assert.equal(launched.details.deliveryState, "awaited");
    assert.equal(sent.length, 0);

    resolveAsyncA({
      name: asyncA.name,
      task: asyncA.task,
      summary: "Async A summary",
      sessionFile: asyncA.sessionFile,
      exitCode: 0,
      elapsed: 4,
    });
    resolveAsyncB({
      name: asyncB.name,
      task: asyncB.task,
      summary: "Async B summary",
      sessionFile: asyncB.sessionFile,
      exitCode: 0,
      elapsed: 5,
    });
    await sleep(0);

    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((entry) => entry.message.details.name).sort(),
      ["Async A", "Async B"],
    );
    assert.equal(getCompletedSubagentResultForTest(blocking.id)?.deliveredTo, "wait");
    assert.equal(getCompletedSubagentResultForTest(asyncA.id)?.deliveredTo, "steer");
    assert.equal(getCompletedSubagentResultForTest(asyncB.id)?.deliveredTo, "steer");
  });

  it("renders agent badges while preserving detached and awaited styling slots", () => {
    const base = {
      mode: "background" as const,
      executionState: "running" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/widget-child.jsonl",
      activity: "Working",
    };

    setRunningSubagentForTest({
      ...base,
      id: "child-widget-1",
      name: "Detached child",
      agent: "scout",
      task: "Keep running",
      deliveryState: "detached" as const,
    });
    setRunningSubagentForTest({
      ...base,
      id: "child-widget-2",
      name: "Awaited child",
      agent: "researcher",
      task: "Wait here",
      deliveryState: "awaited" as const,
    });
    setRunningSubagentForTest({
      ...base,
      id: "child-widget-3",
      name: "Joined child",
      agent: "reviewer",
      task: "Join here",
      deliveryState: "joined" as const,
    });

    const widget = renderSubagentWidgetForTest().join("\n");
    assert.match(widget, /Detached child \[scout\]/);
    assert.match(widget, /Awaited child \[researcher\]/);
    assert.match(widget, /Joined child \[reviewer\]/);
    assert.doesNotMatch(widget, /\[detached\]|\[awaited\]|\[joined\]/);
  });

  it("waits for one running subagent and suppresses steer delivery", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveCompletion!: (result: any) => void;
    const completionPromise = new Promise<any>((resolve) => {
      resolveCompletion = resolve;
    });
    const running = {
      id: "child-wait-1",
      name: "Awaited child",
      task: "Wait for me",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-1.jsonl",
      completionPromise,
    };

    setRunningSubagentForTest(running);
    completionPromise.then((result) => {
      routeDetachedSubagentCompletionForTest(
        {
          sendMessage(message: any, options: any) {
            sent.push({ message, options });
          },
        },
        running,
        result,
      );
    });

    const waitPromise = waitForSubagentForTest({ id: running.name });
    assert.equal(running.deliveryState, "awaited");

    resolveCompletion({
      name: running.name,
      task: running.task,
      summary: "Waited completion summary",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 2,
    });

    const waited = await waitPromise;
    assert.equal(waited.details.id, running.id);
    assert.equal(waited.details.status, "completed");
    assert.equal(waited.details.deliveryState, "awaited");
    assert.equal(waited.details.exitCode, 0);
    assert.equal(sent.length, 0);
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveryState, "awaited");
  });

  it("returns a ping result instead of completion when an awaited child asks for help", async () => {
    const running = {
      id: "child-wait-ping",
      name: "Ping child",
      task: "Need help",
      mode: "interactive" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-ping.jsonl",
      completionPromise: Promise.resolve({
        name: "Ping child",
        task: "Need help",
        summary: "Need parent help",
        sessionFile: "/tmp/child-wait-ping.jsonl",
        exitCode: 0,
        elapsed: 1,
        ping: { name: "Ping child", message: "Please answer" },
      }),
    };

    setRunningSubagentForTest(running);
    const waited = await waitForSubagentForTest({ id: running.id });
    assert.equal(waited.details.id, running.id);
    assert.equal(waited.details.status, "pinged");
    assert.equal(waited.details.deliveryState, "awaited");
    assert.equal(waited.details.sessionFile, running.sessionFile);
    assert.equal(waited.details.message, "Please answer");
    assert.equal(getCompletedSubagentResultForTest(running.id), undefined);
  });

  it("returns cached result when a wait is repeated", async () => {
    const running = {
      id: "child-wait-repeat",
      name: "Repeated wait child",
      task: "Wait twice",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-repeat.jsonl",
      completionPromise: Promise.resolve({
        name: "Repeated wait child",
        task: "Wait twice",
        summary: "Done",
        sessionFile: "/tmp/child-wait-repeat.jsonl",
        exitCode: 0,
        elapsed: 1,
      }),
    };

    setRunningSubagentForTest(running);
    const first = await waitForSubagentForTest({ id: running.name });
    const second = await waitForSubagentForTest({ id: running.name });
    assert.equal(first.details.status, "completed");
    assert.equal(second.details.status, "completed");
    assert.equal(second.details.id, running.id);
  });

  it("returns cached result when wait follows steer delivery", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    const running = {
      id: "child-wait-2",
      name: "Already delivered child",
      task: "Too late",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-2.jsonl",
    };

    routeDetachedSubagentCompletionForTest(
      {
        sendMessage(message: any, options: any) {
          sent.push({ message, options });
        },
      },
      running,
      {
        name: running.name,
        task: running.task,
        summary: "Detached completion summary",
        sessionFile: running.sessionFile,
        exitCode: 0,
        elapsed: 1,
      },
    );

    const waited = await waitForSubagentForTest({ id: running.id });
    assert.equal(sent.length, 1);
    assert.equal(waited.details.id, running.id);
    assert.equal(waited.details.name, running.name);
    assert.equal(waited.details.status, "completed");
    assert.equal(waited.details.deliveryState, "awaited");
    assert.equal(waited.details.exitCode, 0);
  });

  it("returns pending on wait timeout and restores detached delivery", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveCompletion!: (result: any) => void;
    const completionPromise = new Promise<any>((resolve) => {
      resolveCompletion = resolve;
    });
    const running = {
      id: "child-wait-3",
      name: "Slow child",
      task: "Still running",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-3.jsonl",
      completionPromise,
    };

    setRunningSubagentForTest(running);
    completionPromise.then((result) => {
      routeDetachedSubagentCompletionForTest(
        {
          sendMessage(message: any, options: any) {
            sent.push({ message, options });
          },
        },
        running,
        result,
      );
    });

    const waited = await waitForSubagentForTest({
      id: running.id,
      timeout: 0.01,
      onTimeout: "detach",
    });

    assert.equal(waited.details.status, "pending");
    assert.equal(waited.details.deliveryState, "detached");
    assert.equal(running.deliveryState, "detached");

    resolveCompletion({
      name: running.name,
      task: running.task,
      summary: "Late completion summary",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 3,
    });
    await sleep(0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.details.id, running.id);
    assert.equal(sent[0].message.details.deliveryState, "detached");
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
  });

  it("joins cached results that were already delivered by wait", async () => {
    const running = {
      id: "child-join-after-wait",
      name: "Join after wait child",
      task: "Wait then join",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-after-wait.jsonl",
      completionPromise: Promise.resolve({
        name: "Join after wait child",
        task: "Wait then join",
        summary: "Done",
        sessionFile: "/tmp/child-join-after-wait.jsonl",
        exitCode: 0,
        elapsed: 1,
      }),
    };

    setRunningSubagentForTest(running);
    const waited = await waitForSubagentForTest({ id: running.name });
    assert.equal(waited.details.status, "completed");

    const joined = await joinSubagentsForTest({ ids: [running.name] });
    assert.equal(joined.details.ids[0], running.id);
    assert.equal(joined.details.results[running.id].exitCode, 0);
    assert.equal(joined.details.results[running.id].sessionFile, running.sessionFile);
  });

  it("joins multiple running subagents and suppresses steer delivery", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveFirst!: (result: any) => void;
    let resolveSecond!: (result: any) => void;
    const firstCompletionPromise = new Promise<any>((resolve) => {
      resolveFirst = resolve;
    });
    const secondCompletionPromise = new Promise<any>((resolve) => {
      resolveSecond = resolve;
    });
    const first = {
      id: "child-join-1",
      name: "First join child",
      task: "First task",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-1.jsonl",
      completionPromise: firstCompletionPromise,
    };
    const second = {
      id: "child-join-2",
      name: "Second join child",
      task: "Second task",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-2.jsonl",
      completionPromise: secondCompletionPromise,
    };

    for (const running of [first, second]) {
      setRunningSubagentForTest(running);
      running.completionPromise.then((result: any) => {
        routeDetachedSubagentCompletionForTest(
          {
            sendMessage(message: any, options: any) {
              sent.push({ message, options });
            },
          },
          running,
          result,
        );
      });
    }

    const joinPromise = joinSubagentsForTest({ ids: [first.name, second.id] });
    assert.equal(first.deliveryState, "joined");
    assert.equal(second.deliveryState, "joined");

    resolveFirst({
      name: first.name,
      task: first.task,
      summary: "First joined summary",
      sessionFile: first.sessionFile,
      exitCode: 0,
      elapsed: 2,
    });
    await sleep(0);
    resolveSecond({
      name: second.name,
      task: second.task,
      summary: "Second joined summary",
      sessionFile: second.sessionFile,
      exitCode: 0,
      elapsed: 3,
    });

    const joined = await joinPromise;
    assert.equal(joined.details.status, "completed");
    assert.equal(joined.details.deliveryState, "joined");
    assert.deepEqual(joined.details.ids, [first.id, second.id]);
    assert.deepEqual(Object.keys(joined.details.results).sort(), [first.id, second.id]);
    assert.equal(sent.length, 0);
    assert.equal(getCompletedSubagentResultForTest(first.id)?.deliveredTo, "join");
    assert.equal(getCompletedSubagentResultForTest(second.id)?.deliveredTo, "join");
  });

  it("returns partial join results on timeout and releases pending children back to steer", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveFirst!: (result: any) => void;
    let resolveSecond!: (result: any) => void;
    const firstCompletionPromise = new Promise<any>((resolve) => {
      resolveFirst = resolve;
    });
    const secondCompletionPromise = new Promise<any>((resolve) => {
      resolveSecond = resolve;
    });
    const first = {
      id: "child-join-3",
      name: "Partial join child",
      task: "First partial task",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-3.jsonl",
      completionPromise: firstCompletionPromise,
    };
    const second = {
      id: "child-join-4",
      name: "Late steer child",
      task: "Second partial task",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-4.jsonl",
      completionPromise: secondCompletionPromise,
    };

    for (const running of [first, second]) {
      setRunningSubagentForTest(running);
      running.completionPromise.then((result: any) => {
        routeDetachedSubagentCompletionForTest(
          {
            sendMessage(message: any, options: any) {
              sent.push({ message, options });
            },
          },
          running,
          result,
        );
      });
    }

    const joinPromise = joinSubagentsForTest({
      ids: [first.id, second.id],
      timeout: 0.01,
      onTimeout: "return_partial",
    });

    resolveFirst({
      name: first.name,
      task: first.task,
      summary: "Partial joined summary",
      sessionFile: first.sessionFile,
      exitCode: 0,
      elapsed: 4,
    });

    const joined = await joinPromise;
    assert.equal(joined.details.status, "partial");
    assert.deepEqual(joined.details.pendingIds, [second.id]);
    assert.equal(joined.details.results[first.id].exitCode, 0);
    assert.equal(first.deliveryState, "joined");
    assert.equal(second.deliveryState, "detached");
    assert.equal(getCompletedSubagentResultForTest(first.id)?.deliveredTo, "join");

    resolveSecond({
      name: second.name,
      task: second.task,
      summary: "Late steer summary",
      sessionFile: second.sessionFile,
      exitCode: 0,
      elapsed: 5,
    });
    await sleep(0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.details.id, second.id);
    assert.equal(sent[0].message.details.deliveryState, "detached");
    assert.equal(getCompletedSubagentResultForTest(second.id)?.deliveredTo, "steer");
  });

  it("detaches an owned child back to detached async delivery", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveCompletion!: (result: any) => void;
    const completionPromise = new Promise<any>((resolve) => {
      resolveCompletion = resolve;
    });
    const running = {
      id: "child-detach-1",
      name: "Detached again child",
      task: "Release ownership",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "awaited" as const,
      parentClosePolicy: "terminate" as const,
      resultOwner: { kind: "wait" as const, ownerId: "wait:test" },
      startTime: Date.now(),
      sessionFile: "/tmp/child-detach-1.jsonl",
      completionPromise,
    };

    setRunningSubagentForTest(running);
    completionPromise.then((result) => {
      routeDetachedSubagentCompletionForTest(
        {
          sendMessage(message: any, options: any) {
            sent.push({ message, options });
          },
        },
        running,
        result,
      );
    });

    const detached = detachSubagentForTest({ id: running.id });
    assert.equal(detached.details.status, "detached");
    assert.equal(detached.details.deliveryState, "detached");
    assert.equal(running.deliveryState, "detached");
    assert.equal(running.resultOwner, undefined);

    resolveCompletion({
      name: running.name,
      task: running.task,
      summary: "Detached completion summary",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 6,
    });
    await sleep(0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.details.id, running.id);
    assert.equal(sent[0].message.details.deliveryState, "detached");
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
  });

  it("returns not_owned when detaching a detached child", () => {
    const running = {
      id: "child-detach-2",
      name: "Detached child",
      task: "Already detached",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-detach-2.jsonl",
    };

    setRunningSubagentForTest(running);

    const detached = detachSubagentForTest({ id: running.id });
    assert.equal(detached.details.error, "not_owned");
  });

  it("returns already_owned when wait or join targets an owned child", async () => {
    const awaited = {
      id: "child-detach-3",
      name: "Await-owned child",
      task: "Owned by wait",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "awaited" as const,
      parentClosePolicy: "terminate" as const,
      resultOwner: { kind: "wait" as const, ownerId: "wait:test" },
      startTime: Date.now(),
      sessionFile: "/tmp/child-detach-3.jsonl",
      completionPromise: new Promise<any>(() => {}),
    };
    setRunningSubagentForTest(awaited);
    const joined = await joinSubagentsForTest({ ids: [awaited.id] });
    assert.equal(joined.details.error, "already_owned");

    const joinedRunning = {
      id: "child-detach-4",
      name: "Join-owned child",
      task: "Owned by join",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "joined" as const,
      parentClosePolicy: "terminate" as const,
      resultOwner: { kind: "join" as const, ownerId: "join:test" },
      startTime: Date.now(),
      sessionFile: "/tmp/child-detach-4.jsonl",
      completionPromise: new Promise<any>(() => {}),
    };
    setRunningSubagentForTest(joinedRunning);
    const waited = await waitForSubagentForTest({ id: joinedRunning.id });
    assert.equal(waited.details.error, "already_owned");
  });

  it("returns timeout errors for wait and restores detached delivery", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveCompletion!: (result: any) => void;
    const completionPromise = new Promise<any>((resolve) => {
      resolveCompletion = resolve;
    });
    const running = {
      id: "child-wait-timeout-error",
      name: "Timeout child",
      task: "Miss the deadline",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-timeout-error.jsonl",
      completionPromise,
    };

    setRunningSubagentForTest(running);
    completionPromise.then((result) => {
      routeDetachedSubagentCompletionForTest(
        {
          sendMessage(message: any, options: any) {
            sent.push({ message, options });
          },
        },
        running,
        result,
      );
    });

    const waited = await waitForSubagentForTest({ id: running.id, timeout: 0.01 });
    assert.equal(waited.details.error, "timeout");
    assert.equal(running.deliveryState, "detached");
    assert.equal(running.resultOwner, undefined);

    resolveCompletion({
      name: running.name,
      task: running.task,
      summary: "Late timeout summary",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 7,
    });
    await sleep(0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.details.id, running.id);
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
  });

  it("returns invalid_ids for empty or duplicate join sets", async () => {
    const empty = await joinSubagentsForTest({ ids: [] });
    assert.equal(empty.details.error, "invalid_ids");

    const duplicate = await joinSubagentsForTest({ ids: ["dup-child", "dup-child"] });
    assert.equal(duplicate.details.error, "invalid_ids");
  });

  it("releases awaited children back to steer when wait is interrupted", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveCompletion!: (result: any) => void;
    const completionPromise = new Promise<any>((resolve) => {
      resolveCompletion = resolve;
    });
    const running = {
      id: "child-wait-interrupt-1",
      name: "Interrupted wait child",
      task: "Resume detached delivery",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-wait-interrupt-1.jsonl",
      completionPromise,
    };

    setRunningSubagentForTest(running);
    completionPromise.then((result) => {
      routeDetachedSubagentCompletionForTest(
        {
          sendMessage(message: any, options: any) {
            sent.push({ message, options });
          },
        },
        running,
        result,
      );
    });

    const abort = new AbortController();
    const waitPromise = waitForSubagentForTest({ id: running.id }, abort.signal);
    assert.equal(running.deliveryState, "awaited");

    abort.abort();
    const waited = await waitPromise;
    assert.equal(waited.details.error, "interrupted");
    assert.equal(running.deliveryState, "detached");
    assert.equal(running.resultOwner, undefined);

    resolveCompletion({
      name: running.name,
      task: running.task,
      summary: "Interrupted wait summary",
      sessionFile: running.sessionFile,
      exitCode: 0,
      elapsed: 8,
    });
    await sleep(0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].options.deliverAs, "steer");
    assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
  });

  it("releases completed and pending join members deterministically when join is interrupted", async () => {
    const sent: Array<{ message: any; options: any }> = [];
    let resolveFirst!: (result: any) => void;
    let resolveSecond!: (result: any) => void;
    const firstCompletionPromise = new Promise<any>((resolve) => {
      resolveFirst = resolve;
    });
    const secondCompletionPromise = new Promise<any>((resolve) => {
      resolveSecond = resolve;
    });
    const first = {
      id: "child-join-interrupt-1",
      name: "Completed before interrupt",
      task: "Join first",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-interrupt-1.jsonl",
      completionPromise: firstCompletionPromise,
    };
    const second = {
      id: "child-join-interrupt-2",
      name: "Pending after interrupt",
      task: "Join second",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "detached" as const,
      parentClosePolicy: "terminate" as const,
      startTime: Date.now(),
      sessionFile: "/tmp/child-join-interrupt-2.jsonl",
      completionPromise: secondCompletionPromise,
    };

    for (const running of [first, second]) {
      setRunningSubagentForTest(running);
      running.completionPromise.then((result: any) => {
        routeDetachedSubagentCompletionForTest(
          {
            sendMessage(message: any, options: any) {
              sent.push({ message, options });
            },
          },
          running,
          result,
        );
      });
    }

    const abort = new AbortController();
    const joinPromise = joinSubagentsForTest({ ids: [first.id, second.id] }, abort.signal, {
      sendMessage(message: any, options: any) {
        sent.push({ message, options });
      },
    });

    resolveFirst({
      name: first.name,
      task: first.task,
      summary: "Completed before interrupt summary",
      sessionFile: first.sessionFile,
      exitCode: 0,
      elapsed: 9,
    });
    await sleep(0);
    assert.equal(sent.length, 0);

    abort.abort();
    const joined = await joinPromise;
    assert.equal(joined.details.error, "interrupted");
    assert.equal(first.deliveryState, "joined");
    assert.equal(second.deliveryState, "detached");
    assert.equal(getCompletedSubagentResultForTest(first.id)?.deliveredTo, "steer");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.details.id, first.id);

    resolveSecond({
      name: second.name,
      task: second.task,
      summary: "Pending after interrupt summary",
      sessionFile: second.sessionFile,
      exitCode: 0,
      elapsed: 10,
    });
    await sleep(0);

    assert.equal(sent.length, 2);
    assert.equal(sent[1].message.details.id, second.id);
    assert.equal(getCompletedSubagentResultForTest(second.id)?.deliveredTo, "steer");
  });

  it("honors parent close policies during session shutdown", async () => {
    const dir = createTestDir();
    const abandonSessionFile = join(dir, "abandon-child.jsonl");
    writeFileSync(abandonSessionFile, "");

    const terminateAbort = new AbortController();
    const cancelAbort = new AbortController();
    let terminateAbortCount = 0;
    let cancelAbortCount = 0;
    terminateAbort.signal.addEventListener("abort", () => terminateAbortCount++);
    cancelAbort.signal.addEventListener("abort", () => cancelAbortCount++);

    const terminate = {
      id: "child-close-1",
      name: "Terminate child",
      task: "Stop on shutdown",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "awaited" as const,
      parentClosePolicy: "terminate" as const,
      resultOwner: { kind: "wait" as const, ownerId: "wait:shutdown" },
      startTime: Date.now(),
      sessionFile: "/tmp/child-close-1.jsonl",
      abortController: terminateAbort,
    };
    const cancel = {
      id: "child-close-2",
      name: "Cancel child",
      task: "Interrupt first",
      mode: "interactive" as const,
      executionState: "running" as const,
      deliveryState: "joined" as const,
      parentClosePolicy: "cancel" as const,
      resultOwner: { kind: "join" as const, ownerId: "join:shutdown" },
      startTime: Date.now(),
      sessionFile: "/tmp/child-close-2.jsonl",
      surface: "%42",
      abortController: cancelAbort,
    };
    const abandon = {
      id: "child-close-3",
      name: "Abandon child",
      task: "Keep running",
      mode: "background" as const,
      executionState: "running" as const,
      deliveryState: "joined" as const,
      parentClosePolicy: "abandon" as const,
      resultOwner: { kind: "join" as const, ownerId: "join:shutdown" },
      startTime: Date.now(),
      sessionFile: abandonSessionFile,
    };

    for (const running of [terminate, cancel, abandon]) {
      setRunningSubagentForTest(running);
    }

    const interrupted: string[] = [];
    const actions = shutdownSubagentsForTest({
      escalationMs: 10,
      interruptSurfaceImpl(surface) {
        interrupted.push(surface);
      },
    });

    assert.deepEqual(
      actions.map(({ id, action }) => `${id}:${action}`),
      [
        "child-close-1:terminate",
        "child-close-2:cancel",
        "child-close-3:abandon",
      ],
    );
    assert.equal(terminateAbortCount, 1);
    assert.deepEqual(interrupted, ["%42"]);
    assert.equal(cancelAbortCount, 0);
    assert.equal(terminate.resultOwner, undefined);
    assert.equal(cancel.resultOwner, undefined);
    assert.equal(abandon.resultOwner, undefined);
    assert.equal(terminate.deliveryState, "detached");
    assert.equal(cancel.deliveryState, "detached");
    assert.equal(abandon.deliveryState, "detached");
    assert.equal(abandon.allowSteerDelivery, false);
    assert.equal(existsSync(abandon.sessionFile), true);

    await sleep(25);
    assert.equal(cancelAbortCount, 1);

    const sent: Array<{ message: any; options: any }> = [];
    routeDetachedSubagentCompletionForTest(
      {
        sendMessage(message: any, options: any) {
          sent.push({ message, options });
        },
      },
      abandon,
      {
        name: abandon.name,
        task: abandon.task,
        summary: "Finished after parent shutdown",
        sessionFile: abandon.sessionFile,
        exitCode: 0,
        elapsed: 4,
      },
    );

    assert.equal(sent.length, 0);
    assert.equal(getCompletedSubagentResultForTest(abandon.id), undefined);
  });
});

describe("launch helpers", () => {
  it("uses a configurable shell-ready delay", () => {
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    assert.equal(getShellReadyDelayMs(), 500);

    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    assert.equal(getShellReadyDelayMs(), 2500);

    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "nope";
    assert.equal(getShellReadyDelayMs(), 500);
  });

  it("inserts a separator before skill prompts for artifact-backed launches", () => {
    assert.deepEqual(
      buildPiPromptArgsForTest(["debugger", "pua"], "@/tmp/task.md", false),
      ["", "/skill:debugger", "/skill:pua", "@/tmp/task.md"],
    );
    assert.deepEqual(
      buildPiPromptArgsForTest(["debugger"], "do work", true),
      ["/skill:debugger", "do work"],
    );
  });

  it("registers set_tab_title only when explicitly enabled", () => {
    const tools = new Map<string, any>();
    delete process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE;

    subagentsExtension({
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      registerTool(definition: any) {
        tools.set(definition.name, definition);
        return definition;
      },
    } as any);
    assert.equal(tools.has("set_tab_title"), false);

    process.env.PI_SUBAGENT_ENABLE_SET_TAB_TITLE = "1";
    tools.clear();
    subagentsExtension({
      on() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      registerTool(definition: any) {
        tools.set(definition.name, definition);
        return definition;
      },
    } as any);
    assert.equal(tools.has("set_tab_title"), true);
  });
});

describe("mux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("environment helpers", () => {
    it("detects fish shell and the correct exit status variable", () => {
      process.env.SHELL = "/usr/bin/fish";
      assert.equal(isFishShell(), true);
      assert.equal(exitStatusVar(), "$status");

      process.env.SHELL = "/bin/zsh";
      assert.equal(isFishShell(), false);
      assert.equal(exitStatusVar(), "$?");
    });

    it("selects tmux when it is the available runtime", () => {
      process.env.PI_SUBAGENT_MUX = "tmux";
      process.env.TMUX = "test-tmux-socket";
      delete process.env.CMUX_SOCKET_PATH;
      delete process.env.WEZTERM_UNIX_SOCKET;
      delete process.env.ZELLIJ;
      delete process.env.ZELLIJ_SESSION_NAME;

      assert.equal(getMuxBackend(), "tmux");
      assert.equal(isMuxAvailable(), true);
    });


    it("returns null when the preferred backend is unavailable", () => {
      process.env.PI_SUBAGENT_MUX = "cmux";
      delete process.env.CMUX_SOCKET_PATH;
      delete process.env.TMUX;
      delete process.env.WEZTERM_UNIX_SOCKET;
      delete process.env.ZELLIJ;
      delete process.env.ZELLIJ_SESSION_NAME;

      assert.equal(getMuxBackend(), null);
      assert.equal(isMuxAvailable(), false);
    });

    it("returns a setup hint for the selected preference", () => {
      process.env.PI_SUBAGENT_MUX = "tmux";
      assert.match(muxSetupHint(), /tmux new -A -s pi 'pi'/);

      process.env.PI_SUBAGENT_MUX = "zellij";
      assert.match(muxSetupHint(), /zellij --session pi/);

      process.env.PI_SUBAGENT_MUX = "wezterm";
      assert.match(muxSetupHint(), /WezTerm/);
    });

    it("reports cmux availability as a boolean", () => {
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("exit sidecar polling", () => {
    it("returns a done result from the session exit sidecar", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "child.jsonl");
      writeFileSync(sessionFile, "");
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));

      try {
        const result = await pollForExit("ignored", new AbortController().signal, {
          interval: 10,
          sessionFile,
        });
        assert.equal(result.reason, "done");
        assert.equal(result.exitCode, 0);
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns a ping result from the session exit sidecar", async () => {
      const dir = createTestDir();
      const sessionFile = join(dir, "child.jsonl");
      writeFileSync(sessionFile, "");
      writeFileSync(
        `${sessionFile}.exit`,
        JSON.stringify({ type: "ping", name: "Ping Child", message: "Need input" }),
      );

      try {
        const result = await pollForExit("ignored", new AbortController().signal, {
          interval: 10,
          sessionFile,
        });
        assert.equal(result.reason, "ping");
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.ping, { name: "Ping Child", message: "Need input" });
        assert.equal(existsSync(`${sessionFile}.exit`), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  const canRunTmuxIntegration = !!ORIGINAL_ENV.TMUX && !!ORIGINAL_ENV.TMUX_PANE && isTmuxAvailable();

  describe("tmux integration", () => {
    const maybeIt = canRunTmuxIntegration ? it : it.skip;

    maybeIt("creates panes, sends commands, reads output, and closes them", async () => {
      let baseSurface: string | undefined;
      let splitSurface: string | undefined;
      const marker = `pane-output-${Date.now()}`;

      try {
        baseSurface = createSurface("Pi Test Base");
        splitSurface = createSurfaceSplit("Pi Test Split", "down", baseSurface);
        assert.notEqual(baseSurface, splitSurface);

        sendCommand(splitSurface, `printf '${marker}'`);
        await sleep(250);

        assert.match(readScreen(splitSurface, 20).replace(/\s+/g, ""), new RegExp(marker));
        assert.match((await readScreenAsync(splitSurface, 20)).replace(/\s+/g, ""), new RegExp(marker));
      } finally {
        if (splitSurface) {
          try {
            closeSurface(splitSurface);
          } catch {}
        }
        if (baseSurface) {
          try {
            closeSurface(baseSurface);
          } catch {}
        }
      }

      await sleep(150);
      const panes = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], {
        encoding: "utf8",
      });
      if (baseSurface) assert.ok(!panes.includes(baseSurface));
      if (splitSurface) assert.ok(!panes.includes(splitSurface));
    });

    maybeIt("renames the current tmux window and session", () => {
      const paneId = ORIGINAL_ENV.TMUX_PANE!;
      const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
        encoding: "utf8",
      }).trim();
      const sessionId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_id}"], {
        encoding: "utf8",
      }).trim();
      const originalWindowName = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_name}"], {
        encoding: "utf8",
      }).trim();
      const originalSessionName = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_name}"], {
        encoding: "utf8",
      }).trim();

      try {
        process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW = "1";
        renameCurrentTab("Pi Test Window");
        assert.equal(
          execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_name}"], {
            encoding: "utf8",
          }).trim(),
          "Pi Test Window",
        );

        process.env.PI_SUBAGENT_RENAME_TMUX_SESSION = "1";
        renameWorkspace("Pi Test Session");
        assert.equal(
          execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_name}"], {
            encoding: "utf8",
          }).trim(),
          "Pi Test Session",
        );
      } finally {
        execFileSync("tmux", ["rename-window", "-t", windowId, originalWindowName], { encoding: "utf8" });
        execFileSync("tmux", ["rename-session", "-t", sessionId, originalSessionName], { encoding: "utf8" });
      }
    });

    maybeIt("polls until the subagent completion sentinel appears", async () => {
      const surface = createSurface("Pi Test Poll");

      try {
        sendCommand(surface, "sleep 0.1; printf '__SUBAGENT_DONE_7__'");
        const ticks: number[] = [];
        const result = await pollForExit(surface, new AbortController().signal, {
          interval: 50,
          onTick(elapsed) {
            ticks.push(elapsed);
          },
        });

        assert.equal(result.exitCode, 7);
        assert.ok(ticks.length >= 0);
      } finally {
        try {
          closeSurface(surface);
        } catch {}
      }
    });

    maybeIt("aborts polling when the caller aborts", async () => {
      const surface = createSurface("Pi Test Abort");
      const controller = new AbortController();

      try {
        const pending = pollForExit(surface, controller.signal, { interval: 200 });
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(pending, /Aborted/);
      } finally {
        try {
          closeSurface(surface);
        } catch {}
      }
    });
  });

  describe("fake backend integration", () => {
    it("gates tmux window renaming behind PI_SUBAGENT_RENAME_TMUX_WINDOW", () => {
      const dir = createTestDir();
      const logFile = join(dir, "tmux.log");
      writeFileSync(logFile, "");
      writeExecutable(
        dir,
        "tmux",
        `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "$1" = "display-message" ]; then
  if [ "$5" = '#{window_id}' ]; then printf '@1\n';
  elif [ "$5" = '#{session_id}' ]; then printf '$1\n';
  fi
fi
`,
      );

      process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
      process.env.PI_SUBAGENT_MUX = "tmux";
      process.env.TMUX = "fake-tmux-socket";
      process.env.TMUX_PANE = "%1";
      process.env.FAKE_TMUX_LOG = logFile;

      renameCurrentTab("Ignored by default");
      let log = readFileSync(logFile, "utf8");
      assert.doesNotMatch(log, /rename-window/);

      process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW = "1";
      renameCurrentTab("Enabled rename");
      log = readFileSync(logFile, "utf8");
      assert.match(log, /rename-window/);
    });

    it("exercises the cmux backend with a fake cmux binary", async () => {
      const dir = createTestDir();
      const logFile = join(dir, "cmux.log");
      const screenFile = join(dir, "cmux-screen.txt");
      writeFileSync(screenFile, "cmux line 1\ncmux line 2\n");
      writeExecutable(
        dir,
        "cmux",
        `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CMUX_LOG"
case "$1" in
  tree)
    printf 'pane:42\n'
    ;;
  identify)
    printf '{"caller":{"pane_ref":"pane:42"}}\n'
    ;;
  new-split|new-surface)
    printf 'surface:42\n'
    ;;
  read-screen)
    cat "$FAKE_CMUX_SCREEN"
    ;;
esac
`,
      );

      process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
      process.env.PI_SUBAGENT_MUX = "cmux";
      process.env.CMUX_SOCKET_PATH = "/tmp/fake-cmux.sock";
      process.env.CMUX_SURFACE_ID = "surface:99";
      process.env.FAKE_CMUX_LOG = logFile;
      process.env.FAKE_CMUX_SCREEN = screenFile;

      const surface = createSurface("Fake Cmux");
      const secondSurface = createSurface("Fake Cmux 2");
      assert.equal(surface, "surface:42");
      assert.equal(secondSurface, "surface:42");
      renameCurrentTab("Cmux Tab");
      renameWorkspace("Cmux Workspace");
      sendCommand(surface, "echo cmux");
      assert.match(readScreen(surface, 10), /cmux line 1/);
      assert.match(await readScreenAsync(surface, 10), /cmux line 2/);
      closeSurface(surface);
      closeSurface(secondSurface);

      const log = readFileSync(logFile, "utf8");
      assert.match(log, /new-split/);
      assert.match(log, /new-surface/);
      assert.match(log, /rename-tab/);
      assert.match(log, /workspace-action/);
      assert.match(log, /send/);
      assert.match(log, /read-screen/);
      assert.match(log, /close-surface/);
    });

    it("stages long cmux shell commands through a temp script", () => {
      const dir = createTestDir();
      const logFile = join(dir, "cmux-stage.log");
      writeExecutable(
        dir,
        "cmux",
        `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CMUX_LOG"
`,
      );

      process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
      process.env.PI_SUBAGENT_MUX = "cmux";
      process.env.CMUX_SOCKET_PATH = "/tmp/fake-cmux.sock";
      process.env.CMUX_WORKSPACE_ID = "workspace:8";
      process.env.FAKE_CMUX_LOG = logFile;
      process.env.SHELL = "/bin/sh";

      let stagedPath: string | null = null;
      try {
        const longCommand = `FILLER='${"x".repeat(8000)}' pi --session /tmp/session.jsonl @/tmp/prompt.md; echo '__SUBAGENT_DONE_'$?'__'`;
        sendShellCommand("surface:42", longCommand);

        const log = readFileSync(logFile, "utf8");
        assert.match(log, /send --surface surface:42/);
        assert.doesNotMatch(log, /FILLER='x{100}/);
        assert.match(log, /pi-subagent-cmux-/);
        assert.match(log, /rm -f/);

        const pathMatch = log.match(/(\/[^\s']*pi-subagent-cmux-[^\s']+\.(?:sh|fish))/);
        assert.ok(pathMatch);
        stagedPath = pathMatch[1];
        assert.equal(existsSync(stagedPath), true);

        const stagedCommand = readFileSync(stagedPath, "utf8");
        assert.match(stagedCommand, /^#!\/bin\/sh\n/);
        assert.match(stagedCommand, /FILLER='x{100}/);
        assert.match(stagedCommand, /pi --session \/tmp\/session\.jsonl/);
        assert.match(stagedCommand, /__SUBAGENT_DONE_/);
      } finally {
        if (stagedPath && existsSync(stagedPath)) rmSync(stagedPath, { force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exercises the wezterm backend with a fake wezterm binary", async () => {
      const dir = createTestDir();
      const logFile = join(dir, "wezterm.log");
      const screenFile = join(dir, "wezterm-screen.txt");
      writeFileSync(screenFile, "wez line 1\nwez line 2\n");
      writeExecutable(
        dir,
        "wezterm",
        `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_WEZTERM_LOG"
if [ "$1" = "cli" ] && [ "$2" = "split-pane" ]; then
  printf '77\n'
elif [ "$1" = "cli" ] && [ "$2" = "get-text" ]; then
  cat "$FAKE_WEZTERM_SCREEN"
fi
`,
      );

      process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
      process.env.PI_SUBAGENT_MUX = "wezterm";
      process.env.WEZTERM_UNIX_SOCKET = "fake-wezterm-socket";
      process.env.WEZTERM_PANE = "77";
      process.env.FAKE_WEZTERM_LOG = logFile;
      process.env.FAKE_WEZTERM_SCREEN = screenFile;

      const surface = createSurfaceSplit("Fake WezTerm", "up", "42");
      assert.equal(surface, "77");
      renameCurrentTab("WezTerm Tab");
      renameWorkspace("WezTerm Window");
      sendCommand(surface, "echo wezterm");
      assert.match(readScreen(surface, 10), /wez line 1/);
      assert.match(await readScreenAsync(surface, 10), /wez line 2/);
      closeSurface(surface);

      const log = readFileSync(logFile, "utf8");
      assert.match(log, /split-pane --top --cwd/);
      assert.match(log, /set-tab-title/);
      assert.match(log, /set-window-title/);
      assert.match(log, /send-text/);
      assert.match(log, /get-text/);
      assert.match(log, /kill-pane/);
    });

    it("exercises the zellij backend with a fake zellij binary", async () => {
      const dir = createTestDir();
      const logFile = join(dir, "zellij.log");
      const screenFile = join(dir, "zellij-screen.txt");
      writeFileSync(screenFile, "z1\nz2\nz3\nz4\n");
      writeExecutable(
        dir,
        "zellij",
        `#!/bin/sh
printf '%s | pane=%s\n' "$*" "\${ZELLIJ_PANE_ID:-}" >> "$FAKE_ZELLIJ_LOG"
[ "$1" = "action" ] || exit 0
action="$2"
if [ "$action" = "new-pane" ]; then
  printf 'terminal_%s\n' "\${FAKE_ZELLIJ_PANE_ID:-7}"
elif [ "$action" = "write-chars" ]; then
  if [ "$3" = "--pane-id" ]; then
    text="$5"
  else
    text="$3"
  fi
  printf '%s' "$text" > "$FAKE_ZELLIJ_SCREEN"
elif [ "$action" = "dump-screen" ]; then
  cat "$FAKE_ZELLIJ_SCREEN"
fi
`,
      );

      process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
      process.env.PI_SUBAGENT_MUX = "zellij";
      process.env.ZELLIJ_SESSION_NAME = "fake-zellij";
      process.env.FAKE_ZELLIJ_LOG = logFile;
      process.env.FAKE_ZELLIJ_SCREEN = screenFile;
      process.env.FAKE_ZELLIJ_PANE_ID = "7";
      process.env.ZELLIJ_PANE_ID = "3";

      assert.equal(isZellijAvailable(), true);
      const surface = createSurfaceSplit("Fake Zellij", "up", "pane:3");
      assert.equal(surface, "pane:7");
      renameCurrentTab("Zellij Tab");
      renameWorkspace("Ignored for zellij");
      sendCommand(surface, "echo zellij");
      assert.match(readScreen(surface, 1), /echo zellij/);
      assert.match(await readScreenAsync(surface, 1), /echo zellij/);
      closeSurface(surface);

      const log = readFileSync(logFile, "utf8");
      assert.match(log, /new-pane/);
      assert.match(log, /--pane-id 3/);
      assert.match(log, /move-pane --pane-id 7/);
      assert.match(log, /rename-pane --pane-id 7/);
      assert.match(log, /rename-pane --pane-id 3 Zellij Tab/);
      assert.doesNotMatch(log, /write-chars.*echo \"\$ZELLIJ_PANE_ID\"/);
      assert.doesNotMatch(log, /rename-tab/);
      assert.match(log, /dump-screen --pane-id 7/);
      assert.match(log, /close-pane --pane-id 7/);
    });
  });
});
