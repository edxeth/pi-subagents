#!/usr/bin/env node
/**
 * Live test: frontmatter `timeout`
 *
 * Verifies that a wall-clock budget kills a runaway background child, that the
 * parent is told why, and that an agent without the field stays unbounded.
 *
 * Strategy:
 *   - `fm-timeout-child` has `timeout: 15` and is told to run a long sleep.
 *     The child cannot finish inside the budget, so the parent must kill it.
 *   - `fm-timeout-free-child` has no budget and does a trivial task, which must
 *     complete normally with no timeout fields anywhere.
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

const ctx = setup("timeout");

writeAgent(
	ctx.agentsDir,
	"fm-timeout-child",
	{
		name: "fm-timeout-child",
		description: "Live wall-clock timeout smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		timeout: "15",
	},
	[
		"Run exactly one bash command: `sleep 400`.",
		"When it returns, reply with exactly `FM_TIMEOUT_FINISHED`.",
		"You are expected to be killed before that happens.",
	].join("\n"),
);

writeAgent(
	ctx.agentsDir,
	"fm-timeout-free-child",
	{
		name: "fm-timeout-free-child",
		description: "Live control agent with no timeout budget.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "none",
	},
	"Reply with exactly `FM_TIMEOUT_FREE_OK` and nothing else.",
);

const prompt = [
	"The subagent tool is available in this session.",
	"First call subagent with name 'fm-timeout-child', agent 'fm-timeout-child', title 'Wall clock timeout verification', task 'Follow your exact built-in instructions.'.",
	"Then call subagent with name 'fm-free-child', agent 'fm-timeout-free-child', title 'Unbounded control verification', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_TIMEOUT_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	const startedAt = Date.now();
	runPi(ctx, prompt);
	const wallClockMs = Date.now() - startedAt;

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_TIMEOUT_DONE");
	if (!parent) throw new Error("Could not find parent session.");
	const killedDetails = findSubagentChild(parent.events, "fm-timeout-child");
	if (!killedDetails) throw new Error("Could not find the subagent result for fm-timeout-child.");

	if (killedDetails.timedOut !== "timeout") {
		throw new Error(`Expected details.timedOut === "timeout", got ${JSON.stringify(killedDetails.timedOut)}.`);
	}
	if (killedDetails.timedOutAfter !== 15) {
		throw new Error(`Expected details.timedOutAfter === 15, got ${JSON.stringify(killedDetails.timedOutAfter)}.`);
	}
	if (typeof killedDetails.elapsed !== "number" || killedDetails.elapsed < 14 || killedDetails.elapsed > 60) {
		throw new Error(`Child elapsed ${killedDetails.elapsed}s is not consistent with a 15s budget.`);
	}

	const killedText = getAllSubagentText(parent.events);
	if (!/ran out of time, so the system stopped it after .*limit of 15s for the whole run/s.test(killedText)) {
		console.log(`Parent-visible text: ${JSON.stringify(killedText)}`);
		throw new Error("Parent was not told the child was stopped on its time limit.");
	}
	if (!killedText.includes("smaller task")) {
		throw new Error("Parent-visible text is missing the next-step guidance.");
	}
	if (!killedText.includes("use the subagent_resume tool")) {
		throw new Error("Default on-timeout policy must point the parent at subagent_resume.");
	}

	if (!killedDetails.sessionFile || !existsSync(killedDetails.sessionFile)) {
		throw new Error("Missing child sessionFile for the killed child.");
	}
	const childEvents = parseJsonl(killedDetails.sessionFile);
	if (getAssistantTexts(childEvents).some((text) => text.includes("FM_TIMEOUT_FINISHED"))) {
		throw new Error("The child finished its sleep, so the budget did not bound it.");
	}
	const verdict = readTimeoutSidecar(killedDetails.sessionFile);
	if (verdict?.kind !== "timeout") {
		throw new Error(`Expected a timeout verdict beside the child session, got ${JSON.stringify(verdict)}.`);
	}
	if (verdict.blocksResume !== false) {
		throw new Error("Default on-timeout policy must record blocksResume: false.");
	}

	const metadata = childEvents.find(
		(event) => event.type === "custom" && event.customType === "pi-subagents_launch_metadata",
	);
	if (metadata?.data?.timeout !== 15) {
		throw new Error(`Expected timeout: 15 persisted in launch metadata, got ${JSON.stringify(metadata?.data)}.`);
	}

	const freeDetails = findSubagentChild(parent.events, "fm-timeout-free-child");
	if (!freeDetails) throw new Error("Could not find the subagent result for fm-timeout-free-child.");
	if (freeDetails.status !== "completed") {
		throw new Error(`Unbounded control child should complete, got ${freeDetails.status}.`);
	}
	if (freeDetails.timedOut !== undefined) {
		throw new Error("Unbounded control child must carry no timeout fields.");
	}
	const freeEvents = parseJsonl(freeDetails.sessionFile);
	const freeMetadata = freeEvents.find(
		(event) => event.type === "custom" && event.customType === "pi-subagents_launch_metadata",
	);
	if (freeMetadata?.data?.timeout !== undefined || freeMetadata?.data?.idleTimeout !== undefined) {
		throw new Error("An agent with no budget must persist no budget in launch metadata.");
	}

	verified = true;
	console.log(
		`frontmatter \`timeout\` ok: child killed after ${killedDetails.elapsed}s on a 15s budget, ` +
			`control child completed, total run ${Math.round(wallClockMs / 1000)}s`,
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
