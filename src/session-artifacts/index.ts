import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { highlightCode, getLanguageFromPath, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getProjectArtifactsDir,
  getSessionArtifactDir,
  resolveSessionArtifactPath,
} from "../shared/artifacts.ts";

const PREVIEW_LINES = 10;

interface WriteArtifactDetails {
  path?: string;
  name?: string;
  sessionId?: string;
}

interface ReadArtifactDetails extends WriteArtifactDetails {
  content?: string;
}

function isSpawnedSubagentSession() {
  return Boolean(
    process.env.PI_SUBAGENT_NAME?.trim() || process.env.PI_SUBAGENT_AGENT?.trim(),
  );
}

export default function (pi: ExtensionAPI) {
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const shouldRegister = (name: string) => !deniedTools.has(name);
  const canWriteArtifacts = isSpawnedSubagentSession();

  if (canWriteArtifacts && shouldRegister("write_artifact"))
    pi.registerTool({
      name: "write_artifact",
    label: "Write Artifact",
    description:
      "Write a session-scoped artifact file (context, research, notes, reviews, etc.). " +
      "Files are stored under ~/.pi/history/<project>/artifacts/<session-id>/. " +
      "Use this instead of writing pi working files directly.",
    promptSnippet:
      "Write a session-scoped artifact file (context, research, notes, reviews, etc.). " +
      "Files are stored under ~/.pi/history/<project>/artifacts/<session-id>/. " +
      "Use this instead of writing pi working files directly.",
    promptGuidelines: [
      "Use write_artifact for any pi working file: context, research notes, reviews, or other session artifacts.",
      "The name param can include subdirectories (e.g. 'context/auth-flow.md').",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Filename, e.g. 'notes.md' or 'context/auth-flow.md'" }),
      content: Type.String({ description: "File content" }),
    }),

    renderCall(args, theme) {
      const name = args.name ?? "...";
      const content = args.content ?? "";

      let text =
        theme.fg("toolTitle", theme.bold("write_artifact")) + " " + theme.fg("accent", name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        // During streaming, show preview
        const displayLines = lines.slice(0, PREVIEW_LINES);
        const remaining = totalLines - PREVIEW_LINES;

        text +=
          "\n\n" +
          displayLines
            .map((line: string) => (lang ? line : theme.fg("toolOutput", line)))
            .join("\n");

        if (remaining > 0) {
          text += theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as WriteArtifactDetails | undefined;
      const text =
        theme.fg("success", "✓") +
        " " +
        theme.fg("accent", details?.path ?? details?.name ?? "artifact");
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = getSessionArtifactDir(ctx.cwd, sessionId);
      const filePath = resolveSessionArtifactPath(ctx.cwd, sessionId, params.name);

      // Safety: ensure we're not escaping the artifact directory
      if (!filePath.startsWith(artifactDir)) {
        throw new Error(`Path escapes artifact directory: ${params.name}`);
      }

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, params.content, "utf-8");

      return {
        content: [{ type: "text", text: `Artifact written to: ${filePath}` }],
        details: { path: filePath, name: params.name, sessionId },
      };
    },
  });

  /**
   * Find an artifact by name across all session artifact directories for the current project.
   * Searches current session first, then other sessions (most recently modified first).
   */
  function findArtifact(
    projectArtifactsDir: string,
    currentSessionId: string,
    name: string,
  ): string | null {
    // 1. Check current session first
    const currentPath = resolve(join(projectArtifactsDir, currentSessionId), name);
    if (existsSync(currentPath)) return currentPath;

    // 2. Search other session directories, sorted by mtime (newest first)
    if (!existsSync(projectArtifactsDir)) return null;

    const sessionDirs = readdirSync(projectArtifactsDir)
      .filter((d) => d !== currentSessionId)
      .map((d) => {
        const fullPath = join(projectArtifactsDir, d);
        try {
          const stat = statSync(fullPath);
          return stat.isDirectory() ? { dir: d, mtime: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is { dir: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);

    for (const { dir } of sessionDirs) {
      const candidate = resolve(join(projectArtifactsDir, dir), name);
      if (existsSync(candidate)) return candidate;
    }

    return null;
  }

  if (shouldRegister("read_artifact"))
    pi.registerTool({
      name: "read_artifact",
    label: "Read Artifact",
    description:
      "Read a session-scoped artifact file by name (e.g. 'notes/todo.md', 'context/auth.md'). " +
      "Searches the current session first, then other sessions for the same project. " +
      "Use this to read artifacts written by sub-agents or previous sessions.",
    promptSnippet:
      "Read a session-scoped artifact file by name (e.g. 'notes/todo.md', 'context/auth.md'). " +
      "Searches the current session first, then other sessions for the same project. " +
      "Use this to read artifacts written by sub-agents or previous sessions.",
    promptGuidelines: [
      "Use read_artifact to read files written by write_artifact — especially artifacts from sub-agents.",
      "The name param should match what was passed to write_artifact (e.g. 'notes/2026-03-16-fullstack-counter.md').",
      "When a sub-agent reports it wrote an artifact, use read_artifact to access it — don't use the read tool or bash.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Artifact name, e.g. 'notes.md' or 'notes/2026-03-16-fullstack-counter.md'",
      }),
    }),

    renderCall(args, theme) {
      const name = args.name ?? "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("read_artifact")) + " " + theme.fg("accent", name),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as ReadArtifactDetails | undefined;
      const name = details?.name ?? "artifact";
      const content = details?.content ?? "";

      let text = theme.fg("success", "✓") + " " + theme.fg("accent", details?.path ?? name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        const maxLines = expanded ? lines.length : PREVIEW_LINES;
        const displayLines = lines.slice(0, maxLines);
        const remaining = totalLines - maxLines;

        text +=
          "\n\n" +
          displayLines
            .map((line: string) => (lang ? line : theme.fg("toolOutput", line)))
            .join("\n");

        if (remaining > 0) {
          text +=
            theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
            ` ${keyHint("app.tools.expand", "to expand")})`;
        }
      }

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const projectArtifactsDir = getProjectArtifactsDir(ctx.cwd);

      const found = findArtifact(projectArtifactsDir, sessionId, params.name);

      if (!found) {
        // List available artifacts to help the agent
        const available: string[] = [];
        if (existsSync(projectArtifactsDir)) {
          const collectArtifacts = (dir: string, prefix: string) => {
            try {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                  collectArtifacts(
                    join(dir, entry.name),
                    prefix ? `${prefix}/${entry.name}` : entry.name,
                  );
                } else {
                  available.push(prefix ? `${prefix}/${entry.name}` : entry.name);
                }
              }
            } catch {}
          };
          for (const sessionDir of readdirSync(projectArtifactsDir)) {
            const fullPath = join(projectArtifactsDir, sessionDir);
            try {
              if (statSync(fullPath).isDirectory()) {
                collectArtifacts(fullPath, "");
              }
            } catch {}
          }
        }

        const uniqueNames = [...new Set(available)].sort((a, b) => a.localeCompare(b));
        let msg = `Artifact not found: ${params.name}`;
        if (uniqueNames.length > 0) {
          msg += `\n\nAvailable artifacts:\n${uniqueNames.map((n) => `  - ${n}`).join("\n")}`;
        }

        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }

      // Safety: ensure we're not escaping the artifacts directory
      if (!found.startsWith(projectArtifactsDir)) {
        throw new Error(`Path escapes artifact directory: ${params.name}`);
      }

      const content = readFileSync(found, "utf-8");

      return {
        content: [{ type: "text", text: content }],
        details: { path: found, name: params.name, sessionId, content },
      };
    },
  });
}
