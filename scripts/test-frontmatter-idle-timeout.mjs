#!/usr/bin/env node
/**
 * Live test: frontmatter `idle-timeout`
 *
 * Verifies the case the field exists for: a child parked inside a blocking
 * tool call, producing nothing, with plenty of wall clock left.
 *
 * Strategy:
 *   - `fm-idle-child` has `idle-timeout: 12` and no `timeout`, and is told to
 *     run a long sleep. Its session stops growing the moment the call starts,
 *     so the idle budget must kill it even though no wall-clock budget exists.
 *   - `fm-idle-busy-child` has the same budget but keeps writing to its
 *     session in short steps, so it must survive well past 12 seconds.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	findSubagentChild,
	getAllSubagentText,
	getAssistantTexts,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const ctx = setup("idle-timeout");

writeAgent(
	ctx.agentsDir,
	"fm-idle-child",
	{
		name: "fm-idle-child",
		description: "Live idle-timeout smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		"idle-timeout": "12",
	},
	[
		"Run exactly one bash command: `sleep 400`.",
		"When it returns, reply with exactly `FM_IDLE_FINISHED`.",
		"You are expected to be killed while that command is still running.",
	].join("\n"),
);

writeAgent(
	ctx.agentsDir,
	"fm-idle-busy-child",
	{
		name: "fm-idle-busy-child",
		description: "Live control agent that keeps producing inside its idle budget.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		// Comfortably above cold start plus one model response: the idle clock
		// runs from launch, and only the child's own output restarts it.
		"idle-timeout": "30",
	},
	[
		"Run this bash command four times, one call at a time: `sleep 6 && echo step`.",
		"Do not batch them into one call.",
		"After the fourth call returns, reply with exactly `FM_IDLE_BUSY_OK`.",
	].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"First call subagent with name 'fm-idle-child', agent 'fm-idle-child', title 'Idle timeout verification', task 'Follow your exact built-in instructions.'.",
	"Then call subagent with name 'fm-busy-child', agent 'fm-idle-busy-child', title 'Idle progress control verification', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_IDLE_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_IDLE_DONE");
	if (!parent) throw new Error("Could not find parent session.");
	const killedDetails = findSubagentChild(parent.events, "fm-idle-child");
	if (!killedDetails) throw new Error("Could not find the subagent result for fm-idle-child.");

	if (killedDetails.timedOut !== "idle-timeout") {
		throw new Error(`Expected details.timedOut === "idle-timeout", got ${JSON.stringify(killedDetails.timedOut)}.`);
	}
	if (killedDetails.timedOutAfter !== 12) {
		throw new Error(`Expected details.timedOutAfter === 12, got ${JSON.stringify(killedDetails.timedOutAfter)}.`);
	}
	if (typeof killedDetails.elapsed !== "number" || killedDetails.elapsed > 90) {
		throw new Error(`Child elapsed ${killedDetails.elapsed}s is far past a 12s idle budget.`);
	}

	const killedText = getAllSubagentText(parent.events);
	if (!/stopped producing output, so the system stopped it after .*limit of 12s without output/s.test(killedText)) {
		console.log(`Parent-visible text: ${JSON.stringify(killedText)}`);
		throw new Error("Parent was not told the child was stopped on its no-output limit.");
	}

	if (!killedDetails.sessionFile || !existsSync(killedDetails.sessionFile)) {
		throw new Error("Missing child sessionFile for the killed child.");
	}
	const childEvents = parseJsonl(killedDetails.sessionFile);
	if (getAssistantTexts(childEvents).some((text) => text.includes("FM_IDLE_FINISHED"))) {
		throw new Error("The child finished its sleep, so the idle budget did not bound it.");
	}
	const verdict = readTimeoutSidecar(killedDetails.sessionFile);
	if (verdict?.kind !== "idle-timeout") {
		throw new Error(`Expected an idle-timeout verdict beside the child session, got ${JSON.stringify(verdict)}.`);
	}

	const busyDetails = findSubagentChild(parent.events, "fm-idle-busy-child");
	if (!busyDetails) throw new Error("Could not find the subagent result for fm-idle-busy-child.");
	if (busyDetails.timedOut !== undefined) {
		throw new Error(
			`A child that kept producing must not be killed, but it reported ${JSON.stringify(busyDetails.timedOut)}.`,
		);
	}
	if (typeof busyDetails.elapsed !== "number" || busyDetails.elapsed <= 30) {
		throw new Error(
			`The control child finished in ${busyDetails.elapsed}s, which does not prove it outlived its 30s idle budget.`,
		);
	}

	verified = true;
	console.log(
		`frontmatter \`idle-timeout\` ok: blocked child killed after ${killedDetails.elapsed}s on a 12s idle budget, ` +
			`producing child survived ${busyDetails.elapsed}s past a 30s idle budget`,
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
