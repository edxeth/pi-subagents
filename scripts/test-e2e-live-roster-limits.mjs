#!/usr/bin/env node
/**
 * Live test: roster limit fields (timeout, idle-timeout, context-warn, report-context-usage)
 *
 * Verifies in a real parent session that the ambient roster:
 *   1. carries per-agent limit lines when the agent file sets them
 *   2. carries the handling rules only when a listed agent needs them
 *   3. is understood by the live parent model for the timeout path
 *
 * Requires PI_SUBAGENT_LIVE_MODEL (or pass modelOverride below).
 */
import {
	getAssistantTexts,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const results = [];
function check(label, ok, detail = "") {
	results.push({ label, ok, detail });
	console.error(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
}

function findRosterContent(sessionDir) {
	for (const file of listJsonlFiles(sessionDir)) {
		for (const event of parseJsonl(file)) {
			const message = event?.message ?? event;
			if (message?.customType === "subagent_roster" && typeof message.content === "string") {
				return message.content;
			}
		}
	}
	return null;
}

function findSessionWithMarker(sessionDir, marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes(marker)) return { file, events };
	}
	return null;
}

function writeLimitedAgents(agentsDir) {
	writeAgent(
		agentsDir,
		"smoke-limited",
		{
			name: "smoke-limited",
			description: "Smoke worker with runtime limits.",
			"auto-exit": "true",
			mode: "background",
			spawning: "false",
			timeout: "900",
			"idle-timeout": "180",
			"context-warn-threshold": "80%",
			"context-warn-step": "5%",
			"report-context-usage": "false",
		},
		"Reply with exactly ROSTER_LIMITS_OK.",
	);
	writeAgent(
		agentsDir,
		"smoke-plain",
		{
			name: "smoke-plain",
			description: "Smoke worker without runtime limits.",
			"auto-exit": "true",
			mode: "background",
			spawning: "false",
		},
		"Reply with exactly ROSTER_PLAIN_OK.",
	);
	writeAgent(
		agentsDir,
		"smoke-forked",
		{
			name: "smoke-forked",
			description: "Smoke worker that forks the parent transcript under a context limit.",
			"auto-exit": "true",
			mode: "background",
			spawning: "false",
			"session-mode": "fork",
			"context-warn-threshold": "80%",
		},
		"Reply with exactly ROSTER_FORKED_OK.",
	);
}

// --- Run 1: limit lines and rules reach the parent session ---
const ctx1 = setup("roster-limits");
try {
	writeLimitedAgents(ctx1.agentsDir);
	runPi(ctx1, "Do not launch any agent. Reply with exactly ROSTER_SMOKE_1_DONE and nothing else.");
	const roster = findRosterContent(ctx1.sessionDir);
	check("run 1: ambient roster message present in parent session", roster !== null);
	if (roster) {
		const limitedBlock = roster.slice(roster.indexOf("`smoke-limited`"), roster.indexOf("`smoke-plain`"));
		const plainBlock = roster.slice(roster.indexOf("`smoke-plain`"), roster.indexOf("</subagent-roster>"));
		check("run 1: limited agent shows timeout: 15m", limitedBlock.includes("timeout: 15m"));
		check("run 1: limited agent shows idle-timeout: 3m", limitedBlock.includes("idle-timeout: 3m"));
		check("run 1: limited agent shows context-warn: 80%", limitedBlock.includes("context-warn: 80%"));
		check(
			"run 1: limited agent shows report-context-usage: false",
			limitedBlock.includes("report-context-usage: false"),
		);
		check("run 1: rules say a stop is not a failure", roster.includes("A stop is not a failure"));
		check(
			"run 1: rules say do not resume an agent that stopped early",
			roster.includes("Do not resume an agent that stopped this way"),
		);
		check(
			"run 1: rules cover report-context-usage: false",
			roster.includes("`report-context-usage: false` hides the token counts"),
		);
		check(
			"run 1: rules warn a forked context-warn agent starts with a partly full window",
			roster.includes("already using part of its window"),
		);
		const plainHasLimits = /timeout:|idle-timeout:|context-warn:|report-context-usage:/.test(plainBlock);
		check("run 1: plain agent carries no limit lines", !plainHasLimits);
	}
} finally {
	ctx1.cleanup();
}

// --- Run 2: the live parent model reads the rules correctly ---
const ctx2 = setup("roster-limits-read");
try {
	writeLimitedAgents(ctx2.agentsDir);
	runPi(
		ctx2,
		[
			"Do not launch any agent. Answer from the roster only, in one sentence:",
			"if smoke-limited stops because it reached the limit on its whole run, is its result a failure,",
			"and where do you look for what to do next?",
			"End your reply with exactly ROSTER_SMOKE_2_DONE.",
		].join(" "),
	);
	const session = findSessionWithMarker(ctx2.sessionDir, "ROSTER_SMOKE_2_DONE");
	check("run 2: parent session with answer marker found", session !== null);
	if (session) {
		const answer = getAssistantTexts(session.events).join("\n").replace(/[*_]/g, "");
		console.error(`run 2 answer: ${answer}`);
		const rejectsFailure =
			/not\s+a\s+failure|is\s+no\s+failure|isn'?t\s+a\s+failure|no,?\s+it\s+is\s+not/i.test(answer);
		const pointsToResult = /result|report/i.test(answer);
		check("run 2: answer does not call the stop a failure", rejectsFailure, answer.slice(0, 200));
		check("run 2: answer points to the result text", pointsToResult, answer.slice(0, 200));
	}
} finally {
	ctx2.cleanup();
}

// --- Run 3: no limits anywhere -> no limit lines, no handling rules ---
const ctx3 = setup("roster-limits-absent");
try {
	writeAgent(
		ctx3.agentsDir,
		"smoke-plain",
		{
			name: "smoke-plain",
			description: "Smoke worker without runtime limits.",
			"auto-exit": "true",
			mode: "background",
			spawning: "false",
		},
		"Reply with exactly ROSTER_PLAIN_OK.",
	);
	runPi(ctx3, "Do not launch any agent. Reply with exactly ROSTER_SMOKE_3_DONE and nothing else.");
	const roster = findRosterContent(ctx3.sessionDir);
	check("run 3: roster present for plain agent", roster !== null);
	if (roster) {
		const hasLimitText =
			/timeout:|idle-timeout:|context-warn|report-context-usage|A stop is not a failure|Do not resume an agent/.test(
				roster,
			);
		check("run 3: no limit lines or handling rules without the fields", !hasLimitText);
	}
} finally {
	ctx3.cleanup();
}

const failed = results.filter((r) => !r.ok);
console.error(failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`);
process.exitCode = failed.length === 0 ? 0 : 1;
