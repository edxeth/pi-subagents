#!/usr/bin/env node
/**
 * Live test: frontmatter `flags` param
 *
 * Verifies that `flags` passes extra CLI flags to the child pi process.
 * We use a child extension that captures the CLI argv and reports it back.
 *
 * Strategy:
 *   - Write a child agent with `flags: --verbose --custom-e2e-flag`
 *   - Child extension captures process.argv and reports it
 *   - Parent verifies that the flags appear in the child process argv
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAssistantTexts,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const testLabel = "flags";
const ctx = setup(testLabel);

const extFile = join(ctx.extensionsDir, "flags-probe.ts");

writeFileSync(
	extFile,
	`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_flags",
    label: "Report Flags",
    description: "Report the CLI flags this agent was launched with",
    parameters: Type.Object({}),
    async execute() {
      const outDir = ${JSON.stringify(ctx.snapshotsDir)};
      const agent = process.env.PI_SUBAGENT_AGENT ?? "unknown";
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, agent + ".flags.json"),
        JSON.stringify({
          agent,
          argv: process.argv,
          execArgv: process.execArgv,
        }, null, 2),
        "utf8",
      );
      return { content: [{ type: "text", text: "FLAGS_REPORT_OK" }], details: {} };
    },
  });
}
`,
	"utf8",
);

// Write agent with flags frontmatter
writeAgent(
	ctx.agentsDir,
	"fm-flags-child",
	{
		name: "fm-flags-child",
		description: "Live flags frontmatter smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		flags: "--verbose",
		extensions: extFile,
	},
	["First call the report_flags tool exactly once.", "Then reply with exactly `FM_FLAGS_OK`."].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'FM Flags Child', agent 'fm-flags-child', title 'Flags frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"After the tool returns, reply with exactly 'TEST_FLAGS_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_FLAGS_DONE");
	if (!parent) throw new Error("Could not find parent session.");

	const subagentResults = getToolResults(parent.events, "subagent");
	if (subagentResults.length !== 1) {
		throw new Error(`Expected 1 subagent result, got ${subagentResults.length}.`);
	}

	const details = subagentResults[0].details ?? {};
	if (details.status !== "completed") {
		throw new Error(`Expected completed, got ${details.status}.`);
	}
	if (!details.sessionFile || !existsSync(details.sessionFile)) {
		throw new Error("Missing child sessionFile.");
	}

	// Verify child completed
	const childEvents = parseJsonl(details.sessionFile);
	const childTexts = getAssistantTexts(childEvents);
	if (!childTexts.some((t) => t.includes("FM_FLAGS_OK"))) {
		throw new Error(`Child did not produce FM_FLAGS_OK.`);
	}

	// Check the child session launch metadata for the flags field
	// The flags are stored in the pi-subagents_launch_metadata custom entry
	const metadata = childEvents.find((e) => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");
	if (!metadata) {
		throw new Error("No launch metadata found in child session.");
	}

	const persistedFlags = metadata.data?.flags;
	if (!persistedFlags?.includes("--verbose")) {
		console.log(`Launch metadata flags: ${JSON.stringify(persistedFlags)}`);
		throw new Error("Expected --verbose flag in launch metadata via flags frontmatter.");
	}
	console.log(`Launch metadata contains flags: ${JSON.stringify(persistedFlags)}`);

	verified = true;
	console.log(`frontmatter \`flags\` ok: --verbose flag persisted in launch metadata (${details.id})`);
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
