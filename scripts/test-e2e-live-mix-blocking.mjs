#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { installLiveTestCleanup } from "./live-test-cleanup.mjs";
import { acquireLiveWindowLock, LIVE_TEST_MODEL, requireLiveWindowOptIn } from "./live-test-guard.mjs";

const piBin = process.env.PI_E2E_PI_BIN ?? "pi";

requireLiveWindowOptIn("test-e2e-live-mix-blocking");
const releaseLiveWindowLock = acquireLiveWindowLock("test-e2e-live-mix-blocking");
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagents-live-mix-"));
const tmuxSocket = join(tmpRoot, "tmux.sock");
const tmuxConfig = join(tmpRoot, "tmux.conf");
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const workDir = join(tmpRoot, "work");
const sourceConfigDir = join(homedir(), ".pi", "agent");
const tmuxSession = `pi-live-mix-${process.pid}`;
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
const deadline = Date.now() + 240_000;
const liveAgentModel = LIVE_TEST_MODEL.split(":")[0];
const parentSystemPrompt = [
	"You are running an automated live test.",
	"Follow the user-specified tool sequence literally.",
	"When instructed to reply with an exact marker, your entire assistant message must be only that marker: no preface, no summary, no markdown, no quotes, no extra lines.",
	"Do not start extra tools or extra subagents beyond the requested sequence.",
].join(" ");
const prompt = [
	"The subagent tool is available in this session.",
	"Use exactly this sequence in one assistant message/tool-call batch before replying.",
	'First call subagent with agent: "live-e2e-mix-async-a", name: "mix-async-a", title: "Mix async A smoke test", task: "Follow your exact built-in instructions.".',
	'Second call subagent with agent: "live-e2e-mix-blocking", name: "mix-blocking-child", title: "Mix blocking child smoke test", task: "Follow your exact built-in instructions.".',
	'Third call subagent with agent: "live-e2e-mix-async-b", name: "mix-async-b", title: "Mix async B smoke test", task: "Follow your exact built-in instructions.".',
	'After all three tools return, reply with exactly "LIVE_E2E_MIX_OK" and nothing else.',
	"Do not call any other tools.",
].join(" ");

mkdirSync(sessionDir, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(join(workDir, ".pi", "agents"), { recursive: true });
writeFileSync(tmuxConfig, "set -g extended-keys on\n", "utf8");
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
	const source = join(sourceConfigDir, name);
	if (existsSync(source)) copyFileSync(source, join(configDir, name));
}
writeFileSync(
	join(workDir, ".pi", "agents", "live-e2e-mix-async-a.md"),
	`---\nname: live-e2e-mix-async-a\ndescription: Live async mix smoke test agent A.\nmodel: ${liveAgentModel}\nthinking: high\nsystem-prompt: replace\nauto-exit: true\nmode: background\nspawning: false\nextensions: none\ntools: bash\n---\n\nFirst run a bash command exactly \`sleep 2\`.\nThen reply with exactly \`LIVE_MIX_ASYNC_A_OK\`.`,
	"utf8",
);
writeFileSync(
	join(workDir, ".pi", "agents", "live-e2e-mix-async-b.md"),
	`---\nname: live-e2e-mix-async-b\ndescription: Live async mix smoke test agent B.\nmodel: ${liveAgentModel}\nthinking: high\nsystem-prompt: replace\nauto-exit: true\nmode: background\nspawning: false\nextensions: none\ntools: bash\n---\n\nFirst run a bash command exactly \`sleep 6\`.\nThen reply with exactly \`LIVE_MIX_ASYNC_B_OK\`.`,
	"utf8",
);
writeFileSync(
	join(workDir, ".pi", "agents", "live-e2e-mix-blocking.md"),
	`---\nname: live-e2e-mix-blocking\ndescription: Live blocking mix smoke test agent.\nmodel: ${liveAgentModel}\nthinking: high\nsystem-prompt: replace\nauto-exit: true\nmode: interactive\nasync: false\nspawning: false\nextensions: none\ntools: bash\n---\n\nFirst run a bash command exactly \`sleep 4\`. Do not call read_artifact or any other tool.\nThen reply with exactly \`LIVE_MIX_BLOCKING_OK\`.`,
	"utf8",
);

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function execTmux(args, options = {}) {
	return execFileSync("tmux", ["-S", tmuxSocket, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	}).trim();
}

function hasTmuxSession() {
	try {
		execTmux(["has-session", "-t", tmuxSession]);
		return true;
	} catch {
		return false;
	}
}

function listJsonlFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...listJsonlFiles(fullPath));
			continue;
		}
		if (entry.isFile() && fullPath.endsWith(".jsonl")) files.push(fullPath);
	}
	return files;
}

function parseJsonl(file) {
	const events = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
	return events;
}

function getUserText(events) {
	return events
		.filter((event) => event.type === "message" && event.message?.role === "user")
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

function findAssistantTextEvent(events, text) {
	return events.find(
		(event) =>
			event.type === "message" &&
			event.message?.role === "assistant" &&
			(event.message.content ?? []).some((part) => part.type === "text" && part.text.trim() === text),
	);
}

function findLastAssistantTextEvent(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type !== "message" || event.message?.role !== "assistant") continue;
		const textPart = (event.message.content ?? []).find((part) => part.type === "text" && part.text.trim().length > 0);
		if (textPart) return event;
	}
	return null;
}

function getSubagentResults(events) {
	return events
		.filter(
			(event) =>
				event.type === "message" && event.message?.role === "toolResult" && event.message.toolName === "subagent",
		)
		.map((event) => event.message);
}

function getParentEvents() {
	for (const file of listJsonlFiles(sessionDir)) {
		const events = parseJsonl(file);
		if (getUserText(events).includes("LIVE_E2E_MIX_OK")) {
			return { file, events };
		}
	}
	return null;
}

function getPaneSnapshot() {
	try {
		return execTmux([
			"list-panes",
			"-a",
			"-F",
			"#{session_name} #{window_index}.#{pane_index} #{pane_current_command}",
		]);
	} catch {
		return "";
	}
}

function getCapture() {
	try {
		return execTmux(["capture-pane", "-pt", `${tmuxSession}:0.0`]);
	} catch {
		return "";
	}
}

async function waitForPaneCountAtMost(expectedMax, timeoutMs = 15_000) {
	const paneDeadline = Date.now() + timeoutMs;
	while (Date.now() < paneDeadline) {
		if (!hasTmuxSession()) return true;
		try {
			const paneCount = execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
				.split("\n")
				.filter(Boolean).length;
			if (paneCount <= expectedMax) return true;
		} catch {
			if (!hasTmuxSession()) return true;
		}
		await sleep(250);
	}
	return false;
}

async function waitForPath(path, timeoutMs = 15_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (path && existsSync(path)) return true;
		await sleep(250);
	}
	return !!path && existsSync(path);
}

const piCommand = [
	"PI_PACKAGE_DIR=",
	`PI_SUBAGENT_PI_COMMAND=${shellQuote(piBin)}`,
	`PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
	piBin,
	`--model ${LIVE_TEST_MODEL}`,
	"--append-system-prompt",
	shellQuote(parentSystemPrompt),
	"--no-extensions",
	`-e ${shellQuote(extensionSource)}`,
	`--session-dir ${shellQuote(sessionDir)}`,
	shellQuote(prompt),
].join(" ");

const launchCommand = [
	`cd ${shellQuote(repoRoot)}`,
	`exec tmux -S ${shellQuote(tmuxSocket)} -f ${shellQuote(tmuxConfig)} new-session -A -s ${shellQuote(tmuxSession)} ${shellQuote(`cd ${workDir} && env -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AUTO_EXIT -u PI_DENY_TOOLS -u PI_PACKAGE_DIR -u PI_ARTIFACT_PROJECT_ROOT PI_SUBAGENT_MUX=tmux ${piCommand}`)}`,
].join(" && ");

const ghostty = spawn("ghostty", ["-e", "bash", "-lc", launchCommand], {
	cwd: repoRoot,
	stdio: "ignore",
	env: (() => {
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_SUBAGENT_") || key === "PI_DENY_TOOLS" || key === "PI_ARTIFACT_PROJECT_ROOT") {
				delete env[key];
			}
		}
		return env;
	})(),
});
ghostty.unref();

const cleanup = installLiveTestCleanup({
	hasTmuxSession,
	execTmux,
	tmuxSession,
	ghostty,
	releaseLiveWindowLock,
	keepTmp,
	tmpRoot,
	keepLabel: "kept live mix temp dir",
});

let sawBlockingPane = false;
let verified = false;

try {
	while (Date.now() < deadline) {
		const sessionAlive = hasTmuxSession();
		if (sessionAlive) {
			try {
				const paneCount = execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"])
					.split("\n")
					.filter(Boolean).length;
				if (paneCount >= 2) sawBlockingPane = true;
			} catch {}
		}

		const parent = getParentEvents();
		if (!parent) {
			await sleep(500);
			continue;
		}

		const assistantTexts = getAssistantTexts(parent.events);
		const subagentResults = getSubagentResults(parent.events);
		const asyncA = subagentResults.find((message) => message.details?.name === "mix-async-a");
		const asyncB = subagentResults.find((message) => message.details?.name === "mix-async-b");
		const blocking = subagentResults.find((message) => message.details?.name === "mix-blocking-child");
		if (!asyncA || !asyncB || !blocking || !assistantTexts.includes("LIVE_E2E_MIX_OK")) {
			await sleep(500);
			continue;
		}

		const asyncADetails = asyncA.details ?? {};
		const asyncBDetails = asyncB.details ?? {};
		const blockingDetails = blocking.details ?? {};
		for (const details of [asyncADetails, asyncBDetails]) {
			if (details.status !== "completed" || details.deliveryState !== "awaited") {
				throw new Error("Expected async child in mixed batch to return awaited completed result.");
			}
			if (details.mode !== "background") {
				throw new Error("Expected async child to run in background mode.");
			}
			if (details.async !== true) {
				throw new Error("Expected async child metadata to remain non-blocking async.");
			}
		}
		if (
			blockingDetails.status !== "completed" ||
			blockingDetails.deliveryState !== "awaited" ||
			blockingDetails.async !== false
		) {
			throw new Error("Expected blocking child to return awaited completed result.");
		}
		if (!blockingDetails.sessionFile || !(await waitForPath(blockingDetails.sessionFile))) {
			throw new Error("Blocking child missing sessionFile.");
		}
		if (!asyncADetails.sessionFile || !(await waitForPath(asyncADetails.sessionFile))) {
			throw new Error("Async child A missing sessionFile.");
		}
		if (!asyncBDetails.sessionFile || !(await waitForPath(asyncBDetails.sessionFile))) {
			throw new Error("Async child B missing sessionFile.");
		}
		if (!sawBlockingPane) {
			throw new Error("Did not observe the interactive blocking child pane.");
		}

		const blockingLaunchEvent = parent.events.find(
			(event) =>
				event.type === "message" &&
				event.message?.role === "assistant" &&
				(event.message.content ?? []).some(
					(part) =>
						part.type === "toolCall" && part.name === "subagent" && part.arguments?.name === "mix-blocking-child",
				),
		);
		const blockingResultEvent = parent.events.find(
			(event) =>
				event.type === "message" &&
				event.message?.role === "toolResult" &&
				event.message.toolName === "subagent" &&
				event.message.details?.name === "mix-blocking-child",
		);
		const asyncAResultEvent = parent.events.find(
			(event) =>
				event.type === "message" &&
				event.message?.role === "toolResult" &&
				event.message.toolName === "subagent" &&
				event.message.details?.name === "mix-async-a",
		);
		const asyncBResultEvent = parent.events.find(
			(event) =>
				event.type === "message" &&
				event.message?.role === "toolResult" &&
				event.message.toolName === "subagent" &&
				event.message.details?.name === "mix-async-b",
		);
		const parentFinalEvent = findAssistantTextEvent(parent.events, "LIVE_E2E_MIX_OK");
		if (!blockingLaunchEvent || !blockingResultEvent || !asyncAResultEvent || !asyncBResultEvent || !parentFinalEvent) {
			throw new Error("Missing mixed launch/result/final parent events.");
		}

		const assistantDuringBlocking = parent.events.filter(
			(event) =>
				event.type === "message" &&
				event.message?.role === "assistant" &&
				event.timestamp > blockingLaunchEvent.timestamp &&
				event.timestamp < blockingResultEvent.timestamp,
		);
		if (assistantDuringBlocking.length > 0) {
			throw new Error("Parent did extra assistant work during the blocking turn.");
		}
		for (const resultEvent of [blockingResultEvent, asyncAResultEvent, asyncBResultEvent]) {
			if (parentFinalEvent.timestamp < resultEvent.timestamp) {
				throw new Error("Parent replied before every mixed-batch child completed.");
			}
		}

		const blockingEvents = parseJsonl(blockingDetails.sessionFile);
		if (!getAssistantTexts(blockingEvents).some((text) => text.includes("LIVE_MIX_BLOCKING_OK"))) {
			throw new Error("Blocking child did not finish correctly.");
		}

		while (Date.now() < deadline) {
			const asyncAEvents = parseJsonl(asyncADetails.sessionFile);
			const asyncBEvents = parseJsonl(asyncBDetails.sessionFile);
			const doneA =
				!!findAssistantTextEvent(asyncAEvents, "LIVE_MIX_ASYNC_A_OK") || !!findLastAssistantTextEvent(asyncAEvents);
			const doneB =
				!!findAssistantTextEvent(asyncBEvents, "LIVE_MIX_ASYNC_B_OK") || !!findLastAssistantTextEvent(asyncBEvents);
			if (doneA && doneB) break;
			await sleep(500);
		}

		const finalAsyncAEvents = parseJsonl(asyncADetails.sessionFile);
		const finalAsyncBEvents = parseJsonl(asyncBDetails.sessionFile);
		const asyncAFinalEvent =
			findAssistantTextEvent(finalAsyncAEvents, "LIVE_MIX_ASYNC_A_OK") ?? findLastAssistantTextEvent(finalAsyncAEvents);
		const asyncBFinalEvent =
			findAssistantTextEvent(finalAsyncBEvents, "LIVE_MIX_ASYNC_B_OK") ?? findLastAssistantTextEvent(finalAsyncBEvents);
		if (!asyncAFinalEvent) {
			throw new Error("Async child A never finished.");
		}
		if (!asyncBFinalEvent) {
			throw new Error("Async child B never finished.");
		}

		if (!(await waitForPaneCountAtMost(1))) {
			throw new Error("Async mix panes did not auto-close.");
		}

		verified = true;
		console.log(`live mix ok: ${blockingDetails.id}`);
		break;
	}

	if (!verified) {
		throw new Error(
			[
				"Timed out waiting for live mixed blocking verification.",
				`Prompt: ${prompt}`,
				`Panes:\n${getPaneSnapshot()}`,
				`Capture:\n${getCapture()}`,
			].join("\n\n"),
		);
	}
} finally {
	cleanup();
}
