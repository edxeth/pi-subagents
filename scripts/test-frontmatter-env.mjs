#!/usr/bin/env node
/**
 * Live test: frontmatter `env` param
 *
 * Verifies that `env` passes environment variables to subagent child processes.
 *
 * Strategy:
 *   - Write a child agent with `env: FOO=bar,BAZ=qux`
 *   - Child runs bash to echo the env vars
 *   - Parent verifies the vars are present in the child session
 */

import { existsSync } from "node:fs";
import {
	getAssistantTexts,
	getToolResults,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const testLabel = "env";
const ctx = setup(testLabel);

// Write agent with env frontmatter
writeAgent(
	ctx.agentsDir,
	"fm-env-child",
	{
		name: "fm-env-child",
		description: "Live env frontmatter smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		env: "FOO=bar,BAZ=qux",
	},
	['Run exactly one bash command: echo "FOO=$FOO BAZ=$BAZ"', "Then reply with exactly `FM_ENV_OK`."].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'FM Env Child', agent 'fm-env-child', title 'Env frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"After the tool returns, reply with exactly 'TEST_ENV_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_ENV_DONE");
	if (!parent) throw new Error("Could not find parent session.");

	const subagentResults = getToolResults(parent.events, "subagent");
	// Find the result for our specific child (handle extra calls gracefully)
	const childResult = subagentResults.find((r) => {
		const d = r.details ?? {};
		return d.agent === "fm-env-child";
	});
	if (!childResult) {
		throw new Error("Could not find subagent result for fm-env-child.");
	}
	const details = childResult.details ?? {};
	if (details.status !== "completed") {
		throw new Error(`Expected completed, got ${details.status}.`);
	}
	if (!details.sessionFile || !existsSync(details.sessionFile)) {
		throw new Error("Missing child sessionFile.");
	}

	// Verify child completed
	const childEvents = parseJsonl(details.sessionFile);
	const childTexts = getAssistantTexts(childEvents);
	if (!childTexts.some((t) => t.includes("FM_ENV_OK"))) {
		throw new Error("Child did not produce FM_ENV_OK.");
	}

	// Check the child tool result (bash output) contains the env vars
	const bashResults = getToolResults(childEvents, "bash");
	const envOutput = bashResults.map((r) => r.content?.map((c) => c.text).join(" ") ?? "").join(" ");
	if (!envOutput.includes("FOO=bar") || !envOutput.includes("BAZ=qux")) {
		console.log(`Child bash output: ${JSON.stringify(envOutput)}`);
		throw new Error("Expected FOO=bar and BAZ=qux in child's bash output.");
	}
	console.log(`Child bash output contains env vars: ${JSON.stringify(envOutput.trim())}`);

	// Check the child session launch metadata for the env field
	const metadata = childEvents.find((e) => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");
	if (!metadata) {
		throw new Error("No launch metadata found in child session.");
	}

	const persistedEnv = metadata.data?.env;
	if (!persistedEnv?.includes("FOO=bar")) {
		console.log(`Launch metadata env: ${JSON.stringify(persistedEnv)}`);
		throw new Error("Expected FOO=bar in launch metadata via env frontmatter.");
	}
	console.log(`Launch metadata contains env: ${JSON.stringify(persistedEnv)}`);

	verified = true;
	console.log(`frontmatter \`env\` ok: FOO=bar env var propagated (${details.id})`);
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
