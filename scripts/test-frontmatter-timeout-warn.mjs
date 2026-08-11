#!/usr/bin/env node
/**
 * Live test: frontmatter `timeout-warn-threshold`
 *
 * Verifies that an opted-in child warns itself before the parent kills it, and
 * that a child without the field is never warned.
 *
 * Strategy:
 *   - `fm-warn-child` has `timeout: 30` and `timeout-warn-threshold: 50%`, so
 *     the warning is due about 15s in. Its task keeps it busy in short steps so
 *     the steer can actually be delivered and committed to its session.
 *   - `fm-warn-silent-child` has the same budget without the threshold and must
 *     receive no warning at all.
 */

import { existsSync } from "node:fs";
import {
	findSubagentChild,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const ctx = setup("timeout-warn");

const busyBody = [
	"Run this bash command six times, one call at a time: `sleep 5 && echo tick`.",
	"Do not batch them into one call.",
	"After the sixth call returns, reply with exactly `FM_WARN_FINISHED`.",
].join("\n");

writeAgent(
	ctx.agentsDir,
	"fm-warn-child",
	{
		name: "fm-warn-child",
		description: "Live timeout-warn-threshold smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		timeout: "30",
		"timeout-warn-threshold": "50%",
	},
	busyBody,
);

writeAgent(
	ctx.agentsDir,
	"fm-warn-silent-child",
	{
		name: "fm-warn-silent-child",
		description: "Live control agent with a budget but no warning.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		timeout: "30",
	},
	busyBody,
);

const prompt = [
	"The subagent tool is available in this session.",
	"First call subagent with name 'fm-warn-child', agent 'fm-warn-child', title 'Timeout warning verification', task 'Follow your exact built-in instructions.'.",
	"Then call subagent with name 'fm-silent-child', agent 'fm-warn-silent-child', title 'No warning control verification', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_WARN_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_WARN_DONE");
	if (!parent) throw new Error("Could not find parent session.");
	const warnedDetails = findSubagentChild(parent.events, "fm-warn-child");
	if (!warnedDetails) throw new Error("Could not find the subagent result for fm-warn-child.");
	if (!warnedDetails.sessionFile || !existsSync(warnedDetails.sessionFile)) {
		throw new Error("Missing child sessionFile for the warned child.");
	}

	const warnedText = getUserText(parseJsonl(warnedDetails.sessionFile));
	const warnMatch = warnedText.match(
		/Time limit: you have been running for (\d+)s, and your limit is 30s for this whole run\. About (\d+)s remain/,
	);
	if (!warnMatch) {
		console.log(`Warned child user text: ${JSON.stringify(warnedText)}`);
		throw new Error("The opted-in child never received its timeout warning.");
	}
	const spent = Number(warnMatch[1]);
	const remaining = Number(warnMatch[2]);
	if (spent < 14 || spent > 29) {
		throw new Error(`Warning fired at ${spent}s, which is not near 50% of a 30s budget.`);
	}
	if (spent + remaining !== 30) {
		throw new Error(`Warning arithmetic is wrong: ${spent}s spent + ${remaining}s remaining is not 30s.`);
	}
	if (!warnedText.includes("Report your result now")) {
		throw new Error("The warning did not tell the child to report its result.");
	}
	// The child never saw the agent file, so the warning must explain itself.
	if (!warnedText.includes("the system stops you")) {
		throw new Error("The warning did not tell the child what happens at the limit.");
	}

	const silentDetails = findSubagentChild(parent.events, "fm-warn-silent-child");
	if (!silentDetails) throw new Error("Could not find the subagent result for fm-warn-silent-child.");
	const silentText = getUserText(parseJsonl(silentDetails.sessionFile));
	if (/Time limit: you have been running/.test(silentText)) {
		throw new Error("A child without timeout-warn-threshold must never be warned.");
	}

	verified = true;
	console.log(
		`frontmatter \`timeout-warn-threshold\` ok: warned at ${spent}s of 30s with ${remaining}s left, ` +
			"control child silent",
	);
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
