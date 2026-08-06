import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getEntries } from "../../src/session/session.ts";

export function createTestDir(): string {
	return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

export function createSessionFile(dir: string, entries: object[]): string {
	const file = join(dir, "test-session.jsonl");
	const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
	writeFileSync(file, content);
	return file;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function writeExecutable(dir: string, name: string, content: string): string {
	const file = join(dir, name);
	writeFileSync(file, content);
	chmodSync(file, 0o755);
	return file;
}

export function getAgentConfigDirForTest(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function resolveSubagentCwdForTest(rawCwd: string | null, baseCwd = process.cwd()): string {
	if (!rawCwd) return baseCwd;
	return rawCwd.startsWith("/") ? rawCwd : join(baseCwd, rawCwd);
}

export function _loadAgentDefaultsForTest(agentName: string, cwdHint?: string | null) {
	const baseCwd = resolveSubagentCwdForTest(cwdHint ?? null);
	const configDir = getAgentConfigDirForTest();
	const paths = [
		{
			path: join(baseCwd, ".pi", "agents", `${agentName}.md`),
			cwdBase: baseCwd,
		},
		{ path: join(configDir, "agents", `${agentName}.md`), cwdBase: configDir },
	];
	for (const { path, cwdBase } of paths) {
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf8");
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match) continue;
		const frontmatter = match[1];
		const get = (key: string) => {
			const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
			return m ? m[1].trim() : undefined;
		};
		const systemPromptRaw = get("system-prompt");
		const noContextFilesRaw = get("no-context-files");
		const noSessionRaw = get("no-session");
		const extensionsRaw = get("extensions");
		const modeRaw = get("mode");
		return {
			systemPromptMode: systemPromptRaw === "append" || systemPromptRaw === "replace" ? systemPromptRaw : undefined,
			cwd: get("cwd"),
			cwdBase,
			extensions: extensionsRaw,
			noContextFiles: noContextFilesRaw === "true" ? true : noContextFilesRaw === "false" ? false : undefined,
			noSession: noSessionRaw === "true" ? true : noSessionRaw === "false" ? false : undefined,
			mode: modeRaw === "background" || modeRaw === "interactive" ? modeRaw : undefined,
		};
	}
	return null;
}

export function createForkSessionFileForTest(parentSessionFile: string, childSessionFile: string): void {
	const entries = getEntries(parentSessionFile) as any[];
	let truncateAt = entries.length;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message?.role === "user") {
			truncateAt = i;
			break;
		}
	}
	const cleanEntries = entries.slice(0, truncateAt);
	const contentEntries = cleanEntries.filter((entry) => entry?.type !== "session");
	const header = {
		type: "session",
		version: 3,
		id: `child-${Date.now()}`,
		timestamp: new Date().toISOString(),
		cwd: process.cwd(),
		parentSession: parentSessionFile,
	};
	writeFileSync(childSessionFile, `${[header, ...contentEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

export const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
export const MODEL_CHANGE = {
	type: "model_change",
	id: "mc-001",
	parentId: null,
};
export const USER_MSG = {
	type: "message",
	id: "user-001",
	parentId: "mc-001",
	message: {
		role: "user",
		content: [{ type: "text", text: "Hello, sketch something" }],
	},
};
export const ASSISTANT_MSG = {
	type: "message",
	id: "asst-001",
	parentId: "user-001",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "Here is my outline..." }],
	},
};
export const ASSISTANT_MSG_2 = {
	type: "message",
	id: "asst-002",
	parentId: "asst-001",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Let me think..." },
			{ type: "text", text: "Updated outline with details." },
		],
	},
};
export const TOOL_RESULT = {
	type: "message",
	id: "tool-001",
	parentId: "asst-001",
	message: {
		role: "toolResult",
		toolCallId: "tc-001",
		toolName: "bash",
		content: [{ type: "text", text: "output here" }],
	},
};
