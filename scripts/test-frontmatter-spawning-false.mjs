#!/usr/bin/env node
/**
 * Live test: frontmatter `spawning: false` (default) param
 *
 * Verifies that `spawning: false` (the default) blocks subagent and related
 * tools from the child.
 *
 * Strategy:
 *   - Write a child agent without `spawning` (defaults to false)
 *   - Child tries to call subagent, should fail because the tool is denied
 *   - Child reports whether subagent was available using check_tool_available
 *     from the snapshot extension
 *   - Parent verifies subagent tool was denied
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  setup,
  writeAgent,
  writeSnapshotExtension,
  runPi,
  parseJsonl,
  listJsonlFiles,
  getUserText,
  getAssistantTexts,
  getToolResults,
} from "./live-test-common.mjs";

async function main() {
  const testLabel = "spawning-false";
  const ctx = setup(testLabel);

  const extFile = join(ctx.extensionsDir, "spawn-snapshot.ts");
  writeSnapshotExtension(extFile, ctx.snapshotsDir);

  // Write a child with spawning: false explicitly (the default)
  writeAgent(ctx.agentsDir, "fm-nospawn-child", {
    name: "fm-nospawn-child",
    description: "Spawning false test agent.",
    "auto-exit": "true",
    mode: "background",
    async: "false",
    spawning: "false",
    tools: "bash",
    extensions: extFile,
  }, [
    "Use the check_tool_available tool to check if 'subagent' is available.",
    "Then reply with exactly `FM_NOSPAWN_OK`.",
    "Do NOT try to call subagent - just check if it's available.",
  ].join("\n"));

  const prompt = [
    "The subagent tool is available in this session.",
    "Call subagent with name 'FM NoSpawn Child', agent 'fm-nospawn-child', title 'Spawning false verification', task 'Follow your exact built-in instructions.'.",
    "After the tool returns, reply with exactly 'TEST_NOSPAWN_DONE' and nothing else.",
    "Do not call any other tools.",
  ].join(" ");

  let verified = false;
  try {
    runPi(ctx, prompt);

  const parent = findSessionWithMarker(ctx.sessionDir, "TEST_NOSPAWN_DONE");
  if (!parent) throw new Error("Could not find parent session.");

  const subagentResults = getToolResults(parent.events, "subagent");
  if (subagentResults.length !== 1) {
    throw new Error(`Expected 1 subagent result, got ${subagentResults.length}.`);
  }

  const details = subagentResults[0].details ?? {};
  if (details.status !== "completed") {
    throw new Error(`Expected completed, got ${details.status}.`);
  }
  if (!details.sessionFile || !existsSync(details.sessionFile)) {
    throw new Error("Missing child sessionFile.");
  }

  // Verify child completed
  const childEvents = parseJsonl(details.sessionFile);
  const childTexts = getAssistantTexts(childEvents);
  if (!childTexts.some(t => t.includes("FM_NOSPAWN_OK"))) {
    throw new Error(`Child did not produce FM_NOSPAWN_OK. Texts: ${JSON.stringify(childTexts)}`);
  }

  // Must verify subagent denial via check_tool_available or snapshot
  const { readdirSync } = await import("node:fs");
  let foundDenied = false;

  // First check check_tool_available results
  const childToolResults = getToolResults(childEvents, "check_tool_available");
  const subagentCheck = childToolResults.find(r => r.details?.toolName === "subagent");
  if (subagentCheck) {
    if (subagentCheck.details?.available !== false) {
      throw new Error("subagent tool should be denied for spawning:false, but check_tool_available reports it as available.");
    }
    foundDenied = true;
    console.log("check_tool_available confirms subagent is denied.");
  } else {
    // Fallback: check snapshot
    try {
      const snapshotFiles = readdirSync(ctx.snapshotsDir)
        .filter(f => f.endsWith(".json"))
        .map(f => join(ctx.snapshotsDir, f));
      for (const file of snapshotFiles) {
        const data = JSON.parse(readFileSync(file, "utf8"));
        const active = data.active ?? [];
        if (!active.includes("subagent") && !active.includes("subagent_resume") && !active.includes("subagents_list")) {
          foundDenied = true;
          break;
        }
      }
    } catch {}
  }

  if (!foundDenied) {
    throw new Error("Could not verify subagent tools are denied. No check_tool_available result or snapshot evidence found.");
  }

  verified = true;
  console.log(`frontmatter ` + "`spawning: false`" + ` ok: child completed without subagent tool (${details.id})`);
  } finally {
    ctx.cleanup();
  }

  if (!verified) process.exit(1);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

function findSessionWithMarker(sessionDir, marker) {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes(marker)) return { file, events };
  }
  return null;
}
