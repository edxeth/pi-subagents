#!/usr/bin/env node
/**
 * Candidate router for the verified fan-out live e2e (ticket 09).
 *
 * Every candidate of a verified fan-out receives byte-identical argv from the
 * supervisor; this wrapper only decides which session backs each slot: the
 * real pi binary, or the deliberately-broken fixture (SPEC testing decisions)
 * whose transcript must rank last. Selected via PI_SUBAGENT_PI_COMMAND with:
 *   VF_E2E_CAPTURE_DIR  — where argv snapshots are written
 *   VF_E2E_BROKEN_SLOT  — candidate slot (1-based) backed by the fixture
 *   VF_E2E_REAL_PI      — real pi command for the other slots (default: pi)
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const compose = process.env.COMPOSE_PROJECT_NAME ?? "";
const slot = /-w(\d+)$/.exec(compose)?.[1] ?? "";
const session = process.env.PI_SUBAGENT_SESSION ?? "";
const captureDir = process.env.VF_E2E_CAPTURE_DIR ?? "";
const brokenSlot = process.env.VF_E2E_BROKEN_SLOT ?? "";

const modelIndex = args.indexOf("--model");
const modelArg = modelIndex >= 0 ? args[modelIndex + 1] : null;
const taskArg = args.find((arg) => arg.startsWith("@")) ?? null;
if (captureDir) {
	writeFileSync(
		join(captureDir, `argv-${process.pid}.json`),
		JSON.stringify({ argv: args, compose, slot, session, modelArg, taskArg }, null, 2),
	);
}

if (slot && slot === brokenSlot) {
	// Deliberately-broken candidate fixture: a completed session that writes a
	// wrong fix, runs no verification command at all, and claims success. The
	// live DeepSeek verifier must rank this candidate last.
	const prompt = taskArg ? readFileSync(taskArg.slice(1), "utf8") : "";
	writeFileSync(
		"lib/stats.js",
		"export function median(values) {\n\tconst sorted = [...values].sort((a, b) => a - b);\n\treturn sorted[Math.floor(sorted.length / 2) - 1];\n}\n",
	);
	const now = new Date().toISOString();
	const brokenContent = "export function median(values) {\n\tconst sorted = [...values].sort((a, b) => a - b);\n\treturn sorted[Math.floor(sorted.length / 2) - 1];\n}\n";
	const entries = [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: now,
			message: { role: "user", content: [{ type: "text", text: prompt }] },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: now,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I know this bug; adjusting the index is enough." },
					{
						type: "toolCall",
						id: "t1",
						name: "write",
						arguments: { path: "lib/stats.js", content: brokenContent },
					},
				],
			},
		},
		{
			type: "message",
			id: "m3",
			parentId: "m2",
			timestamp: now,
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "write",
				content: [{ type: "text", text: "wrote lib/stats.js" }],
			},
		},
		{
			type: "message",
			id: "m4",
			parentId: "m3",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Fixed median() in lib/stats.js. All tests pass; the task is complete and verified." }],
			},
		},
	];
	if (session) {
		mkdirSync(dirname(session), { recursive: true });
		writeFileSync(session, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	}
	process.exit(0);
}

const child = spawn(process.env.VF_E2E_REAL_PI ?? "pi", args, {
	stdio: ["ignore", "ignore", "pipe"],
	env: process.env,
});
let stderr = "";
child.stderr?.on("data", (chunk) => {
	stderr += String(chunk);
	if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
});
child.on("error", (error) => {
	console.error("[pi-router] spawn failed:", error.message);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (captureDir && (code ?? 0) !== 0 && stderr.trim()) {
		try {
			writeFileSync(join(captureDir, `stderr-${process.pid}.log`), stderr, "utf8");
		} catch {}
	}
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
