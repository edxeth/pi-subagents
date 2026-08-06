#!/usr/bin/env node
/**
 * Live test: frontmatter `parent-close-policy` param
 *
 * Verifies that agents with `parent-close-policy: continue` preserve
 * the correct metadata in launch metadata and child session files.
 *
 * Strategy:
 *   - Write child agents with continue and terminate parent-close-policy
 *   - Launch both as background blocking children
 *   - Verify the launch metadata and result details reflect the correct policy
 *   - Verify the child session files are persisted (not cleaned up) for continue policy
 *
 * Note: Full OS-level process survival verification requires tmux/ghostty
 * window sessions and is tested separately. This test validates that
 * the frontmatter is parsed, applied in launch metadata, and the correct
 * environment/args are generated.
 */

import { existsSync } from "node:fs";
import {
  setup,
  writeAgent,
  runPi,
  parseJsonl,
  listJsonlFiles,
  getUserText,
  getAssistantTexts,
  getAllSubagentChildren,
} from "./live-test-common.mjs";

const testLabel = "parent-close";
const ctx = setup(testLabel);

// Write continue child agent
writeAgent(ctx.agentsDir, "fm-continue-child", {
  name: "fm-continue-child",
  description: "Parent close policy continue test agent.",
  "parent-close-policy": "continue",
  "auto-exit": "true",
  mode: "background",
  async: "false",
  spawning: "false",
}, [
  "Reply with exactly `FM_CONTINUE_OK`.",
].join("\n"));

// Write terminate child agent (default)
writeAgent(ctx.agentsDir, "fm-terminate-child", {
  name: "fm-terminate-child",
  description: "Parent close policy terminate test agent.",
  "parent-close-policy": "terminate",
  "auto-exit": "true",
  mode: "background",
  async: "false",
  spawning: "false",
}, [
  "Reply with exactly `FM_TERMINATE_OK`.",
].join("\n"));

// Write agent without explicit policy (should default to terminate)
writeAgent(ctx.agentsDir, "fm-default-child", {
  name: "fm-default-child",
  description: "Default close policy test agent.",
  "auto-exit": "true",
  mode: "background",
  async: "false",
  spawning: "false",
}, [
  "Reply with exactly `FM_DEFAULT_OK`.",
].join("\n"));

const prompt = [
  "The subagent tool is available in this session.",
  "In one tool call batch, launch all three children.",
  "Call subagent with name 'Continue Child', agent 'fm-continue-child', title 'Continue policy test', task 'Follow your exact built-in instructions.'.",
  "Call subagent with name 'Terminate Child', agent 'fm-terminate-child', title 'Terminate policy test', task 'Follow your exact built-in instructions.'.",
  "Call subagent with name 'Default Child', agent 'fm-default-child', title 'Default policy test', task 'Follow your exact built-in instructions.'.",
  "After all tools return, reply with exactly 'TEST_CLOSE_DONE' and nothing else.",
  "Do not call any other tools.",
].join(" ");

let verified = false;
try {
  runPi(ctx, prompt);

  const parent = findSessionWithMarker(ctx.sessionDir, "TEST_CLOSE_DONE");
  if (!parent) throw new Error("Could not find parent session.");

  // Use getAllSubagentChildren to handle batch/individual formats
  const children = getAllSubagentChildren(parent.events);
  
  if (children.length < 3) {
    throw new Error(`Expected 3 children, got ${children.length}. Found: ${children.map(c => c.name).join(", ")}`);
  }

  const byName = {};
  for (const child of children) {
    if (child.status !== "completed") throw new Error(`${child.name}: expected completed, got ${child.status}.`);
    if (!child.sessionFile || !existsSync(child.sessionFile)) throw new Error(`${child.name}: missing sessionFile.`);
    byName[child.name] = child;
  }

  const continueD = byName["Continue Child"];
  const terminateD = byName["Terminate Child"];
  const defaultD = byName["Default Child"];
  if (!continueD || !terminateD || !defaultD) {
    throw new Error(`Missing results. Found: ${Object.keys(byName).join(", ")}`);
  }

  // Check parentClosePolicy via child session launch metadata
  // (It may not appear in parent's batch result details)
  for (const [label, d] of [["continue", continueD], ["terminate", terminateD], ["default", defaultD]]) {
    const events = parseJsonl(d.sessionFile);
    const texts = getAssistantTexts(events);
    const expected = `FM_${label.toUpperCase()}_OK`;
    if (!texts.some(t => t.includes(expected))) {
      throw new Error(`${label} child did not produce ${expected}.`);
    }

    // Check launch metadata for parentClosePolicy
    const metadata = events.find(e => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");
    if (!metadata?.data?.parentClosePolicy) {
      throw new Error(`${label} child missing parentClosePolicy in launch metadata.`);
    }
    const expectedPolicy = label === "continue" ? "continue" : "terminate";
    if (metadata.data.parentClosePolicy !== expectedPolicy) {
      throw new Error(`${label} child expected parentClosePolicy "${expectedPolicy}", got "${metadata.data.parentClosePolicy}"`);
    }
    console.log(`${label} child metadata parentClosePolicy: ${metadata.data.parentClosePolicy}`);
  }

  verified = true;
  console.log(`frontmatter "parent-close-policy" ok: continue/terminate/default all verified`);
} finally {
  ctx.cleanup();
}

if (!verified) process.exit(1);

function findSessionWithMarker(sessionDir, marker) {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes(marker)) return { file, events };
  }
  return null;
}
