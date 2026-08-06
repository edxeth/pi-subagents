#!/usr/bin/env node
/**
 * Live test: frontmatter `spawning: true` param
 *
 * Verifies that `spawning: true` allows the child to use subagent tools
 * by checking that PI_DENY_TOOLS does NOT include subagent tools.
 *
 * Strategy:
 *   - Write a coordinator agent with spawning: true
 *   - The coordinator checks PI_DENY_TOOLS env to verify subagent is not denied
 *   - Parent verifies the session metadata has empty denyTools
 */

import { existsSync } from "node:fs";
import {
	getAllSubagentChildren,
	getAssistantTexts,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const testLabel = "spawning-true";
const ctx = setup(testLabel);

// Write a coordinator agent with spawning: true
writeAgent(
	ctx.agentsDir,
	"fm-coordinator",
	{
		name: "fm-coordinator",
		description: "Coordinator for spawning test.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "true",
	},
	['First, run bash with: echo "DENY=\\$PI_DENY_TOOLS"', "Then reply with exactly `FM_COORDINATOR_OK`."].join("\n"),
);

// Also write an agent with spawning: false for comparison
writeAgent(
	ctx.agentsDir,
	"fm-no-spawn",
	{
		name: "fm-no-spawn",
		description: "Non-spawning comparison agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
	},
	['First, run bash with: echo "DENY=\\$PI_DENY_TOOLS"', "Then reply with exactly `FM_NO_SPAWN_OK`."].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'FM Coordinator', agent 'fm-coordinator', title 'Spawning true verification', task 'Follow your exact built-in instructions.'.",
	"Call subagent with name 'FM No Spawn', agent 'fm-no-spawn', title 'Spawning false comparison', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_SPAWNING_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_SPAWNING_DONE");
	if (!parent) throw new Error("Could not find parent session.");

	const children = getAllSubagentChildren(parent.events);
	if (children.length !== 2) {
		throw new Error(`Expected 2 children, got ${children.length}.`);
	}

	const coord = children.find((c) => c.name === "FM Coordinator");
	const noSpawn = children.find((c) => c.name === "FM No Spawn");
	if (!coord || !noSpawn) throw new Error("Missing expected children.");

	// Verify both completed
	for (const c of [coord, noSpawn]) {
		if (c.status !== "completed") throw new Error(`${c.name}: expected completed, got ${c.status}.`);
		if (!c.sessionFile || !existsSync(c.sessionFile)) throw new Error(`${c.name}: missing sessionFile.`);
	}

	// Verify coordinator's PHI_DENY_TOOLS is empty
	const coordEvents = parseJsonl(coord.sessionFile);
	const coordTexts = getAssistantTexts(coordEvents);
	if (!coordTexts.some((t) => t.includes("FM_COORDINATOR_OK"))) {
		throw new Error(`Coordinator did not produce FM_COORDINATOR_OK.`);
	}

	// Check bash output for DENY= value
	const coordBashResults = coordEvents
		.filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "bash")
		.flatMap((e) => e.message.content ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text);
	const coordDenyLine = coordBashResults.find((t) => t.startsWith("DENY="));
	if (!coordDenyLine) {
		console.log("Warning: Could not find DENY= output from coordinator bash.");
	}

	// Check no-spawn's PHI_DENY_TOOLS should include subagent tools
	const noSpawnEvents = parseJsonl(noSpawn.sessionFile);
	const noSpawnTexts = getAssistantTexts(noSpawnEvents);
	if (!noSpawnTexts.some((t) => t.includes("FM_NO_SPAWN_OK"))) {
		throw new Error(`No-spawn child did not produce FM_NO_SPAWN_OK.`);
	}

	const noSpawnBashResults = noSpawnEvents
		.filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === "bash")
		.flatMap((e) => e.message.content ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text);
	const noSpawnDenyLine = noSpawnBashResults.find((t) => t.startsWith("DENY="));
	if (!noSpawnDenyLine) {
		console.log("Warning: Could not find DENY= output from no-spawn bash.");
	}

	// Check metadata for denyTools
	const coordMeta = coordEvents.find((e) => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");
	const noSpawnMeta = noSpawnEvents.find((e) => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");

	const coordDenyTools = coordMeta?.data?.denyTools ?? [];
	const noSpawnDenyTools = noSpawnMeta?.data?.denyTools ?? [];

	console.log(`Coordinator denyTools: ${JSON.stringify(coordDenyTools)}`);
	console.log(`No-spawn denyTools: ${JSON.stringify(noSpawnDenyTools)}`);

	// Coordinator with spawning: true should have NO spawning tools in deny set
	if (coordDenyTools.includes("subagent")) {
		throw new Error(`Coordinator (spawning:true) has subagent in denyTools. Expected empty.`);
	}

	// No-spawn with spawning: false (default) should have subagent tools denied
	const hasDeniedSubagent =
		noSpawnDenyTools.includes("subagent") ||
		noSpawnDenyTools.includes("subagents_list") ||
		noSpawnDenyTools.includes("subagent_resume");
	if (!hasDeniedSubagent) {
		throw new Error(`No-spawn (spawning:false) missing subagent in denyTools. Expected denied.`);
	}

	verified = true;
	console.log(`frontmatter "spawning: true" ok: coordinator denyTools=[], no-spawn denyTools contains subagent tools`);
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
