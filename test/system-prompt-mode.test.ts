import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const get = (key: string) => {
    const frontmatterMatch = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return frontmatterMatch ? frontmatterMatch[1].trim() : undefined;
  };
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = get("system-prompt");
  return {
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    body: body || undefined,
  };
}

function simulateRouting(
  agentBody: string | undefined,
  systemPromptMode: "append" | "replace" | undefined,
  paramSystemPrompt: string | undefined,
) {
  const identity = agentBody ?? paramSystemPrompt ?? null;
  const identityInSystemPrompt = !!(systemPromptMode && identity);
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";

  let cliFlag: string | null = null;
  if (identityInSystemPrompt && identity) {
    cliFlag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
  }

  return { roleBlock, cliFlag, identityInSystemPrompt };
}

const AGENT_REPLACE = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: replace
auto-exit: true
---

You are a specialized agent.`;

const AGENT_APPEND = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: append
---

You are an appended identity.`;

const AGENT_DEFAULT = `---
model: anthropic/claude-sonnet-4-20250514
---

You are a default agent.`;

const AGENT_INVALID = `---
model: anthropic/claude-sonnet-4-20250514
system-prompt: foobar
---

Body here.`;

describe("system-prompt mode", () => {
  it("parses frontmatter modes correctly", () => {
    const replace = parseFrontmatter(AGENT_REPLACE);
    assert.deepEqual(replace, {
      systemPromptMode: "replace",
      body: "You are a specialized agent.",
    });

    assert.equal(parseFrontmatter(AGENT_APPEND)?.systemPromptMode, "append");
    assert.equal(parseFrontmatter(AGENT_DEFAULT)?.systemPromptMode, undefined);
    assert.equal(parseFrontmatter(AGENT_INVALID)?.systemPromptMode, undefined);
  });

  it("routes identity into CLI flags only when configured", () => {
    assert.deepEqual(simulateRouting("You are X.", "replace", undefined), {
      roleBlock: "",
      cliFlag: "--system-prompt",
      identityInSystemPrompt: true,
    });

    assert.deepEqual(simulateRouting("You are X.", "append", undefined), {
      roleBlock: "",
      cliFlag: "--append-system-prompt",
      identityInSystemPrompt: true,
    });

    assert.deepEqual(simulateRouting("You are X.", undefined, undefined), {
      roleBlock: "\n\nYou are X.",
      cliFlag: null,
      identityInSystemPrompt: false,
    });

    assert.deepEqual(simulateRouting(undefined, undefined, undefined), {
      roleBlock: "",
      cliFlag: null,
      identityInSystemPrompt: false,
    });

    assert.deepEqual(simulateRouting(undefined, "replace", undefined), {
      roleBlock: "",
      cliFlag: null,
      identityInSystemPrompt: false,
    });

    assert.deepEqual(simulateRouting(undefined, "replace", "Param identity"), {
      roleBlock: "",
      cliFlag: "--system-prompt",
      identityInSystemPrompt: true,
    });
  });

  it("loads agent files from disk with the same parsing rules", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-test-spm-"));
    const agentsDir = join(tmpDir, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });

    try {
      writeFileSync(join(agentsDir, "test-replace.md"), AGENT_REPLACE);
      writeFileSync(join(agentsDir, "test-append.md"), AGENT_APPEND);
      writeFileSync(join(agentsDir, "test-default.md"), AGENT_DEFAULT);

      const loadFromDir = (name: string) => {
        const path = join(agentsDir, `${name}.md`);
        if (!existsSync(path)) return null;
        return parseFrontmatter(readFileSync(path, "utf8"));
      };

      assert.deepEqual(loadFromDir("test-replace"), {
        systemPromptMode: "replace",
        body: "You are a specialized agent.",
      });
      assert.equal(loadFromDir("test-append")?.systemPromptMode, "append");
      assert.equal(loadFromDir("test-default")?.systemPromptMode, undefined);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
