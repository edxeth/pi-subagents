import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SubagentWidgetManager } from "../../src/subagents/widget.ts";
import type { RunningSubagent } from "../../src/subagents/runtime-types.ts";

describe("widget manager direct module tests", () => {
  it("renders nothing when no subagents are running", () => {
    const widget = new SubagentWidgetManager(() => []);
    assert.deepEqual(widget.renderForTest(), []);
  });

  it("renders the updated agent summary layout", () => {
    const running: RunningSubagent = {
      id: "child-1",
      name: "Research",
      agent: "researcher",
      task: "Inspect the auth module for session handling",
      mode: "background",
      executionState: "running",
      deliveryState: "detached",
      parentClosePolicy: "terminate",
      blocking: false,
      startTime: Date.now() - 1500,
      sessionFile: "/tmp/child-1.jsonl",
      messageCount: 3,
      toolUses: 1,
      pendingToolCount: 1,
      activity: "reading auth module",
      taskPreview: "Inspect the auth module for session handling",
    };

    const widget = new SubagentWidgetManager(() => [running]);
    const lines = widget.renderForTest(120).join("\n");

    assert.match(lines, /Agents 1\/1 running · 1\.5s/);
    assert.match(lines, /Research \[researcher\]/);
    assert.match(lines, /1 tool use/);
    assert.doesNotMatch(lines, /3 messages/);
    assert.match(lines, /Inspect the auth module for session handling/);
    assert.match(lines, /reading auth module/);
    assert.doesNotMatch(lines, /\[detached\]/);
  });

  it("uses native totalTokens and caps ctx at 100%", () => {
    const dir = mkdtempSync(join(tmpdir(), "widget-test-"));
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "anthropic/test-model",
          usage: { totalTokens: 150, input: 120, output: 40 },
          content: [{ type: "text", text: "Done" }],
        },
      })}\n`,
    );

    const running: RunningSubagent = {
      id: "child-ctx",
      name: "Ctx",
      agent: "researcher",
      task: "Check usage",
      mode: "background",
      executionState: "running",
      deliveryState: "detached",
      parentClosePolicy: "terminate",
      blocking: false,
      startTime: Date.now(),
      sessionFile,
      modelContextWindow: 100,
    };

    const widget = new SubagentWidgetManager(() => [running]);
    (widget as any).refreshRunningSubagentState(running);

    assert.equal(running.contextLabel, "100.0%/100 ctx");
  });
});
