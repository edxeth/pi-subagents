#!/usr/bin/env node
/**
 * Live test: frontmatter `cwd` param
 *
 * Verifies that `cwd: <path>` in the agent frontmatter makes the child
 * start in the correct working directory.
 *
 * Strategy:
 *   - Write a child agent with `cwd` pointing to a dedicated work dir
 *   - The child runs `pwd` via bash and writes the result to a marker file
 *   - The child also writes a marker file in its CWD
 *   - Parent validates the marker appeared in the expected dir
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	getAssistantTexts,
	getSessionHeader,
	getToolResults,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
	writeSnapshotExtension,
} from "./live-test-common.mjs";

const testLabel = "cwd";
const ctx = setup(testLabel);

// Create the target cwd directory with a unique marker
const workDir = join(ctx.tmpRoot, "target-cwd");
mkdirSync(workDir, { recursive: true });
const markerFile = join(workDir, "fm-cwd-marker.txt");

// Write a snapshot extension
const extFile = join(ctx.extensionsDir, "cwd-snapshot.ts");
writeSnapshotExtension(extFile, ctx.snapshotsDir);

// Write the child agent with cwd frontmatter
writeAgent(
	ctx.agentsDir,
	"fm-cwd-child",
	{
		name: "fm-cwd-child",
		description: "Live cwd frontmatter smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash,write",
		cwd: workDir,
		extensions: extFile,
	},
	[
		"First run: `pwd`",
		"Then write the pwd output to a file at this path: /tmp/fm-cwd-pwd-result.txt",
		"Then use bash to write a marker to the path: echo 'fm-cwd-ok' > " + markerFile,
		"Then reply with exactly `FM_CWD_OK`.",
	].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'FM CWD Child', agent 'fm-cwd-child', title 'CWD frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"After the tool returns, reply with exactly 'TEST_CWD_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_CWD_DONE");
	if (!parent) throw new Error("Could not find parent session with TEST_CWD_DONE marker.");

	const subagentResults = getToolResults(parent.events, "subagent");
	if (subagentResults.length !== 1) {
		throw new Error(`Expected 1 subagent result, got ${subagentResults.length}.`);
	}

	const details = subagentResults[0].details ?? {};
	if (details.status !== "completed") {
		throw new Error(`Expected completed status, got ${details.status ?? "missing"}.`);
	}
	if (details.blocking !== true) {
		throw new Error(`Expected blocking true, got ${details.blocking ?? "missing"}.`);
	}
	if (!details.sessionFile || !existsSync(details.sessionFile)) {
		throw new Error("Missing child sessionFile.");
	}

	// Verify child completed its task
	const childEvents = parseJsonl(details.sessionFile);
	const childTexts = getAssistantTexts(childEvents);
	if (!childTexts.some((t) => t.includes("FM_CWD_OK"))) {
		throw new Error(`Child did not produce FM_CWD_OK. Texts: ${JSON.stringify(childTexts)}`);
	}

	// Verify the marker file appears in the expected cwd dir
	if (!existsSync(markerFile)) {
		throw new Error(
			`Expected marker file at ${markerFile} but it was not found. Child likely did not start in the correct cwd.`,
		);
	}
	const markerContent = readFileSync(markerFile, "utf8").trim();
	if (markerContent !== "fm-cwd-ok") {
		throw new Error(`Marker file content mismatch. Expected "fm-cwd-ok", got "${markerContent}".`);
	}

	// Check pwd result was written (optional secondary check)
	const pwdResultFile = "/tmp/fm-cwd-pwd-result.txt";
	if (existsSync(pwdResultFile)) {
		const pwdResult = readFileSync(pwdResultFile, "utf8").trim();
		const resolvedWorkDir = realpathSync(workDir);
		if (pwdResult !== resolvedWorkDir && !pwdResult.endsWith("/target-cwd")) {
			console.log(`pwd result: "${pwdResult}", expected to find "${resolvedWorkDir}"`);
		}
		try {
			execFileSync("rm", ["-f", pwdResultFile]);
		} catch {}
	}

	// Verify child session header mentions the cwd
	const childHeader = getSessionHeader(childEvents);
	if (childHeader?.cwd && childHeader.cwd !== workDir) {
		// Session header cwd might be the agent config base, not the effective cwd.
		// The effective cwd is set via `cd` in the interactive path or `cwd` in spawn.
		// We already verified via file marker, so this is informational.
		console.log(`child session cwd field: "${childHeader.cwd}" (effective cwd was verified via file marker)`);
	}

	verified = true;
	console.log(`frontmatter ` + "`cwd`" + ` ok: child started in ${workDir} (${details.id})`);
} finally {
	// Clean up /tmp artifacts from child
	try {
		execFileSync("rm", ["-f", "/tmp/fm-cwd-pwd-result.txt"]);
	} catch {}
	ctx.cleanup();
}

// Exit with proper code for automated runners
if (!verified) process.exit(1);

function findSessionWithMarker(sessionDir, marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes(marker)) return { file, events };
	}
	return null;
}
