#!/usr/bin/env node
/**
 * Live test: enforced frontmatter `timeout-warn-threshold` wrap-up.
 *
 * The opted-in child enters a synchronous custom tool that blocks its event
 * loop. A child-side timer or steer cannot help it. The parent must interrupt
 * the process at 50%, resume the same session in report-only mode, block any
 * retried tool, and receive a report before the original 100% deadline.
 *
 * A control child has the same blocking tool and a hard timeout but no warning
 * threshold. It must run to the hard timeout without a wrap-up continuation.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	findSubagentChild,
	getAllSubagentText,
	getUserText,
	listJsonlFiles,
	parseJsonl,
	runPi,
	setup,
	writeAgent,
} from "./live-test-common.mjs";

const ctx = setup("timeout-warn");
const countsDir = ctx.snapshotsDir;

writeFileSync(
	join(ctx.extensionsDir, "blocking-tool.ts"),
	`import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export default function (pi) {
  pi.registerTool({
    name: "block_until_killed",
    label: "Block Until Killed",
    description: "Enter a synchronous native wait that only the parent runtime can interrupt.",
    parameters: Type.Object({}),
    async execute() {
      const dir = ${JSON.stringify(countsDir)};
      const agent = process.env.PI_SUBAGENT_AGENT || "unknown";
      const file = join(dir, agent + ".count");
      mkdirSync(dir, { recursive: true });
      const count = existsSync(file) ? Number(readFileSync(file, "utf8")) || 0 : 0;
      writeFileSync(file, String(count + 1), "utf8");
      execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
      return { content: [{ type: "text", text: "BLOCK_RETURNED" }], details: {} };
    },
  });
}
`,
	"utf8",
);

const blockingBody = [
	"Immediately call `block_until_killed` once. Do not write any assistant text before that call.",
	"If the call is interrupted or fails, your standing task would normally be to retry it before reporting.",
	"If a later system or user instruction explicitly puts you in report-only mode, obey that newer instruction instead and report what happened without tools.",
].join("\n");

writeAgent(
	ctx.agentsDir,
	"fm-warn-child",
	{
		name: "fm-warn-child",
		description: "Live enforced timeout wrap-up smoke agent.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		extensions: "all",
		tools: "block_until_killed",
		"no-session": "true",
		"session-mode": "standalone",
		timeout: "60",
		"timeout-warn-threshold": "50%",
	},
	blockingBody,
);

writeAgent(
	ctx.agentsDir,
	"fm-warn-control",
	{
		name: "fm-warn-control",
		description: "Live hard-timeout control without a wrap-up threshold.",
		"auto-exit": "true",
		mode: "background",
		async: "false",
		spawning: "false",
		extensions: "all",
		tools: "block_until_killed",
		timeout: "15",
	},
	blockingBody,
);

const prompt = [
	"The subagent tool is available in this session.",
	"First call subagent with name 'fm-warn-child', agent 'fm-warn-child', title 'Enforced wrap-up verification', task 'Follow your exact built-in instructions.'.",
	"Then call subagent with name 'fm-warn-control', agent 'fm-warn-control', title 'Hard timeout control verification', task 'Follow your exact built-in instructions.'.",
	"After both tools return, reply with exactly 'TEST_WARN_DONE' and nothing else.",
	"Do not call any other tools.",
].join(" ");

let verified = false;
try {
	runPi(ctx, prompt);

	const parent = findSessionWithMarker(ctx.sessionDir, "TEST_WARN_DONE");
	if (!parent) throw new Error("Could not find parent session.");

	const warnedDetails = findSubagentChild(parent.events, "fm-warn-child");
	if (!warnedDetails) throw new Error("Could not find the result for fm-warn-child.");
	if (warnedDetails.status !== "completed") {
		throw new Error(`The wrap-up child should complete, got ${JSON.stringify(warnedDetails)}.`);
	}
	if (warnedDetails.timedOut !== undefined) {
		throw new Error(`The wrap-up child reached the hard timeout: ${JSON.stringify(warnedDetails.timedOut)}.`);
	}
	if (
		warnedDetails.timeoutWrapUp?.kind !== "timeout" ||
		warnedDetails.timeoutWrapUp?.seconds !== 60 ||
		warnedDetails.timeoutWrapUp?.threshold !== 50
	) {
		throw new Error(`Missing enforced wrap-up details: ${JSON.stringify(warnedDetails.timeoutWrapUp)}.`);
	}
	if (typeof warnedDetails.elapsed !== "number" || warnedDetails.elapsed < 29 || warnedDetails.elapsed >= 60) {
		throw new Error(`Wrap-up elapsed ${warnedDetails.elapsed}s is outside the original 60s clock.`);
	}
	if (warnedDetails.sessionFile !== undefined) {
		throw new Error("An ephemeral wrap-up child exposed a resumable session.");
	}
	if (typeof warnedDetails.summary !== "string" || warnedDetails.summary.trim() === "") {
		throw new Error("The report-only continuation produced no assistant report.");
	}
	assertToolWasEnteredExactlyOnce("fm-warn-child");
	if (findPersistedChildSession("fm-warn-child")) {
		throw new Error("The ephemeral wrap-up session was not deleted after final delivery.");
	}

	const parentText = getAllSubagentText(parent.events);
	if (!parentText.includes('Sub-agent "fm-warn-child" completed its time-limit wrap-up')) {
		throw new Error(`Parent-visible text did not classify the wrap-up:\n${parentText}`);
	}

	const controlDetails = findSubagentChild(parent.events, "fm-warn-control");
	if (!controlDetails) throw new Error("Could not find the result for fm-warn-control.");
	if (controlDetails.timedOut !== "timeout" || controlDetails.timedOutAfter !== 15) {
		throw new Error(`The no-threshold control did not reach its hard timeout: ${JSON.stringify(controlDetails)}.`);
	}
	if (controlDetails.timeoutWrapUp !== undefined) {
		throw new Error("A child without timeout-warn-threshold must not enter wrap-up mode.");
	}
	assertToolWasEnteredExactlyOnce("fm-warn-control");
	const controlText = getUserText(parseJsonl(controlDetails.sessionFile));
	if (controlText.includes("interrupted your previous active operation")) {
		throw new Error("The no-threshold control received a wrap-up prompt.");
	}

	verified = true;
	console.log(
		`frontmatter \`timeout-warn-threshold\` ok: blocked child interrupted and reported in ${warnedDetails.elapsed}s ` +
			"inside its original 60s clock; no-threshold control hit 15s hard timeout",
	);
} finally {
	ctx.cleanup();
}

if (!verified) process.exit(1);

function assertToolWasEnteredExactlyOnce(agent) {
	const file = join(countsDir, `${agent}.count`);
	const count = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
	if (count !== 1) {
		throw new Error(`Expected ${agent} to enter the blocking tool exactly once, got ${count}.`);
	}
}

function findSessionWithMarker(sessionDir, marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes(marker)) return { file, events };
	}
	return null;
}

function findPersistedChildSession(name) {
	for (const file of listJsonlFiles(ctx.sessionDir)) {
		const events = parseJsonl(file);
		const metadata = events.find(
			(event) => event.type === "custom" && event.customType === "pi-subagents_launch_metadata",
		)?.data;
		if (metadata?.name === name) return file;
	}
	return null;
}
