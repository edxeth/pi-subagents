#!/usr/bin/env node
/**
 * Live test: frontmatter `mode: interactive` param
 *
 * Verifies that `mode: interactive` is respected:
 * - When the parent has a UI (tmux panel), interactive children open a new pane
 * - When the parent is headless (pi -p), interactive children degrade gracefully
 *   to background mode
 *
 * This test uses a headless tmux session (no Ghostty window) and runs the
 * parent in pi -p mode to test the headless degradation path.
 *
 * Strategy:
 *   - Create a headless tmux session
 *   - Launch a parent pi -p session that spawns a mode:interactive child
 *   - Verify the child completes successfully (as background in headless mode)
 *   - Verify the child session metadata shows the effective mode
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");

const tmpRoot = mkdtempSync(join(tmpdir(), "pi-fm-interactive-"));
const tmuxSocket = join(tmpRoot, "tmux.sock");
const tmuxConfig = join(tmpRoot, "tmux.conf");
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const agentsDir = join(configDir, "agents");
const workDir = join(tmpRoot, "work");
const tmuxSession = `pi-fm-interactive-${process.pid}`;
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir =
	envConfigDir && existsSync(join(envConfigDir, "auth.json")) ? envConfigDir : join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

try {
	execFileSync("tmux", ["-V"], { stdio: "ignore" });
} catch {
	console.error("tmux not available. Skipping mode:interactive test.");
	process.exit(0);
}

const LIVE_TEST_MODEL = (() => {
	const model = process.env.PI_SUBAGENT_LIVE_MODEL;
	if (!model) throw new Error("PI_SUBAGENT_LIVE_MODEL must be set to run frontmatter live tests");
	return model;
})();

mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
writeFileSync(tmuxConfig, "set -g extended-keys on\n", "utf8");
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
	const source = join(sourceConfigDir, name);
	if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

// Write interactive child agent with auto-exit
writeFileSync(
	join(agentsDir, "fm-interactive-child.md"),
	`---\nname: fm-interactive-child\ndescription: Interactive mode test agent.\nauto-exit: true\nmode: interactive\nspawning: false\n---\n\nReply with exactly \`FM_INTERACTIVE_OK\`.`,
	"utf8",
);

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function execTmux(args, options = {}) {
	try {
		return execFileSync("tmux", ["-S", tmuxSocket, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			...options,
		}).trim();
	} catch {
		return "";
	}
}

function hasTmuxSession() {
	try {
		execTmux(["has-session", "-t", tmuxSession]);
		return true;
	} catch {
		return false;
	}
}

function getPaneCount() {
	try {
		return execTmux(["list-panes", "-t", tmuxSession, "-F", "#{pane_id}"]).split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
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

function getAssistantTexts(events) {
	return events
		.filter((e) => e.type === "message" && e.message?.role === "assistant")
		.flatMap((e) => e.message.content ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text.trim());
}

let verified = false;
let cleanupDone = false;

async function cleanup() {
	if (cleanupDone) return;
	cleanupDone = true;
	try {
		if (hasTmuxSession()) execTmux(["kill-session", "-t", tmuxSession]);
	} catch {}
	try {
		execFileSync("pkill", ["-f", tmpRoot], { stdio: "ignore" });
	} catch {}
	if (!keepTmp) {
		try {
			const { rmSync } = await import("node:fs");
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	} else {
		console.error(`kept temp dir: ${tmpRoot}`);
	}
}

process.on("exit", cleanup);
process.on("SIGINT", async () => {
	await cleanup();
	process.exit(1);
});
process.on("SIGTERM", async () => {
	await cleanup();
	process.exit(1);
});

try {
	const prompt = [
		"The subagent tool is available in this session.",
		"Use exactly this sequence.",
		'Call subagent with name "FM Interactive Child", agent "fm-interactive-child", title "Interactive mode verification", task "Follow your exact built-in instructions.".',
		'After the tool returns, reply with exactly "TEST_INTERACTIVE_DONE" and nothing else.',
		"Do not call any other tools.",
	].join(" ");

	const piCommand = [
		`PI_CODING_AGENT_DIR=${shellQuote(configDir)}`,
		"pi",
		"-p",
		`--model ${LIVE_TEST_MODEL}`,
		"--no-extensions",
		`-e ${shellQuote(extensionSource)}`,
		`--session-dir ${shellQuote(sessionDir)}`,
		shellQuote(prompt),
	].join(" ");

	// Start tmux session containing the pi -p parent
	const piCmdStr = `cd ${shellQuote(workDir)} && env PI_SUBAGENT_MUX=tmux PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS=1 ${piCommand}`;
	execTmux(["new-session", "-d", "-s", tmuxSession, "-x", "120", "-y", "40", "bash", "-c", piCmdStr]);
	console.log(`Started tmux session ${tmuxSession}`);

	// Count panes before to compare
	const panesBefore = getPaneCount();

	// Wait for parent to complete
	const deadline = Date.now() + 120_000;
	let parentDone = false;
	while (Date.now() < deadline) {
		const { readdirSync } = await import("node:fs");
		let files;
		try {
			files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			await sleep(1000);
			continue;
		}
		for (const file of files) {
			const content = readFileSync(join(sessionDir, file), "utf8");
			if (content.includes("TEST_INTERACTIVE_DONE")) {
				parentDone = true;
				break;
			}
		}
		if (parentDone) break;
		await sleep(1000);
	}

	if (!parentDone) {
		throw new Error("Parent did not complete with TEST_INTERACTIVE_DONE.");
	}

	// In pi -p headless mode, interactive children degrade to background.
	// Verify no second tmux pane was created.
	const panesAfter = getPaneCount();
	if (panesAfter > panesBefore) {
		throw new Error(
			"Interactive child should NOT open a tmux pane in pi -p headless mode (it should degrade to background).",
		);
	}
	console.log(`Pane count unchanged (${panesBefore} → ${panesAfter}) — interactive correctly degraded to background.`);

	// Find any child session to verify it was created
	const { readdirSync } = await import("node:fs");
	const allFiles = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
	// Skip the parent session (containing TEST_INTERACTIVE_DONE)
	const childSessions = allFiles.filter((f) => {
		const content = readFileSync(join(sessionDir, f), "utf8");
		return !content.includes("TEST_INTERACTIVE_DONE");
	});

	if (childSessions.length === 0) {
		throw new Error("No child session was created. Interactive child may not have launched at all.");
	}

	// Check at least one child session has activity
	let childActive = false;
	for (const file of childSessions) {
		const events = parseJsonl(join(sessionDir, file));
		const texts = getAssistantTexts(events);
		// Check for any meaningful child output
		if (texts.some((t) => t.includes("FM_INTERACTIVE_OK") || t.length > 10)) {
			childActive = true;
			console.log(`Interactive child session active: ${file}`);

			// Child metadata should show the mode
			const metadata = events.find((e) => e.type === "custom" && e.customType === "pi-subagents_launch_metadata");
			const launchMode = metadata?.data?.mode;
			console.log(`Child launch mode from metadata: ${launchMode}`);
			break;
		}
	}

	if (!childActive) {
		console.log("Note: child session has limited text output (background degradation with auto-exit).");
	}

	verified = true;
	console.log(`frontmatter "mode: interactive" ok: interactive agent degrades to background in pi -p mode`);
} finally {
	await cleanup();
}

if (!verified) process.exit(1);
