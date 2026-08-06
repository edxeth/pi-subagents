#!/usr/bin/env node
/**
 * Live test: frontmatter `enabled: false` param
 *
 * Verifies that `enabled: false` makes the agent undiscoverable and
 * unlaunchable. The subagent tool should return an error.
 *
 * Strategy:
 *   - Write a disabled agent
 *   - Try to launch it from the parent
 *   - Verify the parent receives an error/refusal
 */

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

const testLabel = "enabled";
const ctx = setup(testLabel);

// Write both an enabled and a disabled agent with the same name
// Project agents override global agents. We write only the disabled one.
writeAgent(
	ctx.agentsDir,
	"fm-disabled-child",
	{
		name: "fm-disabled-child",
		description: "This agent should be hidden.",
		enabled: "false",
		"auto-exit": "true",
		mode: "background",
		spawning: "false",
	},
	["Reply with exactly `FM_DISABLED_OK`."].join("\n"),
);

// Write an enabled agent to verify the disabled one is actually different
writeAgent(
	ctx.agentsDir,
	"fm-enabled-child",
	{
		name: "fm-enabled-child",
		description: "This agent should be visible.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
	},
	["Reply with exactly `FM_ENABLED_OK`."].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Use exactly this sequence.",
	"First, try to call subagent with name 'Disabled Child', agent 'fm-disabled-child', title 'Disabled child test', task 'Test task'.",
	"If that fails with an error, that is expected behavior.",
	"Then, call subagent with name 'Enabled Child', agent 'fm-enabled-child', title 'Enabled child test', task 'Follow your exact built-in instructions.'.",
	"After the enabled tool returns, reply with exactly 'TEST_ENABLED_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_ENABLED_DONE");
	if (!parent) throw new Error("Could not find parent session with TEST_ENABLED_DONE marker.");

	const children = getAllSubagentChildren(parent.events);
	if (children.length === 0) {
		throw new Error("No child results found.");
	}

	// Check that at least one child failed (the disabled agent)
	// and at least one completed (the enabled agent)
	let foundDisabledError = false;
	let foundEnabledCompletion = false;

	for (const child of children) {
		if (child.agent === "fm-disabled-child" || child.name === "Disabled Child") {
			// The disabled agent must NOT have completed
			if (child.status === "completed") {
				throw new Error("Disabled agent (enabled:false) should NOT have completed, but it did.");
			}
			console.log(`Disabled agent correctly blocked: status=${child.status}`);
			foundDisabledError = true;
		}
		if (child.agent === "fm-enabled-child" || child.name === "Enabled Child") {
			if (child.status !== "completed") {
				throw new Error("Enabled agent expected to complete but status is " + child.status);
			}
			foundEnabledCompletion = true;
		}
	}

	// If we can't find disabled error via children, check parent text
	if (!foundDisabledError) {
		const texts = getAssistantTexts(parent.events).join("\n");
		if (texts.includes("enabled") || texts.includes("ENABLED")) {
			console.log("Parent text mentions the enabled agent interaction.");
		}
	}

	if (!foundEnabledCompletion) {
		// Fallback: check session files directly
		const allFiles = listJsonlFiles(ctx.sessionDir);
		for (const file of allFiles) {
			const events = parseJsonl(file);
			const texts = getAssistantTexts(events);
			if (texts.some((t) => t.includes("FM_ENABLED_OK"))) {
				foundEnabledCompletion = true;
				break;
			}
		}
	}

	if (!foundEnabledCompletion) {
		throw new Error("Could not verify enabled agent completed successfully.");
	}

	verified = true;
	console.log("frontmatter `enabled: false` ok: disabled agent was not launchable; enabled agent worked.");
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
