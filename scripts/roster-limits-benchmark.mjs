#!/usr/bin/env node
/**
 * Benchmark: instruction-following accuracy of the roster limit fields.
 *
 * Reads a probes JSON file, asks each question to a live parent model that can
 * only see the ambient roster, and mechanically scores each answer against
 * mustMatch / mustNotMatch regexes over the final assistant text.
 *
 * Usage:
 *   PI_SUBAGENT_LIVE_MODEL=zai/glm-5-turbo \
 *     node scripts/roster-limits-benchmark.mjs <probes.json> <results.json>
 *
 * Probes file shape:
 *   [{ "label": "...", "question": "...",
 *      "mustMatch": ["regex", ...], "mustNotMatch": ["regex", ...] }]
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
	getAssistantTexts,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const [probesPath, resultsPath] = process.argv.slice(2);
if (!probesPath || !resultsPath) {
	console.error("usage: node roster-limits-benchmark.mjs <probes.json> <results.json>");
	process.exit(2);
}
const probes = JSON.parse(readFileSync(probesPath, "utf8"));

function writeBenchmarkAgents(agentsDir) {
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
}

function findSessionWithMarker(sessionDir, marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes(marker)) return events;
	}
	return null;
}

const results = [];
let index = 0;
for (const probe of probes) {
	index += 1;
	const marker = `BENCH_${index}_DONE`;
	const ctx = setup(`roster-bench-${index}`);
	try {
		writeBenchmarkAgents(ctx.agentsDir);
		runPi(ctx, `${probe.question} End your reply with exactly ${marker}.`);
		const events = findSessionWithMarker(ctx.sessionDir, marker);
		const answer = events ? getAssistantTexts(events).join("\n").trim() : "(no answer found)";
		const text = answer.replace(marker, "").trim();
		const missed = (probe.mustMatch ?? [])
			.filter((pattern) => !new RegExp(pattern, "i").test(text))
			.map((pattern) => `mustMatch missed: ${pattern}`);
		const violated = (probe.mustNotMatch ?? [])
			.filter((pattern) => new RegExp(pattern, "i").test(text))
			.map((pattern) => `mustNotMatch hit: ${pattern}`);
		const passed = events !== null && missed.length === 0 && violated.length === 0;
		results.push({ label: probe.label, question: probe.question, answer: text, passed, missed, violated });
		console.error(`${passed ? "PASS" : "FAIL"}: ${probe.label}`);
		if (!passed) console.error(`  answer: ${text.slice(0, 300)}`);
		for (const problem of [...missed, ...violated]) console.error(`  ${problem}`);
	} finally {
		ctx.cleanup();
	}
}

const passedCount = results.filter((r) => r.passed).length;
const accuracy = Math.round((passedCount / results.length) * 100);
const summary = { model: process.env.PI_SUBAGENT_LIVE_MODEL, total: results.length, passed: passedCount, accuracy };
writeFileSync(resultsPath, JSON.stringify({ summary, results }, null, 2), "utf8");
console.error(`accuracy: ${passedCount}/${results.length} (${accuracy}%)`);
