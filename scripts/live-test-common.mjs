/**
 * Shared setup/teardown for live frontmatter verification tests.
 *
 * Creates a temporary agent config directory, copies user auth/settings/models,
 * and provides helpers to run pi -p commands and parse session files.
 *
 * Usage:
 *   import { setup, parseJsonl, runChild } from "./live-test-common.mjs";
 *
 *   const ctx = setup("my-test-name");
 *   try {
 *     runChild(ctx, agentName, prompt);
 *     // verify...
 *   } finally { ctx.cleanup(); }
 */

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

// Find the extension source and repo root from this script's location
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");

// Default live test model
const LIVE_TEST_MODEL = (() => {
	const model = process.env.PI_SUBAGENT_LIVE_MODEL;
	if (!model) throw new Error("PI_SUBAGENT_LIVE_MODEL must be set to run frontmatter live tests");
	return model;
})();

/**
 * Create a temp test context with config dir, sessions dir, agents dir, extensions dir.
 * Copies auth/settings/models from the user's real config.
 *
 * @param {string} label - A short label for the temp dir (e.g. "cwd-test")
 * @param {object} [options]
 * @param {string} [options.modelOverride] - Override the default live test model
 * @returns {{
 *   tmpRoot: string,
 *   configDir: string,
 *   agentsDir: string,
 *   extensionsDir: string,
 *   sessionDir: string,
 *   snapshotsDir: string,
 *   model: string,
 *   cleanup: () => void,
 *   keepTmp: boolean
 * }}
 */
export function setup(label, options = {}) {
	const tmpRoot = mkdtempSync(join(tmpdir(), `pi-fm-${label}-`));
	const configDir = join(tmpRoot, "agent");
	const agentsDir = join(configDir, "agents");
	const extensionsDir = join(configDir, "extensions");
	const sessionDir = join(tmpRoot, "sessions");
	const snapshotsDir = join(tmpRoot, "snapshots");
	const envConfigDir = process.env.PI_CODING_AGENT_DIR;
	const sourceConfigDir =
		envConfigDir && existsSync(join(envConfigDir, "auth.json")) ? envConfigDir : join(homedir(), ".pi", "agent");
	const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";
	const model = options.modelOverride ?? LIVE_TEST_MODEL;

	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	mkdirSync(snapshotsDir, { recursive: true });

	for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
		const source = join(sourceConfigDir, name);
		if (existsSync(source)) {
			copyFileSync(source, join(configDir, name));
		}
	}

	function cleanup() {
		if (keepTmp) {
			console.error(`kept temp dir: ${tmpRoot}`);
			return;
		}
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {}
	}

	return {
		tmpRoot,
		configDir,
		agentsDir,
		extensionsDir,
		sessionDir,
		snapshotsDir,
		model,
		cleanup,
		keepTmp,
	};
}

/**
 * Write a child agent file in the agents dir.
 * @param {string} agentsDir
 * @param {string} name - Agent name (also used as filename: <name>.md)
 * @param {string} frontmatter - YAML frontmatter keys (without the --- delimiters)
 * @param {string} body - Agent body/instructions
 */
export function writeAgent(agentsDir, name, frontmatter, body) {
	const fmLines = Object.entries(frontmatter)
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	writeFileSync(join(agentsDir, `${name}.md`), `---\n${fmLines}\n---\n\n${body}`, "utf8");
}

/**
 * Write a child extension file that records tool snapshots.
 * The extension registers a snapshot hook that writes to an agent-named JSON file
 * in snapshotsDir.
 *
 * @param {string} path - Full file path for the extension
 * @param {string} snapshotsDir - Where to write snapshot JSON files
 */
export function writeSnapshotExtension(path, snapshotsDir) {
	writeFileSync(
		path,
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "snapshot_self",
    label: "Snapshot Probe",
    description: "Snapshot the active tool set",
    parameters: Type.Object({}),
    async execute() {
      const outDir = ${JSON.stringify(snapshotsDir)};
      const agent = process.env.PI_SUBAGENT_AGENT ?? "unknown";
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, agent + ".json"),
        JSON.stringify({
          phase: "tool_call",
          agent,
          model: process.env.PI_SUBAGENT_MODEL ?? "",
          active: pi.getActiveTools(),
          all: pi.getAllTools().map((t) => t.name),
        }, null, 2),
        "utf8",
      );
      return { content: [{ type: "text", text: "SNAPSHOT_OK" }], details: {} };
    },
  });

  pi.registerTool({
    name: "check_tool_available",
    label: "Check Tool Available",
    description: "Check if a tool is available in this session",
    parameters: Type.Object({
      toolName: Type.String({ description: "Tool name to check" }),
    }),
    async execute(input) {
      const active = pi.getActiveTools();
      const available = active.includes(input.toolName);
      return {
        content: [{ type: "text", text: available ? "TOOL_AVAILABLE" : "TOOL_DENIED" }],
        details: { toolName: input.toolName, available },
      };
    },
  });

  pi.on("session_start", () => {
    const agent = process.env.PI_SUBAGENT_AGENT;
    if (!agent) return;
    const outDir = ${JSON.stringify(snapshotsDir)};
    setTimeout(() => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, agent + ".session-start.json"),
        JSON.stringify({
          phase: "session_start",
          agent,
          active: pi.getActiveTools(),
          all: pi.getAllTools().map((t) => t.name),
        }, null, 2),
        "utf8",
      );
    }, 0);
  });
}
`,
		"utf8",
	);
}

/**
 * Run a pi -p (headless) session with the given setup and prompt.
 *
 * @param {object} ctx - The context from setup()
 * @param {string} prompt - The user prompt text
 * @param {object} [extraEnv] - Extra env vars for the child
 * @returns {string} stdout from pi
 */
export function runPi(ctx, prompt, extraEnv = {}) {
	const envOverride = {
		...process.env,
		PI_PACKAGE_DIR: "",
		PI_CODING_AGENT_DIR: ctx.configDir,
		PI_SUBAGENT_AGENT: "",
		PI_SUBAGENT_NAME: "",
		PI_SUBAGENT_AUTO_EXIT: "",
		PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS: "1",
		PI_SUBAGENT_EXTENSIONS: "",
		PI_DENY_TOOLS: "",
		PI_ARTIFACT_PROJECT_ROOT: "",
		...extraEnv,
	};

	return execFileSync(
		"pi",
		["-p", "--model", ctx.model, "--no-extensions", "-e", extensionSource, "--session-dir", ctx.sessionDir, prompt],
		{
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: envOverride,
		},
	);
}

/**
 * Parse a JSONL session file into an array of events.
 * @param {string} file
 * @returns {Array<object>}
 */
export function parseJsonl(file) {
	if (!existsSync(file)) return [];
	const events = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			events.push(JSON.parse(line));
		} catch {}
	}
	return events;
}

/**
 * Recursively list .jsonl files in a directory.
 */
export function listJsonlFiles(dir) {
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

/**
 * Get all user text from session events.
 */
export function getUserText(events) {
	return events
		.filter((e) => e.type === "message" && e.message?.role === "user")
		.flatMap((e) => e.message.content ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

/**
 * Get all assistant text from session events.
 */
export function getAssistantTexts(events) {
	return events
		.filter((e) => e.type === "message" && e.message?.role === "assistant")
		.flatMap((e) => e.message.content ?? [])
		.filter((p) => p.type === "text")
		.map((p) => p.text.trim());
}

/**
 * Get all tool results for a given tool name.
 */
export function getToolResults(events, toolName) {
	return events
		.filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message.toolName === toolName)
		.map((e) => e.message);
}

/**
 * Get the session header entry from events.
 */
export function getSessionHeader(events) {
	return events.find((e) => e.type === "session");
}

/**
 * Get all child results from subagent results, handling both batch and individual.
 * Returns an array of child detail objects.
 */
export function getAllSubagentChildren(events) {
	const results = getToolResults(events, "subagent");
	const children = [];
	for (const r of results) {
		const d = r.details ?? {};
		if (d.status === "batch" && Array.isArray(d.children)) {
			children.push(...d.children);
		} else if (d.name || d.agent) {
			children.push(d);
		}
	}
	return children;
}
