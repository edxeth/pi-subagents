#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLiveWindowLock } from "./live-test-guard.mjs";

const SCRIPT_NAME = "test-live-herdr-timeout-wrap-up";
const OPT_IN_ENV = "PI_SUBAGENT_ALLOW_LIVE_WINDOWS";
const LIVE_MODEL_ENV = "PI_SUBAGENT_LIVE_MODEL";
const POLL_MS = 500;
const RUN_TIMEOUT_MS = 180_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function shellQuote(value) {
	return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runHerdr(args, options = {}) {
	return execFileSync("herdr", args, {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: 10_000,
		...options,
	});
}

function herdrResult(operation, args) {
	const output = runHerdr(args);
	let envelope;
	try {
		envelope = JSON.parse(output);
	} catch (error) {
		throw new Error(`herdr ${operation} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
	}
	if (envelope?.error) throw new Error(`herdr ${operation} failed: ${JSON.stringify(envelope.error)}`);
	if (!envelope?.result || typeof envelope.result !== "object") {
		throw new Error(`herdr ${operation} returned no result`);
	}
	return envelope.result;
}

function closeQuiet(kind, id) {
	if (!id) return;
	try {
		runHerdr([kind, "close", id], { stdio: "ignore" });
	} catch {}
}

function listTabs() {
	const tabs = herdrResult("tab list", ["tab", "list"]).tabs;
	return Array.isArray(tabs) ? tabs : [];
}

function listPanes() {
	const panes = herdrResult("pane list", ["pane", "list"]).panes;
	return Array.isArray(panes) ? panes : [];
}

function sweepTabs(labels) {
	for (const tab of listTabs()) {
		const label = typeof tab?.label === "string" ? tab.label : "";
		if (labels.some((needle) => label.includes(needle))) closeQuiet("tab", tab.tab_id);
	}
}

function requireHerdr() {
	const status = JSON.parse(runHerdr(["status", "server", "--json"]));
	if (status.running !== true || status.compatible !== true) {
		throw new Error(`Herdr server is not ready: ${JSON.stringify(status)}`);
	}
}

function parseJsonl(file) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

function listJsonlFiles(dir) {
	if (!existsSync(dir)) return [];
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listJsonlFiles(path));
		else if (entry.isFile() && path.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

function getText(events, role) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === role)
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function getAssistantTexts(events) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === "assistant")
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim());
}

function findParentSession(sessionDir, marker) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getText(events, "user").includes(marker)) return { file, events };
	}
	return null;
}

function findChildSession(sessionDir, childName) {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		const metadata = events.find(
			(event) => event.type === "custom" && event.customType === "pi-subagents_launch_metadata",
		)?.data;
		if (metadata?.name === childName) return { file, events, metadata };
	}
	return null;
}

function getSubagentResult(events) {
	return events
		.filter(
			(event) =>
				event.type === "message" && event.message?.role === "toolResult" && event.message.toolName === "subagent",
		)
		.map((event) => event.message)
		.at(-1);
}

function paneMatches(pane, childName, agentName) {
	const title = [pane?.label, pane?.terminal_title, pane?.terminal_title_stripped]
		.filter((value) => typeof value === "string")
		.join(" ");
	return title.includes(childName) || title.includes(agentName);
}

function getScreen(paneId) {
	try {
		return runHerdr(["pane", "read", paneId, "--source", "recent", "--lines", "100", "--format", "text"]);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function copyUserConfig(configDir) {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const source = configured && existsSync(join(configured, "auth.json")) ? configured : join(homedir(), ".pi", "agent");
	for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
		if (existsSync(join(source, name))) copyFileSync(join(source, name), join(configDir, name));
	}
}

function createContext() {
	const tmpRoot = mkdtempSync(join(tmpdir(), "pi-herdr-timeout-wrap-up-"));
	const configDir = join(tmpRoot, "agent");
	const agentsDir = join(configDir, "agents");
	const extensionsDir = join(configDir, "extensions");
	const sessionDir = join(tmpRoot, "sessions");
	const snapshotsDir = join(tmpRoot, "snapshots");
	const workDir = join(tmpRoot, "work");
	for (const dir of [agentsDir, extensionsDir, sessionDir, snapshotsDir, workDir]) mkdirSync(dir, { recursive: true });
	copyUserConfig(configDir);
	return { tmpRoot, configDir, agentsDir, extensionsDir, sessionDir, snapshotsDir, workDir };
}

function writeProbe(ctx, agentName) {
	writeFileSync(
		join(ctx.extensionsDir, "blocking-layout-tool.ts"),
		`import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "block_custom_layout",
    label: "Block Custom Layout",
    description: "Block the child event loop inside a synchronous native operation.",
    parameters: Type.Object({}),
    async execute() {
      const file = ${JSON.stringify(join(ctx.snapshotsDir, "tool-count"))};
      mkdirSync(dirname(file), { recursive: true });
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
	writeFileSync(
		join(ctx.agentsDir, `${agentName}.md`),
		`---
name: ${agentName}
description: Live Herdr enforced timeout wrap-up probe.
mode: interactive
auto-exit: true
async: false
spawning: false
extensions: all
tools: block_custom_layout
timeout: 60
timeout-warn-threshold: 50%
no-context-files: true
---

Immediately call \`block_custom_layout\` once. Do not write text before the call.
If a later instruction puts you in report-only mode, do not retry the tool; report the interruption and stop.
`,
		"utf8",
	);
}

function buildParentCommand(ctx, model, tracePath) {
	const unset = [
		"PI_SUBAGENT_AGENT",
		"PI_SUBAGENT_NAME",
		"PI_SUBAGENT_AUTO_EXIT",
		"PI_SUBAGENT_SPAWNABLE",
		"PI_SUBAGENT_SPAWN_BUDGET",
		"PI_SUBAGENT_SPAWN_DEPTH",
		"PI_SUBAGENT_SPAWN_WIDTH",
		"PI_DENY_TOOLS",
		"PI_SUBAGENT_SURFACE",
	]
		.map((key) => `-u ${key}`)
		.join(" ");
	const env = [
		"PI_PACKAGE_DIR=",
		"PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS=1",
		"PI_SUBAGENT_MUX=herdr",
		"PI_SUBAGENT_HERDR_PLACEMENT=tab",
		"PI_SUBAGENT_SHELL_READY_DELAY_MS=500",
		`PI_CODING_AGENT_DIR=${shellQuote(ctx.configDir)}`,
		`PI_ARTIFACT_PROJECT_ROOT=${shellQuote(join(ctx.tmpRoot, "artifacts"))}`,
		`PI_SUBAGENT_TRACE_LOG=${shellQuote(tracePath)}`,
	].join(" ");
	const args = [
		"pi",
		"--model",
		shellQuote(model),
		"--no-approve",
		"--no-extensions",
		"-e",
		shellQuote(extensionSource),
		"--session-dir",
		shellQuote(ctx.sessionDir),
		"--no-context-files",
	].join(" ");
	return `cd ${shellQuote(ctx.workDir)} && env ${unset} ${env} ${args}`;
}

async function waitForStartup(parentPane, workDir) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const screen = getScreen(parentPane);
		if (
			screen.includes("escape interrupt") ||
			screen.includes("Model scope:") ||
			screen.includes("ctrl+o") ||
			(screen.includes(workDir) && /\d+(?:\.\d+)?%\/\d+[kKmM]/.test(screen))
		) {
			return;
		}
		await sleep(POLL_MS);
	}
	throw new Error(`Parent Pi did not start:\n${getScreen(parentPane)}`);
}

async function submitPrompt(ctx, parentPane, marker) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		runHerdr(["pane", "send-keys", parentPane, "Enter"]);
		const settle = Date.now() + 8_000;
		while (Date.now() < settle) {
			await sleep(POLL_MS);
			const parent = findParentSession(ctx.sessionDir, marker);
			if (parent?.events.some((event) => event.type === "message" && event.message?.role === "assistant")) return;
		}
	}
	throw new Error("Parent never submitted the live prompt.");
}

async function runLive(ctx, model) {
	const token = `${Date.now()}-${process.pid}`;
	const marker = `LIVE_HERDR_TIMEOUT_WRAP_UP_DONE_${token}`;
	const agentName = `live-timeout-wrap-up-${process.pid}`;
	const childName = `herdr-timeout-child-${process.pid}`;
	const labels = [marker, agentName, childName];
	const observedChildPanes = new Set();
	let parentPane = "";
	let parentTab = "";
	writeProbe(ctx, agentName);

	try {
		const created = herdrResult("tab create", [
			"tab",
			"create",
			"--cwd",
			ctx.workDir,
			"--label",
			marker,
			"--no-focus",
		]);
		parentPane = created.root_pane?.pane_id ?? created.pane?.pane_id ?? "";
		parentTab = created.tab?.tab_id ?? "";
		if (!parentPane || !parentTab) throw new Error(`Herdr did not create the parent surface: ${JSON.stringify(created)}`);

		const command = buildParentCommand(ctx, model, join(ctx.tmpRoot, "trace.log"));
		runHerdr(["pane", "run", parentPane, command]);
		await waitForStartup(parentPane, ctx.workDir);
		const prompt =
			`Call subagent with name "${childName}", agent "${agentName}", title "Live timeout wrap-up", task "Follow your exact built-in instructions.". ` +
			`After it returns, reply exactly "${marker}".`;
		runHerdr(["pane", "send-text", parentPane, prompt]);
		await sleep(500);
		await submitPrompt(ctx, parentPane, marker);

		const deadline = Date.now() + RUN_TIMEOUT_MS;
		let finalParent;
		let finalResult;
		while (Date.now() < deadline) {
			for (const pane of listPanes()) {
				if (pane?.pane_id !== parentPane && paneMatches(pane, childName, agentName)) {
					observedChildPanes.add(pane.pane_id);
				}
			}
			const parent = findParentSession(ctx.sessionDir, marker);
			const result = parent ? getSubagentResult(parent.events) : undefined;
			if (parent && result?.details?.status === "completed" && getAssistantTexts(parent.events).includes(marker)) {
				finalParent = parent;
				finalResult = result;
				break;
			}
			if (result?.details?.status === "failed" || result?.details?.status === "cancelled") {
				throw new Error(`Interactive child failed: ${JSON.stringify(result.details)}`);
			}
			await sleep(POLL_MS);
		}
		if (!finalParent || !finalResult) {
			throw new Error(`Timed out waiting for interactive wrap-up. Parent screen:\n${getScreen(parentPane)}`);
		}

		const details = finalResult.details;
		if (details.mode !== "interactive" || details.deliveryState !== "awaited") {
			throw new Error(`Unexpected interactive result shape: ${JSON.stringify(details)}`);
		}
		if (
			details.timeoutWrapUp?.kind !== "timeout" ||
			details.timeoutWrapUp?.seconds !== 60 ||
			details.timeoutWrapUp?.threshold !== 50
		) {
			throw new Error(`Missing interactive wrap-up metadata: ${JSON.stringify(details.timeoutWrapUp)}`);
		}
		if (details.timedOut !== undefined || details.elapsed < 29 || details.elapsed >= 60) {
			throw new Error(`Interactive wrap-up missed its original clock: ${JSON.stringify(details)}`);
		}
		if (observedChildPanes.size < 2) {
			throw new Error(`Expected the blocked pane and a replacement wrap-up pane, observed ${[...observedChildPanes]}`);
		}
		const child = findChildSession(ctx.sessionDir, childName);
		if (!child || child.file !== details.sessionFile) throw new Error("The replacement did not continue the same session.");
		const userText = getText(child.events, "user");
		if (!userText.includes("interrupted your previous active operation")) {
			throw new Error("The replacement pane never received the report-only prompt.");
		}
		if (!getAssistantTexts(child.events).some((text) => text.length > 0)) {
			throw new Error("The replacement pane produced no report.");
		}
		const toolCount = Number(readFileSync(join(ctx.snapshotsDir, "tool-count"), "utf8"));
		if (toolCount !== 1) throw new Error(`The blocked tool executed ${toolCount} times instead of once.`);
		await sleep(1500);
		if (listPanes().some((pane) => paneMatches(pane, childName, agentName))) {
			throw new Error("A child pane remained after the report-only continuation completed.");
		}
		console.log(
			`live Herdr timeout wrap-up ok: closed blocked pane, opened report pane, and completed in ${details.elapsed}s ` +
			`inside the original 60s clock (${model})`,
		);
	} finally {
		sweepTabs(labels);
		closeQuiet("tab", parentTab);
		closeQuiet("pane", parentPane);
	}
}

async function main() {
	if (process.env[OPT_IN_ENV] !== "1" || !process.env[LIVE_MODEL_ENV]) {
		console.log(
			`SKIP ${SCRIPT_NAME}: set ${OPT_IN_ENV}=1 and ${LIVE_MODEL_ENV}=provider/model[:thinking]. No Herdr surfaces were created.`,
		);
		return;
	}
	requireHerdr();
	const releaseLock = acquireLiveWindowLock(SCRIPT_NAME);
	const ctx = createContext();
	try {
		await runLive(ctx, process.env[LIVE_MODEL_ENV]);
	} finally {
		releaseLock();
		if (process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1") console.error(`kept temp dir: ${ctx.tmpRoot}`);
		else rmSync(ctx.tmpRoot, { recursive: true, force: true });
	}
}

await main();
