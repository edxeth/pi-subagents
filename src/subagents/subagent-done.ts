/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { shouldAutoExitOnAgentEnd, shouldMarkUserTookOver } from "./auto-exit.ts";

const require = createRequire(import.meta.url);

function isMissingOptionalDependency(error: unknown, id: string): boolean {
  if (!(error instanceof Error)) return false;
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError.code === "MODULE_NOT_FOUND" && error.message.includes(`'${id}'`);
}

function optionalRequire(id: string): unknown | null {
  try {
    return require(id);
  } catch (error) {
    if (isMissingOptionalDependency(error, id)) {
      return null;
    }
    throw error;
  }
}

export { shouldAutoExitOnAgentEnd, shouldMarkUserTookOver };

export function getDeniedToolNames(autoExit: boolean, deniedEnv = process.env.PI_DENY_TOOLS ?? ""): string[] {
  const denied = deniedEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (autoExit && !denied.includes("subagent_done")) {
    denied.push("subagent_done");
  }
  return denied;
}

export function filterToolNames(toolNames: string[], deniedTools: string[]): string[] {
  const denied = new Set(deniedTools);
  const seen = new Set<string>();
  return toolNames.filter((name) => {
    if (!name || denied.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function shouldRegisterSubagentDone(autoExit: boolean, deniedTools: string[]): boolean {
  return !autoExit && !deniedTools.includes("subagent_done");
}

type ToolControlAPI = Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool">;

type WidgetThemeLike = {
  bg(tone: string, text: string): string;
  bold(text: string): string;
  fg(tone: string, text: string): string;
};

export function installDeniedToolGuards(
  pi: ToolControlAPI,
  autoExit: boolean,
  onChange?: (activeTools: string[], deniedTools: string[]) => void,
) {
  const originalRegisterTool = pi.registerTool.bind(pi);
  const originalSetActiveTools = pi.setActiveTools.bind(pi);

  const notify = (activeTools: string[], deniedTools: string[]) => {
    onChange?.([...activeTools].sort(), [...deniedTools]);
  };

  const applyDeniedTools = (): string[] => {
    const deniedTools = getDeniedToolNames(autoExit);
    const allowedTools = filterToolNames(
      pi.getAllTools().map((tool) => tool.name),
      deniedTools,
    );
    originalSetActiveTools(allowedTools);
    notify(allowedTools, deniedTools);
    return allowedTools;
  };

  pi.setActiveTools = (toolNames: string[]) => {
    const deniedTools = getDeniedToolNames(autoExit);
    const allowedTools = filterToolNames(toolNames, deniedTools);
    originalSetActiveTools(allowedTools);
    notify(allowedTools, deniedTools);
  };

  pi.registerTool = (definition) => {
    const result = originalRegisterTool(definition);
    applyDeniedTools();
    return result;
  };

  return { applyDeniedTools };
}

export default function (pi: ExtensionAPI) {
  const tui = optionalRequire("@mariozechner/pi-tui");
  const typebox = optionalRequire("@sinclair/typebox");
  const Box = tui?.Box;
  const Text = tui?.Text;
  const doneParams = typebox?.Type?.Object
    ? typebox.Type.Object({})
    : { type: "object", properties: {}, additionalProperties: false };
  const callerPingParams = typebox?.Type?.Object
    ? typebox.Type.Object({
        message: typebox.Type.String({ description: "What you need help with" }),
      })
    : {
        type: "object",
        properties: {
          message: { type: "string", description: "What you need help with" },
        },
        required: ["message"],
        additionalProperties: false,
      };

  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  let toolNames: string[] = [];
  let denied: string[] = getDeniedToolNames(autoExit);
  let expanded = false;
  let latestCtx: { ui: { setWidget: Function } } | null = null;
  let outputTokens = 0;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: unknown) {
    if (!Box || !Text) return;
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: unknown, theme: WidgetThemeLike) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  function requestShutdown(ctx: { shutdown: () => void }) {
    setTimeout(() => ctx.shutdown(), 0);
  }

  function writeExitSignal(payload: object) {
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    const exitFile = `${sessionFile}.exit`;
    if (existsSync(exitFile)) return;
    writeFileSync(exitFile, JSON.stringify(payload), "utf8");
  }

  function refreshDeniedTools(ctx?: { ui: { setWidget: Function } } | null) {
    if (ctx) latestCtx = ctx;
    denied = getDeniedToolNames(autoExit);
    toolNames = filterToolNames(
      pi.getAllTools().map((tool) => tool.name),
      denied,
    );
    try {
      pi.setActiveTools(toolNames);
    } catch {}
    if (latestCtx) renderWidget(latestCtx, null);
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    refreshDeniedTools(ctx);
    setTimeout(() => refreshDeniedTools(), 0);
    setTimeout(() => refreshDeniedTools(), 250);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    refreshDeniedTools(ctx);
    return undefined;
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; usage?: { output?: number } };
    if (message.role !== "assistant" || !message.usage) return;
    outputTokens += message.usage.output ?? 0;
  });

  // Auto-exit: when the agent loop ends, shut down automatically.
  // If the user interrupts (Escape) or sends any input, auto-exit is disabled
  // for that cycle — the user wants to steer. Once they're done and the agent
  // completes normally again, auto-exit re-engages.
  // Enabled via `auto-exit: true` in agent frontmatter.
  if (autoExit) {
    pi.on("session_shutdown", () => {
      writeExitSignal({ type: "done", outputTokens });
    });

    let userTookOver = false;
    let agentStarted = false;

    pi.on("agent_start", () => {
      agentStarted = true;
    });

    pi.on("input", () => {
      // Ignore the initial task message that starts an autonomous subagent.
      // Only inputs after the first agent run has started count as user takeover.
      if (!shouldMarkUserTookOver(agentStarted)) return;
      userTookOver = true;
    });

    pi.on("agent_end", (event, ctx) => {
      const messages = event.messages as Parameters<typeof shouldAutoExitOnAgentEnd>[1];
      const shouldExit = shouldAutoExitOnAgentEnd(userTookOver, messages);
      if (!shouldExit) {
        // User sent input after the agent had started, or the run was interrupted
        // with Escape. Reset takeover so auto-exit can re-engage on the next
        // normal completion cycle.
        userTookOver = false;
        return;
      }

      writeExitSignal({ type: "done", outputTokens });
      requestShutdown(ctx);
    });
  }

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified and can resume this session with a response.",
    parameters: callerPingParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      writeExitSignal({
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
        outputTokens,
      });
      requestShutdown(ctx);
      return {
        content: [{ type: "text", text: "Ping sent. Parent will be notified." }],
        details: {},
      };
    },
  });

  if (shouldRegisterSubagentDone(autoExit, denied)) {
    pi.registerTool({
      name: "subagent_done",
      label: "Subagent Done",
      description:
        "Call this tool when you have completed your task. " +
        "It will close this session and return your results to the main session. " +
        "Your LAST assistant message before calling this becomes the summary returned to the caller.",
      parameters: doneParams,
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        writeExitSignal({ type: "done", outputTokens });
        requestShutdown(ctx);
        return {
          content: [{ type: "text", text: "Shutting down subagent session." }],
          details: {},
        };
      },
    });
  }
}
