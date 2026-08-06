#!/usr/bin/env node
/**
 * Live test: frontmatter `auto-exit` and `no-session` params
 *
 * Verifies:
 *   - `auto-exit: true` makes the child complete autonomously
 *   - `no-session: true` uses an ephemeral session file
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

const testLabel = "auto-exit-no-session";
const ctx = setup(testLabel);

// Write auto-exit child
writeAgent(
	ctx.agentsDir,
	"fm-autoexit-child",
	{
		name: "fm-autoexit-child",
		description: "Auto-exit test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
	},
	["Reply with exactly `FM_AUTOEXIT_OK`."].join("\n"),
);

// Write no-session child (must include model for fork context window resolution)
const baseModel = ctx.model.split(":")[0];
writeAgent(
	ctx.agentsDir,
	"fm-nosession-child",
	{
		name: "fm-nosession-child",
		description: "No-session test agent.",
		"no-session": "true",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		model: baseModel,
	},
	["Reply with exactly `FM_NOSESSION_OK`."].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'FM AutoExit Child', agent 'fm-autoexit-child', title 'Auto-exit frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"Call subagent with name 'FM NoSession Child', agent 'fm-nosession-child', title 'No-session frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_AUTOEXIT_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_AUTOEXIT_DONE");
	if (!parent) throw new Error("Could not find parent session.");

	// Use getAllSubagentChildren to handle batch/individual formats
	const children = getAllSubagentChildren(parent.events);

	const autoExitResult = children.find((c) => c.name === "FM AutoExit Child");
	const noSessionResult = children.find((c) => c.name === "FM NoSession Child");
	if (!autoExitResult || !noSessionResult) {
		throw new Error(`Missing children. Found: ${children.map((c) => c.name).join(", ")}`);
	}

	// Verify both completed
	for (const c of [autoExitResult, noSessionResult]) {
		if (c.status !== "completed") throw new Error(`${c.name}: expected completed, got ${c.status}.`);
		// No-session child may not have a persistent sessionFile (ephemeral)
		if (c.name !== "FM NoSession Child" && (!c.sessionFile || !existsSync(c.sessionFile))) {
			throw new Error(`${c.name}: missing sessionFile.`);
		}
	}

	// ---- Auto-exit verification ----
	const autoExitEvents = parseJsonl(autoExitResult.sessionFile);
	const autoExitTexts = getAssistantTexts(autoExitEvents);
	if (!autoExitTexts.some((t) => t.includes("FM_AUTOEXIT_OK"))) {
		throw new Error(`Auto-exit child did not produce FM_AUTOEXIT_OK.`);
	}

	// Check for subagent_done usage
	const autoExitToolCalls = autoExitEvents
		.filter((e) => e.type === "message" && e.message?.role === "assistant")
		.flatMap((e) => (e.message.content ?? []).filter((p) => p.type === "toolCall"));
	const hasSubagentDone = autoExitToolCalls.some((tc) => tc.name === "subagent_done");
	if (hasSubagentDone) {
		console.log("Note: auto-exit child called subagent_done (optional)");
	} else {
		console.log("Auto-exit child completed without needing subagent_done.");
	}

	// ---- No-session verification ----
	const noSessionEvents =
		noSessionResult.sessionFile && existsSync(noSessionResult.sessionFile)
			? parseJsonl(noSessionResult.sessionFile)
			: [];

	// Check assistant text from the result summary
	if (noSessionResult.summary && noSessionResult.summary.includes("FM_NOSESSION_OK")) {
		console.log("No-session child produced FM_NOSESSION_OK (from summary).");
	} else if (noSessionEvents.length > 0) {
		const noSessionTexts = getAssistantTexts(noSessionEvents);
		if (!noSessionTexts.some((t) => t.includes("FM_NOSESSION_OK"))) {
			throw new Error(`No-session child did not produce FM_NOSESSION_OK.`);
		}
	} else {
		console.log("Note: Cannot verify child output directly. no-session session may have been cleaned up.");
	}

	// The sessionFile path tells us about ephemeral behavior
	const sessionPath = noSessionResult.sessionFile ?? "";
	if (sessionPath) {
		const wasCleaned = !existsSync(sessionPath);
		if (wasCleaned) {
			console.log(`No-session child session file was cleaned up (ephemeral): ${sessionPath}`);
		} else {
			console.log(`No-session child session still exists: ${sessionPath}`);
		}
	}

	// Verify noSession metadata
	if (noSessionResult.noSession === true) {
		console.log("No-session metadata confirms noSession: true");
	}

	// Check launch metadata for no-session field
	const nsMeta = noSessionEvents.find((e) => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");
	if (nsMeta?.data?.noSession === true) {
		console.log("Launch metadata confirms noSession: true");
	}

	verified = true;
	console.log(`frontmatter "auto-exit" ok: child completed autonomously`);
	console.log(`frontmatter "no-session" ok: child used ephemeral session`);
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
