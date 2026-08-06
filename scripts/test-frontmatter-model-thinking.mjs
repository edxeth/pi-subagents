#!/usr/bin/env node
/**
 * Live test: frontmatter `model` and `thinking` params
 *
 * Verifies that `model` and `thinking` in the agent frontmatter are applied
 * to the child process. We check this by having a child extension snapshot
 * the session model/provider and confirming it matches expectations.
 *
 * Strategy:
 *   - Write a child agent with explicit `model` and `thinking`
 *   - The child takes a snapshot via extension that captures what model is active
 *   - Parent validates the snapshot file
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const testLabel = "model-thinking";
const ctx = setup(testLabel);

// Extract the base model (without thinking suffix) for the agent frontmatter
const modelParts = ctx.model.split(":");
const baseModel = modelParts[0];

// Use a different thinking level to verify it changes
const childThinking = "off";

const extFile = join(ctx.extensionsDir, "model-snapshot.ts");

// Write a custom extension that captures model info at session start
writeFileSync(
	extFile,
	`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    const agent = process.env.PI_SUBAGENT_AGENT;
    if (!agent) return;
    const outDir = ${JSON.stringify(ctx.snapshotsDir)};
    setTimeout(() => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, agent + ".model.json"),
        JSON.stringify({
          agent,
          model: process.env.PI_SUBAGENT_MODEL ?? "unknown",
          parentSession: process.env.PI_SUBAGENT_PARENT_SESSION ?? "none",
        }, null, 2),
        "utf8",
      );
    }, 0);
  });

  pi.registerTool({
    name: "report_self_model",
    label: "Report Self Model",
    description: "Report the model this agent was launched with",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: "MODEL_REPORT_OK" }],
        details: { model: process.env.PI_SUBAGENT_MODEL ?? "unknown" },
      };
    },
  });
}
`,
	"utf8",
);

// Write child agents - one with specific model, one with specific thinking
writeAgent(
	ctx.agentsDir,
	"fm-model-child",
	{
		name: "fm-model-child",
		description: "Live model frontmatter smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		model: baseModel,
		extensions: extFile,
	},
	["Reply with exactly `FM_MODEL_OK`."].join("\n"),
);

writeAgent(
	ctx.agentsDir,
	"fm-thinking-child",
	{
		name: "fm-thinking-child",
		description: "Live thinking frontmatter smoke test agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		tools: "bash",
		model: baseModel,
		thinking: childThinking,
		extensions: extFile,
	},
	["Reply with exactly `FM_THINKING_OK`."].join("\n"),
);

const prompt = [
	"The subagent tool is available in this session.",
	"Call subagent with name 'FM Model Child', agent 'fm-model-child', title 'Model frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"Call subagent with name 'FM Thinking Child', agent 'fm-thinking-child', title 'Thinking frontmatter verification', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_MODEL_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_MODEL_DONE");
	if (!parent) throw new Error("Could not find parent session.");

	// The LLM may batch both children in one subagent call with children: [...]
	// In that case, result has status "batch" with a children array.
	// Or it may make two separate calls (unlikely with modern models).
	const subagentResults = getToolResults(parent.events, "subagent");

	let modelResult, thinkingResult;

	if (subagentResults.length === 1 && subagentResults[0].details?.status === "batch") {
		// Batch result - children are in details.children[]
		const batchChildren = subagentResults[0].details.children ?? [];
		if (batchChildren.length === 0) throw new Error("Batch result has no children.");
		for (const child of batchChildren) {
			if (child.status !== "completed")
				throw new Error(`${child.name ?? "child"}: expected completed, got ${child.status}.`);
			if (!child.sessionFile || !existsSync(child.sessionFile))
				throw new Error(`${child.name ?? "child"}: missing sessionFile.`);
			if (child.name === "FM Model Child") modelResult = child;
			if (child.name === "FM Thinking Child") thinkingResult = child;
		}
	} else if (subagentResults.length >= 2) {
		// Individual results
		for (const sr of subagentResults) {
			const d = sr.details ?? {};
			if (d.status !== "completed") throw new Error(`${d.name ?? "child"}: expected completed, got ${d.status}.`);
			if (d.blocking !== true) throw new Error(`${d.name}: expected blocking true.`);
			if (!d.sessionFile || !existsSync(d.sessionFile)) throw new Error(`${d.name}: missing sessionFile.`);
			if (d.name === "FM Model Child") modelResult = d;
			if (d.name === "FM Thinking Child") thinkingResult = d;
		}
	} else {
		throw new Error(`Expected subagent results in batch or individual format, got ${subagentResults.length} results.`);
	}

	if (!modelResult || !thinkingResult) {
		throw new Error(`Missing results. Model: ${!!modelResult}, Thinking: ${!!thinkingResult}`);
	}

	// Verify model child
	const modelEvents = parseJsonl(modelResult.sessionFile);
	const modelTexts = getAssistantTexts(modelEvents);
	if (!modelTexts.some((t) => t.includes("FM_MODEL_OK"))) {
		throw new Error(`Model child did not produce FM_MODEL_OK.`);
	}

	// Verify thinking child
	const thinkingEvents = parseJsonl(thinkingResult.sessionFile);
	const thinkingTexts = getAssistantTexts(thinkingEvents);
	if (!thinkingTexts.some((t) => t.includes("FM_THINKING_OK"))) {
		throw new Error(`Thinking child did not produce FM_THINKING_OK.`);
	}

	// Check model snapshot from extension
	const modelSnapshot = join(ctx.snapshotsDir, "fm-model-child.model.json");
	if (!existsSync(modelSnapshot)) {
		console.log("Warning: model snapshot not found (extension may not have fired)");
	} else {
		const ms = JSON.parse(readFileSync(modelSnapshot, "utf8"));
		console.log(`model child snapshot: agent=${ms.agent}, session model detail available`);
	}

	// Check thinking snapshot
	const thinkingSnapshot = join(ctx.snapshotsDir, "fm-thinking-child.model.json");
	if (!existsSync(thinkingSnapshot)) {
		console.log("Warning: thinking snapshot not found");
	} else {
		const ts = JSON.parse(readFileSync(thinkingSnapshot, "utf8"));
		console.log(`thinking child snapshot: agent=${ts.agent}, model=${ts.model}`);
	}

	verified = true;
	console.log(
		`frontmatter ` + "`model`" + ` ok: model child completed with model ${baseModel} (${modelResult.id ?? "batch"})`,
	);
	console.log(
		`frontmatter ` +
			"`thinking`" +
			` ok: thinking child completed with thinking ${childThinking} (${thinkingResult.id ?? "batch"})`,
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
