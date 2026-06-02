import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "./agents/definitions.ts";
import type { AgentListEntry } from "./agents/agent-list.ts";
import {
  getAgentListEntries as getAgentListEntriesFromDefinitions,
  getAgentListSignature,
  renderAgentListReminder,
  renderAgentRosterForSystemPrompt,
} from "./agents/agent-list.ts";
import { loadAgentDefaults as loadAgentDefaultsFromDefinitions } from "./agents/definitions.ts";
import { areSubagentSessionTitlesDisabled } from "./agents/titles.ts";
import { getNoSessionSeedMode } from "./launch/seed-child-session.ts";
import {
  getSubagentAgentOverrideError,
  getSubagentAgentRequirementError,
  resolveSubagentBlocking,
  resolveSubagentNoSession,
} from "./launch/policy.ts";
import { resolveSubagentCwd } from "./launch/runtime-paths.ts";
export { resolveSubagentConfigDir } from "./launch/runtime-paths.ts";
import {
  resolveEffectiveSessionMode as resolveEffectiveSessionModeFromSessionFiles,
  resolveTaskSessionMode as resolveTaskSessionModeFromSessionFiles,
  type SubagentSessionMode,
} from "./session/session-files.ts";
import { isMuxAvailable, muxSetupHint } from "./mux.ts";
import type { SubagentParamsInput } from "./types.ts";
import {
  formatElapsed,
  getLaunchedSubagentResult,
  getShellReadyDelayMs,
  waitForInteractivePrompt,
  getWatcherSignal,
  launchBackgroundSubagent,
  launchSubagent,
  moduleAbortController,
  runningSubagents,
  shutdownSubagentsForParentExit,
  startWidgetRefresh,
  stopRunningSubagent,
  watchBackgroundSubagent,
  watchSubagent,
  widgetManager,
  wireSubagentSteerBack,
} from "./runtime/wiring.ts";
export { getShellReadyDelayMs } from "./runtime/wiring.ts";
import {
  markSubagentBatchBlocking,
  requestSubagentBatchStop,
  resetSubagentBatchStopRequest,
  stopAfterCurrentSubagentBatch,
} from "./runtime/state.ts";
import { classifyAssistantMessageForMixedBatch } from "./runtime/batch-classifier.ts";
import { SUBAGENT_TOOL_NAME } from "./tools/tool-names.ts";
import { registerSubagentCommands } from "./tools/commands.ts";
import { registerSubagentMessageRenderers } from "./tools/message-renderers.ts";
import { registerSubagentResumeTool } from "./tools/resume-tool.ts";
import {
  markInitialPromptLaunchComplete,
  registerSubagentCoreTools,
} from "./tools/subagent-tools.ts";
import { traceSubagentLaunch } from "./launch/trace.ts";
import { registerSubagentsView } from "./tools/subagents-view.ts";

export function loadAgentDefaults(
  agentName: string,
  cwdHint?: string | null,
  baseCwd = process.cwd(),
): AgentDefaults | null {
  return loadAgentDefaultsFromDefinitions(
    agentName,
    cwdHint,
    baseCwd,
    resolveSubagentCwd,
  );
}

function getAgentListEntries(baseCwd = process.cwd()): AgentListEntry[] {
  return getAgentListEntriesFromDefinitions(baseCwd, resolveTaskSessionMode);
}

function resolveEffectiveSessionMode(
  params: Partial<SubagentParamsInput>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return resolveEffectiveSessionModeFromSessionFiles(params, agentDefs);
}

function resolveTaskSessionMode(
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return resolveTaskSessionModeFromSessionFiles(
    agentDefs,
    resolveSubagentNoSession,
    getNoSessionSeedMode,
  );
}

let lastAmbientRosterSignature: string | null = null;
let pendingAmbientRoster: {
  signature: string;
  content: string;
  entries: AgentListEntry[];
  supersedes?: true;
} | null = null;

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
  const text =
    kind === "tab-title"
      ? `Terminal multiplexer not available. ${muxSetupHint()}`
      : `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`;
  return {
    content: [{ type: "text" as const, text }],
    details: { error: "mux not available" },
  };
}

export default function subagentsExtension(pi: ExtensionAPI) {
  function attachWidgetContext(ctx: ExtensionContext) {
    widgetManager.attachContext(ctx);
  }

  function applySubagentLineage(ctx: ExtensionContext) {
    const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION?.trim();
    if (!parentSession) return;
    const header = ctx.sessionManager.getHeader?.();
    if (!header || header.parentSession) return;
    header.parentSession = parentSession;
  }

  function applySubagentSessionTitle(ctx: ExtensionContext) {
    if (areSubagentSessionTitlesDisabled()) return;
    const title = process.env.PI_SUBAGENT_SESSION_TITLE?.trim();
    if (!title) return;
    const header = ctx.sessionManager.getHeader?.() as
      | { name?: string }
      | undefined;
    if (header && header.name !== title) header.name = title;
    if (ctx.sessionManager.getSessionName?.() === title) return;
    pi.setSessionName(title);
  }

  let latestContext: ExtensionContext | undefined;

  // Capture the UI context early so the widget keeps a stable slot above tasks.
  pi.on("session_start", (event, ctx) => {
    latestContext = ctx;
    resetSubagentBatchStopRequest();
    applySubagentLineage(ctx);
    applySubagentSessionTitle(ctx);
    attachWidgetContext(ctx);

    if (!shouldRegister(SUBAGENT_TOOL_NAME)) return;

    // Reset the cached signature on every fresh session so module-level state
    // does not leak between sessions. The reload path still uses the cached
    // signature to avoid duplicating the notification within the same session.
    if (event.reason !== "reload") {
      lastAmbientRosterSignature = null;
    }

    const entries = getAgentListEntries(ctx.cwd);
    const signature = getAgentListSignature(entries);
    if (entries.length === 0) {
      if (event.reason === "reload") pendingAmbientRoster = null;
      lastAmbientRosterSignature = null;
      return;
    }

    if (signature === lastAmbientRosterSignature) {
      pendingAmbientRoster = null;
      return;
    }

    pendingAmbientRoster = {
      signature,
      content: renderAgentListReminder(entries),
      entries,
      supersedes: event.reason === "reload" ? true : undefined,
    };
  });

  pi.on("before_agent_start", (event) => {
    const rosterResult = pendingAmbientRoster
      ? {
          message: {
            customType: "subagent_roster",
            content: pendingAmbientRoster.content,
            display: false,
            details: {
              entries: pendingAmbientRoster.entries,
              signature: pendingAmbientRoster.signature,
              ...(pendingAmbientRoster.supersedes ? { supersedes: true } : {}),
            },
          },
        }
      : undefined;
    if (pendingAmbientRoster) {
      lastAmbientRosterSignature = pendingAmbientRoster.signature;
      pendingAmbientRoster = null;
    }

    // Only append orchestration guidance for the main (top-level) agent.
    // Sub-agents get their own prompts from agent definitions + boundary.
    if (process.env.PI_SUBAGENT_PARENT_SESSION) {
      return rosterResult;
    }

    const rosterBlock = pendingAmbientRoster?.entries?.length
      ? "\n\n" + renderAgentRosterForSystemPrompt(pendingAmbientRoster.entries)
      : "";

    const basePrompt = event.systemPrompt;
    const appendedGuidance = `## Your Role as Orchestrator

You are the primary coordinator. For any work that is non-trivial (multi-file changes, research across the codebase, testing, verification, or anything that benefits from parallel execution), you **must** break it into multiple smaller tasks and delegate those tasks to specialized sub-agents using the subagent tools.

### When to spawn sub-agents
- Break complex work into multiple mini-tasks instead of handing the whole job to one sub-agent
- Launch separate sub-agents for independent subtasks
- If subtasks are independent and won't interfere, spawn them in parallel to finish faster
- You need fresh context or a specialist perspective
- The request requires exploration before implementation
- Verification or testing should be done by a separate agent for objectivity

### When to do the work yourself
- The user asks a simple question or clarification
- A trivial single-file edit or one-off command is sufficient
- You already have complete context from previous sub-agent results and the next step is small
- The overhead of explaining the task would exceed just doing it

### Delegation best practices
- Always write self-contained task descriptions that include exact file paths, relevant line numbers, constraints, and clear success criteria.
- Prefer spawning a fresh sub-agent for implementation work (avoids carrying over broad exploration context).
- Use subagent_resume when a previous sub-agent already explored the relevant files and you want it to continue or fix something.
- When subtasks are independent, launch multiple sub-agents in parallel instead of serializing them.

Never ask a sub-agent to do something you could trivially do in one message. Never do complex multi-step implementation work in the main session.`;

    const augmentedPrompt =
      basePrompt + rosterBlock + "\n\n" + appendedGuidance;

    return {
      ...(rosterResult ?? {}),
      systemPrompt: augmentedPrompt,
    };
  });

  pi.on("input", () => {
    resetSubagentBatchStopRequest();
    return { action: "continue" as const };
  });

  pi.on("message_end", (event) => {
    // Mixed-batch barrier: when an assistant message contains BOTH an async
    // subagent launch (subagent or subagent_resume) AND a non-subagent tool,
    // mark the batch blocking before any tool runs. The shared
    // shouldAwaitSubagentLaunch predicate then routes both subagent and
    // subagent_resume launches through the await path so the parent's
    // next turn sees completed results instead of racing the children.
    // Gated by PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN to share a kill
    // switch with the existing coordinator-only-turn behavior.
    const message = event?.message;
    if (!message) return;
    classifyAssistantMessageForMixedBatch(message, (agent, cwd) =>
      agent ? loadAgentDefaults(agent, cwd) : null,
    );
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== SUBAGENT_TOOL_NAME) return {};
    const input = event.input as Partial<SubagentParamsInput>;
    const agentDefs =
      typeof input.agent === "string"
        ? loadAgentDefaults(
            input.agent,
            typeof input.cwd === "string" ? input.cwd : undefined,
          )
        : null;
    const agentError = getSubagentAgentRequirementError(input, agentDefs);
    const agentOverrideError = getSubagentAgentOverrideError(input, agentDefs);
    if (!agentError && !agentOverrideError) {
      if (resolveSubagentBlocking(input, agentDefs)) {
        markSubagentBatchBlocking();
      } else {
        requestSubagentBatchStop();
      }
    }
    return {};
  });

  pi.on("turn_start", () => {
    resetSubagentBatchStopRequest();
  });

  pi.on("agent_end", () => {
    resetSubagentBatchStopRequest();
    markInitialPromptLaunchComplete();
  });

  // Clean up on real session shutdown. Pi also emits this event for the
  // coordinator-only turn stop after async launches; that must not kill the
  // children that the stop was created to leave running.
  pi.on("session_shutdown", (event, ctx) => {
    traceSubagentLaunch("session.shutdown", {
      coordinatorOnlyTurnStop: stopAfterCurrentSubagentBatch,
      eventKeys: Object.keys(
        (event ?? {}) as unknown as Record<string, unknown>,
      ),
      running: runningSubagents.size,
    });
    if (stopAfterCurrentSubagentBatch) return;

    moduleAbortController.abort();
    widgetManager.reset();
    resetSubagentBatchStopRequest();
    shutdownSubagentsForParentExit();
    if (ctx.hasUI) {
      ctx.ui.setWidget("subagent-status", undefined);
    }
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  registerSubagentCoreTools(pi, shouldRegister, {
    loadAgentDefaults: (agentName, cwd) =>
      agentName ? loadAgentDefaults(agentName, undefined, cwd) : null,
    resolveEffectiveSessionMode,
    resolveTaskSessionMode,
    launchBackgroundSubagent,
    launchSubagent,
    watchBackgroundSubagent,
    watchSubagent,
    getWatcherSignal,
    wireSubagentSteerBack,
    startWidgetRefresh,
    getLaunchedSubagentResult,
    stopRunningSubagent,
    muxUnavailableResult: () => muxUnavailableResult("tab-title"),
  });

  registerSubagentResumeTool(pi, shouldRegister, {
    getShellReadyDelayMs,
    waitForInteractivePrompt,
    isMuxAvailable,
    watchBackgroundSubagent,
    watchSubagent,
    getWatcherSignal,
    wireSubagentSteerBack,
    startWidgetRefresh,
    getLaunchedSubagentResult,
    runningSubagents,
    getContextWindow: (modelRef) =>
      widgetManager.resolveModelContextWindow(modelRef),
    modelRegistry: {
      getAvailable: () => latestContext?.modelRegistry.getAvailable() ?? [],
    },
  });

  registerSubagentCommands(pi, {
    stopRunningSubagent,
  });

  registerSubagentMessageRenderers(pi, formatElapsed);

  registerSubagentsView(pi, {
    getShellReadyDelayMs,
    waitForInteractivePrompt,
    isMuxAvailable,
    watchBackgroundSubagent,
    watchSubagent,
    getWatcherSignal,
    startWidgetRefresh,
    getContextWindow: (modelRef) =>
      widgetManager.resolveModelContextWindow(modelRef),
    runningSubagents,
    pi,
    wireSubagentSteerBack,
  });
}
