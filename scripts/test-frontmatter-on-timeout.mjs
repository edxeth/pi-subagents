#!/usr/bin/env node
/**
 * Live test: frontmatter `on-timeout`
 *
 * Verifies both policies for a session whose child was killed on a budget.
 *
 * Strategy:
 *   - `fm-block-child` sets `on-timeout: block-resume`. After the kill the
 *     parent must be told the resume is refused, and the resume command must
 *     not appear in model-visible text, so the parent has no path to it.
 *   - `fm-report-child` takes the default policy. After the kill the parent is
 *     asked to resume it, and the resumed run must inherit the same budget and
 *     be killed again rather than run unbounded.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	findSubagentChild,
	getAllSubagentText,
	getToolResults,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const ctx = setup("on-timeout");

const sleeperBody = [
	"Run exactly one bash command: `sleep 400`.",
	"When it returns, reply with exactly `FM_ON_TIMEOUT_FINISHED`.",
	"You are expected to be killed before that happens.",
].join("\n");

writeAgent(
	ctx.agentsDir,
	"fm-block-child",
	{
		name: "fm-block-child",
		description: "Live on-timeout block-resume smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		timeout: "12",
		"on-timeout": "block-resume",
	},
	sleeperBody,
);

writeAgent(
	ctx.agentsDir,
	"fm-report-child",
	{
		name: "fm-report-child",
		description: "Live on-timeout report smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		timeout: "12",
	},
	sleeperBody,
);

const blockPrompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'fm-block-child', agent 'fm-block-child', title 'Block resume verification', task 'Follow your exact built-in instructions.'.",
	"After the tool returns, reply with exactly 'TEST_BLOCK_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

const reportPrompt = [
	"The subagent tool and the subagent_resume tool are available in this session.",
	"First call subagent with name 'fm-report-child', agent 'fm-report-child', title 'Budget inheritance verification', task 'Follow your exact built-in instructions.'.",
	"The result will contain a line starting with 'Session: '. Take that exact path.",
	"Then call subagent_resume with that path as sessionFile and task 'Keep going with the same instructions.'.",
	"After both tools return, reply with exactly 'TEST_REPORT_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, blockPrompt);
	const blockParent = findSessionWithMarker(ctx.sessionDir, "TEST_BLOCK_DONE");
	if (!blockParent) throw new Error("Could not find the block-resume parent session.");
	const blockedDetails = findSubagentChild(blockParent.events, "fm-block-child");
	if (!blockedDetails) throw new Error("Could not find the subagent result for fm-block-child.");
	if (blockedDetails.timedOut !== "timeout") {
		throw new Error(`Expected the blocked child to time out, got ${JSON.stringify(blockedDetails.timedOut)}.`);
	}
	const blockedText = getAllSubagentText(blockParent.events);
	if (blockedText.includes("Resume: pi --session")) {
		throw new Error("block-resume must withhold every resume command from model-visible text.");
	}
	if (!blockedText.includes("refuses a resume of this session")) {
		console.log(`Parent-visible text: ${JSON.stringify(blockedText)}`);
		throw new Error("Parent was not told that resume is refused.");
	}
	if (blockedText.includes("Resume: pi --session")) {
		throw new Error("block-resume must withhold the resume command from model-visible text.");
	}
	if (!blockedDetails.sessionFile || !existsSync(blockedDetails.sessionFile)) {
		throw new Error("The operator still needs the session path in the structured details.");
	}
	const blockedVerdict = readTimeoutSidecar(blockedDetails.sessionFile);
	if (blockedVerdict?.kind !== "timeout" || blockedVerdict.blocksResume !== true) {
		throw new Error(`Expected a blocking timeout verdict, got ${JSON.stringify(blockedVerdict)}.`);
	}

	runPi(ctx, reportPrompt);
	const reportParent = findSessionWithMarker(ctx.sessionDir, "TEST_REPORT_DONE");
	if (!reportParent) throw new Error("Could not find the report-policy parent session.");
	const reportedDetails = findSubagentChild(reportParent.events, "fm-report-child");
	if (!reportedDetails) throw new Error("Could not find the subagent result for fm-report-child.");
	const reportedText = getAllSubagentText(reportParent.events);
	if (!reportedText.includes("Session: ")) {
		throw new Error("The default policy must leave the session path visible.");
	}
	if (!reportedText.includes("Resume only with subagent_resume")) {
		throw new Error("The default policy must point the parent at subagent_resume.");
	}
	// A raw pi run is not a tracked child and carries no budget, so that command
	// must never appear on a timed-out result.
	if (reportedText.includes("Resume: pi --session")) {
		throw new Error("A timed-out result must not advertise an unbounded raw resume.");
	}

	const resumeResults = getToolResults(reportParent.events, "subagent_resume");
	if (resumeResults.length === 0) {
		throw new Error("The parent never called subagent_resume, so budget inheritance was not exercised.");
	}
	const resumeDetails = resumeResults.at(-1).details ?? {};
	if (resumeDetails.error) {
		throw new Error(`The default policy must allow resume, but it failed: ${JSON.stringify(resumeDetails)}.`);
	}
	if (resumeDetails.timedOut !== "timeout") {
		console.log(`Resume result details: ${JSON.stringify(resumeDetails)}`);
		throw new Error("The resumed run was not bounded by the inherited budget.");
	}
	if (resumeDetails.timedOutAfter !== 12) {
		throw new Error(`Resumed run used budget ${JSON.stringify(resumeDetails.timedOutAfter)}, expected 12.`);
	}

	verified = true;
	console.log(
		"frontmatter `on-timeout` ok: block-resume withheld the resume path, " +
			`report allowed a resume that inherited the 12s budget and was killed again after ${resumeDetails.elapsed}s`,
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

function readTimeoutSidecar(sessionFile) {
	const path = `${sessionFile}.timeout`;
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8"));
}
