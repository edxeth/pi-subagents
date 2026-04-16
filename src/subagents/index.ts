import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text } from "@mariozechner/pi-tui";
import { basename, dirname, join } from "node:path";
import {
	readdirSync,
	statSync,
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import {
	isMuxAvailable,
	muxSetupHint,
	createSurface,
	sendCommand,
	interruptSurface,
	pollForExit,
	consumeSubagentExitSignal,
	closeSurface,
	shellEscape,
	exitStatusVar,
	renameCurrentTab,
	renameWorkspace,
} from "./mux.ts";
import {
	getEntries,
	getEntryCount,
	getNewEntries,
	findLastAssistantMessage,
} from "./session.ts";
import { getSessionArtifactDir, resolveArtifactProjectRoot } from "../shared/artifacts.ts";
import type {
	CompletedSubagentResult,
	DeliveryState,
	DetachParams,
	JoinParams,
	ParentClosePolicy,
	ParentShutdownAction,
	ResumeToolDetails,
	RunningSubagent,
	SessionEntryLike,
	StartedSubagentToolDetails,
	SubagentParamsInput,
	SubagentPingMessageDetails,
	SubagentResult,
	SubagentResultMessageDetails,
	SubagentsListToolDetails,
	SubagentCompletionStatus,
	SyncSubagentToolDetails,
	WaitParams,
} from "./runtime-types.ts";
import { SubagentWidgetManager } from "./widget.ts";

const SubagentParams = Type.Object({
	name: Type.String({ description: "Display name for the subagent" }),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	agent: Type.String({
		description:
			"Required agent definition name. Reads .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md and refuses ad-hoc unnamed subagents.",
	}),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Extra role instructions appended before the task body. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model override. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	skills: Type.Optional(
		Type.String({
			description:
				"Comma-separated skills. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	tools: Type.Optional(
		Type.String({
			description:
				"Comma-separated tools. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Working directory for the sub-agent. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	fork: Type.Optional(
		Type.Boolean({
			description:
				"Fork the current session. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run headlessly without a terminal pane. Ignored when agent is selected; frontmatter wins.",
		}),
	),
	blocking: Type.Optional(
		Type.Boolean({
			description:
				"Block on this child by waiting for completion before the tool returns. Agent frontmatter may force this on or off.",
		}),
	),
	parentClosePolicy: Type.Optional(
		Type.Union([
			Type.Literal("terminate"),
			Type.Literal("cancel"),
			Type.Literal("abandon"),
		], {
			description:
				"How this child should be handled if the parent session closes. Defaults to terminate.",
		}),
	),
});

const SubagentKillParams = Type.Object({
	id: Type.String({
		description: "Running subagent id or display name to stop",
	}),
});

const SubagentWaitParams = Type.Object({
	id: Type.String({
		description: "Child id to wait for",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds",
		}),
	),
	onTimeout: Type.Optional(
		Type.Union([
			Type.Literal("error"),
			Type.Literal("return_pending"),
		], {
			description:
				"How to handle a timeout. Defaults to error.",
		}),
	),
});

const SubagentJoinParams = Type.Object({
	ids: Type.Array(Type.String({ description: "Child id to join" }), {
		description: "Child ids to join",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds",
		}),
	),
	onTimeout: Type.Optional(
		Type.Union([
			Type.Literal("error"),
			Type.Literal("return_partial"),
		], {
			description:
				"How to handle a timeout. Defaults to error.",
		}),
	),
});

const SubagentDetachParams = Type.Object({
	id: Type.String({
		description: "Child id to detach",
	}),
});

interface AgentDefaults {
	enabled?: boolean;
	model?: string;
	tools?: string;
	skills?: string;
	thinking?: string;
	denyTools?: string;
	spawning?: boolean;
	autoExit?: boolean;
	systemPromptMode?: "append" | "replace";
	cwd?: string;
	cwdBase?: string;
	path?: string;
	body?: string;
	mode?: "interactive" | "background";
	fork?: boolean;
	blocking?: boolean;
	timeout?: number;
}

interface ResolvedAgentDefinition extends AgentDefaults {
	name: string;
	description?: string;
	source: "project" | "global";
	path: string;
}

interface SubagentCatalogEntry {
	name: string;
	source: "project" | "global";
	mode?: "interactive" | "background";
	description?: string;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
	"subagent",
	"subagents_list",
	"subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
	const denied = new Set<string>();
	if (!agentDefs) return denied;

	// spawning: false → deny all spawning tools
	if (agentDefs.spawning === false) {
		for (const t of SPAWNING_TOOLS) denied.add(t);
	}

	// deny-tools: explicit list
	if (agentDefs.denyTools) {
		for (const t of agentDefs.denyTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)) {
			denied.add(t);
		}
	}

	return denied;
}

export function getAgentConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function parseAgentDefinition(
	path: string,
	source: "project" | "global",
	cwdBase: string,
): ResolvedAgentDefinition | null {
	const content = readFileSync(path, "utf8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return null;
	const frontmatter = match[1];
	const get = (key: string) => {
		const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		return m ? m[1].trim() : undefined;
	};
	const enabledRaw = get("enabled");
	if (enabledRaw === "false") return null;
	const spawningRaw = get("spawning");
	const autoExitRaw = get("auto-exit");
	const modeRaw = get("mode");
	const forkRaw = get("fork");
	const blockingRaw = get("blocking");
	const timeoutRaw = get("timeout");
	const systemPromptRaw = get("system-prompt");
	const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	return {
		name: get("name") ?? basename(path, ".md"),
		description: get("description"),
		source,
		path,
		enabled: enabledRaw != null ? enabledRaw === "true" : undefined,
		model: get("model"),
		tools: get("tools"),
		skills: get("skills"),
		thinking: get("thinking"),
		denyTools: get("deny-tools"),
		spawning: spawningRaw != null ? spawningRaw === "true" : undefined,
		autoExit: autoExitRaw != null ? autoExitRaw === "true" : undefined,
		systemPromptMode:
			systemPromptRaw === "append" || systemPromptRaw === "replace"
				? systemPromptRaw
				: undefined,
		cwd: get("cwd"),
		cwdBase,
		body: body || undefined,
		fork: forkRaw != null ? forkRaw === "true" : undefined,
		blocking: blockingRaw != null ? blockingRaw === "true" : undefined,
		mode:
			modeRaw === "background" || modeRaw === "interactive"
				? modeRaw
				: undefined,
		timeout: timeoutRaw != null ? parseInt(timeoutRaw, 10) : undefined,
	};
}

function getEffectiveAgentDefinitions(baseCwd = process.cwd()): ResolvedAgentDefinition[] {
	const configDir = getAgentConfigDir();
	const agents = new Map<string, ResolvedAgentDefinition>();
	const dirs = [
		{ path: join(configDir, "agents"), source: "global" as const, cwdBase: configDir },
		{ path: join(baseCwd, ".pi", "agents"), source: "project" as const, cwdBase: baseCwd },
	];
	for (const { path: dir, source, cwdBase } of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)
			.filter((entry) => entry.endsWith(".md"))
			.sort((a, b) => a.localeCompare(b))) {
			const definition = parseAgentDefinition(join(dir, file), source, cwdBase);
			if (!definition) continue;
			agents.set(definition.name, definition);
		}
	}
	return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getEffectiveAgentDefinitionsForTest(baseCwd = process.cwd()) {
	return getEffectiveAgentDefinitions(baseCwd);
}

function getAmbientCatalogEntries(baseCwd = process.cwd()): SubagentCatalogEntry[] {
	return getEffectiveAgentDefinitions(baseCwd)
		.filter((agent) => agent.description?.trim())
		.map((agent) => ({
			name: agent.name,
			source: agent.source,
			mode: agent.mode,
			description: agent.description,
		}));
}

function isAmbientAwarenessDisabled(): boolean {
	return process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS === "1";
}

export function getAmbientCatalogEntriesForTest(baseCwd = process.cwd()) {
	return getAmbientCatalogEntries(baseCwd);
}

function renderSubagentCatalogReminder(entries: SubagentCatalogEntry[]): string {
	const lines = entries.map((entry) => {
		const modeTag = entry.mode === "background" ? " (background)" : "";
		return `- ${entry.name}${modeTag} — ${entry.description}`;
	});
	const body = [
		"Available named subagents:",
		...lines,
		"Any newer catalog snapshot supersedes older catalog snapshots. Use subagent explicitly.",
		"Launch independent children in parallel whenever possible; to do that, use a single message with multiple subagent tool calls.",
	].join("\n");
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

export function renderSubagentCatalogReminderForTest(entries: SubagentCatalogEntry[]) {
	return renderSubagentCatalogReminder(entries);
}

function getSubagentCatalogSignature(entries: SubagentCatalogEntry[]): string {
	return JSON.stringify(
		entries.map((entry) => ({
			name: entry.name,
			source: entry.source,
			mode: entry.mode,
			description: entry.description,
		})),
	);
}

export function getSubagentCatalogSignatureForTest(entries: SubagentCatalogEntry[]) {
	return getSubagentCatalogSignature(entries);
}

export function loadAgentDefaults(
	agentName: string,
	cwdHint?: string | null,
	baseCwd = process.cwd(),
): AgentDefaults | null {
	const resolvedBaseCwd = resolveSubagentCwd(cwdHint ?? null, baseCwd);
	return (
		getEffectiveAgentDefinitions(resolvedBaseCwd).find((agent) => agent.name === agentName) ??
		null
	);
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m ${s}s`;
}

export function getTerminalAssistantSummaryForTest(
	entries: SessionEntryLike[],
): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") return null;
		if (message.stopReason === "toolUse") return null;
		const texts = (message.content ?? [])
			.filter(
				(block) =>
					block.type === "text" &&
					typeof block.text === "string" &&
					block.text.trim() !== "",
			)
			.map((block) => block.text as string);
		return texts.length > 0 ? texts.join("\n") : null;
	}
	return null;
}

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
	if (kind === "tab-title") {
		return {
			content: [
				{
					type: "text" as const,
					text: `Terminal multiplexer not available. ${muxSetupHint()}`,
				},
			],
			details: { error: "mux not available" },
		};
	}

	return {
		content: [
			{
				type: "text" as const,
				text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
			},
		],
		details: { error: "mux not available" },
	};
}

/**
 * Build the artifact directory path for the current session.
 * Same convention as the write_artifact tool:
 *   ~/.pi/history/<project>/artifacts/<session-id>/
 */
function getArtifactDir(cwd: string, sessionId: string): string {
	return getSessionArtifactDir(cwd, sessionId);
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
/**
 * Result from running a single subagent.
 */
/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();
const completedSubagentResults = new Map<string, CompletedSubagentResult>();
const PARENT_CLOSE_ESCALATION_MS = 5000;

function getSubagentCompletionStatus(
	result: SubagentResult,
): SubagentCompletionStatus {
	if (result.error === "cancelled") return "cancelled";
	return result.exitCode === 0 ? "completed" : "failed";
}

function buildCompletedSubagentResult(
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	return {
		...result,
		id: running.id,
		agent: running.agent,
		mode: running.mode,
		status: getSubagentCompletionStatus(result),
		deliveryState: running.deliveryState,
		parentClosePolicy: running.parentClosePolicy,
		blocking: running.blocking ?? false,
		deliveredTo: null,
	};
}

function cacheCompletedSubagentResult(
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	const cached = buildCompletedSubagentResult(running, result);
	completedSubagentResults.set(running.id, cached);
	return cached;
}

function clearSubagentShutdownTimer(running: RunningSubagent): void {
	if (!running.shutdownTimer) return;
	clearTimeout(running.shutdownTimer);
	running.shutdownTimer = undefined;
}

const widgetManager = new SubagentWidgetManager(() => runningSubagents.values());
let lastAmbientCatalogSignature: string | null = null;
let pendingAmbientCatalogReminder: {
	signature: string;
	content: string;
	entries: SubagentCatalogEntry[];
	supersedes?: true;
} | null = null;

export function getCompletedSubagentResultForTest(
	id: string,
): CompletedSubagentResult | undefined {
	return completedSubagentResults.get(id);
}

export function resetSubagentStateForTest(): void {
	lastAmbientCatalogSignature = null;
	pendingAmbientCatalogReminder = null;
	for (const agent of runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.abortController?.abort();
	}
	runningSubagents.clear();
	completedSubagentResults.clear();
	widgetManager.reset();
}

export function setRunningSubagentForTest(running: RunningSubagent): void {
	runningSubagents.set(running.id, running);
}

// ── Widget management ──

export function renderSubagentWidgetForTest(width = 120): string[] {
	return widgetManager.renderForTest(width);
}

function resolveModelContextWindow(modelRef: string | undefined): number | undefined {
	return widgetManager.resolveModelContextWindow(modelRef);
}

function updateWidget() {
	widgetManager.update();
}

function startWidgetRefresh() {
	widgetManager.startRefresh();
}

/**
 * Resolve the correct pi binary path for spawn(). Handles node, bun,
 * and bundled executables.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/**
 * Generate a unique session file path for a subagent.
 */
function generateSubagentSessionFile(sessionDir: string): string {
	const ts =
		new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
	const uuid = [
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	return join(sessionDir, `${ts}_${uuid}.jsonl`);
}

function getDoneSentinelFile(sessionFile: string, id: string): string {
	const base = basename(sessionFile, ".jsonl");
	return join(tmpdir(), `pi-subagent-done-${base}-${id}.txt`);
}

function createSessionHeader(
	cwd: string,
	parentSessionFile?: string,
) {
	return {
		type: "session",
		version: 3,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		cwd,
		...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
	};
}

export function createForkSessionFile(
	parentSessionFile: string,
	childSessionFile: string,
	cwd = process.cwd(),
): void {
	const entries = getEntries(parentSessionFile);
	let truncateAt = entries.length;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as SessionEntryLike;
		if (entry.type === "message" && entry.message?.role === "user") {
			truncateAt = i;
			break;
		}
	}

	const cleanEntries = entries.slice(0, truncateAt);
	const contentEntries = cleanEntries.filter((entry: SessionEntryLike) => entry?.type !== "session");
	const header = createSessionHeader(cwd, parentSessionFile);

	mkdirSync(dirname(childSessionFile), { recursive: true });
	writeFileSync(
		childSessionFile,
		[header, ...contentEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
		"utf8",
	);
}

function getSubagentArtifactPath(
	name: string,
	ctx: { sessionManager: { getSessionId(): string }; cwd: string },
	suffix = "",
): string {
	const sessionId = ctx.sessionManager.getSessionId();
	const artifactDir = getArtifactDir(ctx.cwd, sessionId);
	const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const safeName = name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return join(
		artifactDir,
		`context/${safeName || "subagent"}${suffix ? `-${suffix}` : ""}-${ts}.md`,
	);
}

function writeTaskArtifact(
	name: string,
	task: string,
	ctx: { sessionManager: { getSessionId(): string }; cwd: string },
): string {
	const artifactPath = getSubagentArtifactPath(name, ctx);
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, task, "utf8");
	return artifactPath;
}

function writeSystemPromptArtifact(
	name: string,
	systemPrompt: string,
	ctx: { sessionManager: { getSessionId(): string }; cwd: string },
): string {
	const artifactPath = getSubagentArtifactPath(name, ctx, "sysprompt");
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, systemPrompt, "utf8");
	return artifactPath;
}

export function writeSystemPromptArtifactForTest(
	name: string,
	systemPrompt: string,
	ctx: { sessionManager: { getSessionId(): string }; cwd: string },
): string {
	return writeSystemPromptArtifact(name, systemPrompt, ctx);
}

function buildIdentityBlock(
	agentDefs: AgentDefaults | null,
	systemPrompt?: string,
): string {
	return [agentDefs?.body, systemPrompt]
		.filter((value): value is string => typeof value === "string" && value.trim() !== "")
		.join("\n\n");
}

export function resolveSubagentCwd(rawCwd: string | null, baseCwd = process.cwd()): string {
	if (!rawCwd) return baseCwd;
	return rawCwd.startsWith("/") ? rawCwd : join(baseCwd, rawCwd);
}

export function resolveSubagentConfigDir(
	rawCwd: string | null,
	baseCwd = process.cwd(),
): string | null {
	if (!rawCwd) return null;
	const localAgentDir = join(resolveSubagentCwd(rawCwd, baseCwd), ".pi", "agent");
	return existsSync(localAgentDir) ? localAgentDir : null;
}

interface ResolvedSubagentRuntimePaths {
	rawCwd: string | null;
	cwdBase: string;
	effectiveCwd: string | null;
	localAgentConfigDir: string | null;
	effectiveAgentConfigDir: string;
	targetCwdForSession: string;
	sessionDir: string;
}

function getDefaultSessionDirFor(cwd: string, agentConfigDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentConfigDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

function resolveSubagentRuntimePaths(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
	parentCwd: string,
	parentSessionDir: string,
): ResolvedSubagentRuntimePaths {
	const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
	const cwdBase = params.cwd ? parentCwd : (agentDefs?.cwdBase ?? parentCwd);
	const effectiveCwd = rawCwd ? resolveSubagentCwd(rawCwd, cwdBase) : null;
	const localAgentConfigDir = resolveSubagentConfigDir(rawCwd, cwdBase);
	const effectiveAgentConfigDir = localAgentConfigDir ?? getAgentConfigDir();
	const targetCwdForSession = effectiveCwd ?? parentCwd;
	return {
		rawCwd,
		cwdBase,
		effectiveCwd,
		localAgentConfigDir,
		effectiveAgentConfigDir,
		targetCwdForSession,
		sessionDir: localAgentConfigDir
			? getDefaultSessionDirFor(targetCwdForSession, localAgentConfigDir)
			: parentSessionDir,
	};
}

export function resolveSubagentRuntimePathsForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
	parentCwd: string,
	parentSessionDir: string,
) {
	return resolveSubagentRuntimePaths(
		params,
		agentDefs,
		parentCwd,
		parentSessionDir,
	);
}

function getSubagentAgentRequirementError(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	if (!params.agent) {
		return {
			content: [{ type: "text" as const, text: "Error: agent is required for subagent launches." }],
			details: { error: "agent_required" },
		};
	}
	if (!agentDefs) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Error: agent "${params.agent}" was not found in .pi/agents/ or ~/.pi/agent/agents/.`,
				},
			],
			details: { error: "agent_not_found", agent: params.agent },
		};
	}
	return null;
}

export function getSubagentAgentRequirementErrorForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return getSubagentAgentRequirementError(params, agentDefs);
}

function getSubagentAgentOverrideError(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	if (!params.agent || !agentDefs) return null;

	const disallowed: string[] = [];
	if (params.systemPrompt != null) disallowed.push("systemPrompt");
	if (params.model != null) disallowed.push("model");
	if (params.skills != null) disallowed.push("skills");
	if (params.tools != null) disallowed.push("tools");
	if (params.cwd != null) disallowed.push("cwd");
	if (params.background != null) disallowed.push("background");
	if (params.fork != null) disallowed.push("fork");
	if (params.blocking != null) disallowed.push("blocking");
	if (disallowed.length === 0) return null;

	const effectiveMode = agentDefs.mode ?? "interactive";
	const frontmatterPath =
		agentDefs.path ?? `.pi/agents/${params.agent}.md or ~/.pi/agent/agents/${params.agent}.md`;
	const guidance: string[] = [];
	if (agentDefs.cwd != null) guidance.push(`cwd: ${agentDefs.cwd}`);
	if (disallowed.includes("background")) guidance.push(`mode: ${effectiveMode}`);
	guidance.push(`blocking: ${agentDefs.blocking ?? false}`);
	const guidanceText = guidance.length > 0 ? ` (${guidance.join(", ")})` : "";

	return {
		content: [
			{
				type: "text" as const,
				text:
					`Error: named agent "${params.agent}" rejects call-time overrides for ${disallowed.join(", ")}. ` +
					`Remove those fields from the subagent call and configure them in ${frontmatterPath}${guidanceText}.`,
			},
		],
		details: {
			error: "agent_param_conflict",
			agent: params.agent,
			disallowed,
			frontmatterPath,
			effectiveMode,
			blocking: agentDefs.blocking,
		},
	};
}

export function getSubagentAgentOverrideErrorForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return getSubagentAgentOverrideError(params, agentDefs);
}

function resolveSubagentBlocking(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): boolean {
	if (agentDefs?.blocking != null) return agentDefs.blocking;
	return params.blocking ?? false;
}

export function resolveSubagentBlockingForTest(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
) {
	return resolveSubagentBlocking(params, agentDefs);
}

function enforceAgentFrontmatter(
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
): SubagentParamsInput {
	return {
		name: params.name,
		task: params.task,
		agent: params.agent,
		fork: agentDefs?.fork,
		blocking: resolveSubagentBlocking(params, agentDefs),
		parentClosePolicy: params.parentClosePolicy,
	};
}

function findRunningSubagent(query: string): {
	running?: RunningSubagent;
	error?: string;
} {
	const byId = runningSubagents.get(query);
	if (byId) return { running: byId };

	const exactNameMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactNameMatches.length === 1) {
		return { running: exactNameMatches[0] };
	}
	if (exactNameMatches.length > 1) {
		return {
			error: `Multiple running subagents are named "${query}". Use the id instead.`,
		};
	}

	const ciMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name.toLowerCase() === query.toLowerCase(),
	);
	if (ciMatches.length === 1) {
		return { running: ciMatches[0] };
	}
	if (ciMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	return { error: `No running subagent matches "${query}".` };
}

function stopRunningSubagent(running: RunningSubagent): void {
	clearSubagentShutdownTimer(running);
	running.abortController?.abort();

	if (!running.abortController) {
		if (running.childProcess?.pid) {
			try {
				process.kill(-running.childProcess.pid, "SIGTERM");
			} catch {
				running.childProcess.kill("SIGTERM");
			}
		}
		if (running.surface) {
			try {
				closeSurface(running.surface);
			} catch {}
		}
	}

	updateWidget();
}

function getStartedSubagentDetails(running: RunningSubagent) {
	return {
		id: running.id,
		name: running.name,
		task: running.task,
		agent: running.agent,
		sessionFile: running.sessionFile,
		status: "started" as const,
		mode: running.mode,
		deliveryState: running.deliveryState,
		parentClosePolicy: running.parentClosePolicy,
		blocking: running.blocking ?? false,
	};
}

function getStartedSubagentResult(running: RunningSubagent) {
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Sub-agent "${running.name}" launched. ` +
					`Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
					`The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
					`Until then, move on to other work or tell the user you're waiting.`,
			},
		],
		details: getStartedSubagentDetails(running),
	};
}

function getLaunchedSubagentResult(
	running: RunningSubagent,
	signal?: AbortSignal,
) {
	if (!running.blocking) return getStartedSubagentResult(running);
	return waitForSubagentResult({ id: running.id }, signal);
}

export function getStartedSubagentDetailsForTest(
	running: RunningSubagent,
) {
	return getStartedSubagentDetails(running);
}

export function getLaunchedSubagentResultForTest(
	running: RunningSubagent,
	signal?: AbortSignal,
) {
	return getLaunchedSubagentResult(running, signal);
}

export function routeDetachedSubagentCompletionForTest(
	pi: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	return routeDetachedSubagentCompletion(pi as ExtensionAPI, running, result);
}

function deliverCompletedSubagentResultViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cached: CompletedSubagentResult,
): CompletedSubagentResult {
	if (cached.deliveryState !== "detached" || cached.deliveredTo) {
		return cached;
	}

	cached.deliveredTo = "steer";
	const sessionRef = cached.sessionFile
		? `\n\nSession: ${cached.sessionFile}\nResume: pi --session ${cached.sessionFile}`
		: "";
	const content =
		cached.exitCode !== 0
			? `Sub-agent "${cached.name}" failed (exit code ${cached.exitCode}).\n\n${cached.summary}${sessionRef}`
			: `Sub-agent "${cached.name}" completed (${formatElapsed(cached.elapsed)}).\n\n${cached.summary}${sessionRef}`;

	pi.sendMessage(
		{
			customType: "subagent_result",
			content,
			display: true,
			details: {
				id: cached.id,
				name: cached.name,
				task: cached.task,
				agent: cached.agent,
				mode: cached.mode,
				status: cached.status,
				deliveryState: cached.deliveryState,
				parentClosePolicy: cached.parentClosePolicy,
				blocking: cached.blocking,
				exitCode: cached.exitCode,
				elapsed: cached.elapsed,
				outputTokens: cached.outputTokens,
				sessionFile: cached.sessionFile,
			},
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);

	return cached;
}

function deliverSubagentPingViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
	result: SubagentResult,
): void {
	if (!result.ping) return;
	const sessionRef = result.sessionFile
		? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
		: "";
	pi.sendMessage(
		{
			customType: "subagent_ping",
			content:
				`Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}).\n\n` +
				`${result.ping.message}${sessionRef}`,
			display: true,
			details: {
				id: running.id,
				name: result.ping.name,
				task: running.task,
				agent: running.agent,
				mode: running.mode,
				deliveryState: running.deliveryState,
				parentClosePolicy: running.parentClosePolicy,
				blocking: running.blocking,
				elapsed: result.elapsed,
				outputTokens: result.outputTokens,
				sessionFile: result.sessionFile,
				message: result.ping.message,
			} as SubagentPingMessageDetails,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function routeDetachedSubagentCompletion(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
): CompletedSubagentResult {
	clearSubagentShutdownTimer(running);
	const cached =
		running.allowSteerDelivery === false && !running.resultOwner
			? buildCompletedSubagentResult(running, result)
			: cacheCompletedSubagentResult(running, result);
	runningSubagents.delete(running.id);
	updateWidget();
	if (running.allowSteerDelivery === false) {
		return cached;
	}
	return deliverCompletedSubagentResultViaSteer(pi, cached);
}

function handleDetachedSubagentOutcome(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
): void {
	if (result.ping) {
		clearSubagentShutdownTimer(running);
		runningSubagents.delete(running.id);
		updateWidget();
		if (running.allowSteerDelivery === false) return;
		deliverSubagentPingViaSteer(pi, running, result);
		return;
	}
	routeDetachedSubagentCompletion(pi, running, result);
}

function getSubagentWaitPingResult(
	running: RunningSubagent,
	result: SubagentResult,
	deliveryState: DeliveryState,
) {
	return {
		content: [
			{
				type: "text",
				text:
					`Sub-agent "${running.name}" requested help and exited. ` +
					`Resume it with subagent_resume using sessionFile ${result.sessionFile ?? "(missing)"}.`,
			},
		],
		details: {
			id: running.id,
			name: running.name,
			status: "pinged" as const,
			deliveryState,
			blocking: running.blocking,
			elapsed: result.elapsed,
			outputTokens: result.outputTokens,
			sessionFile: result.sessionFile,
			message: result.ping?.message,
		},
	};
}

function getSubagentWaitSuccessResult(cached: CompletedSubagentResult) {
	const verb =
		cached.status === "completed"
			? "completed"
			: cached.status === "cancelled"
				? "was cancelled"
				: "failed";
	const exitText =
		cached.status === "completed"
			? `exit code ${cached.exitCode}`
			: `status ${cached.status}`;
	return {
		content: [
			{
				type: "text",
				text: `Sub-agent "${cached.name}" ${verb} (${exitText}).`,
			},
		],
		details: {
			id: cached.id,
			name: cached.name,
			status: cached.status,
			deliveryState: "awaited" as const,
			blocking: cached.blocking,
			exitCode: cached.exitCode,
			elapsed: cached.elapsed,
			outputTokens: cached.outputTokens,
			sessionFile: cached.sessionFile,
		},
	};
}

function getSubagentWaitErrorResult(
	message: string,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return {
		content: [{ type: "text", text: message }],
		details: { error, ...extra },
	};
}

function releaseSubagentWaitOwnership(
	running: RunningSubagent,
	ownerId: string,
): void {
	if (runningSubagents.get(running.id) !== running) return;
	if (running.resultOwner?.kind !== "wait") return;
	if (running.resultOwner.ownerId !== ownerId) return;
	running.resultOwner = undefined;
	running.allowSteerDelivery = true;
	running.deliveryState = "detached";
	updateWidget();
}

function getSubagentDetachResult(id: string) {
	return {
		content: [{ type: "text", text: `Sub-agent "${id}" is detached again.` }],
		details: {
			id,
			status: "detached" as const,
			deliveryState: "detached" as const,
		},
	};
}

function getSubagentDetachErrorResult(
	message: string,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return {
		content: [{ type: "text", text: message }],
		details: { error, ...extra },
	};
}

function detachSubagentResult(
	params: DetachParams,
	pi?: Pick<ExtensionAPI, "sendMessage">,
) {
	const cached = completedSubagentResults.get(params.id);
	if (cached) {
		if (cached.deliveredTo || cached.deliveryState === "detached") {
			return getSubagentDetachErrorResult(
				`Sub-agent "${params.id}" is not currently owned by wait or join.`,
				"not_owned",
				{ id: params.id },
			);
		}
		cached.deliveryState = "detached";
		if (pi) deliverCompletedSubagentResultViaSteer(pi, cached);
		return getSubagentDetachResult(params.id);
	}

	const running = runningSubagents.get(params.id);
	if (!running) {
		return getSubagentDetachErrorResult(
			`No subagent matches "${params.id}".`,
			"not_found",
			{ id: params.id },
		);
	}
	if (
		running.deliveryState === "detached" ||
		(running.resultOwner?.kind !== "wait" && running.resultOwner?.kind !== "join")
	) {
		return getSubagentDetachErrorResult(
			`Sub-agent "${running.name}" is not currently owned by wait or join.`,
			"not_owned",
			{ id: running.id },
		);
	}

	running.resultOwner = undefined;
	running.allowSteerDelivery = true;
	running.deliveryState = "detached";
	updateWidget();
	return getSubagentDetachResult(running.id);
}

async function waitForSubagentResult(
	params: WaitParams,
	signal?: AbortSignal,
) {
	const cached = completedSubagentResults.get(params.id);
	if (cached) {
		if (cached.deliveredTo) {
			return getSubagentWaitErrorResult(
				`Sub-agent result for "${params.id}" was already delivered via ${cached.deliveredTo}.`,
				"already_delivered",
				{ id: params.id },
			);
		}
		if (cached.deliveryState !== "detached") {
			return getSubagentWaitErrorResult(
				`Sub-agent "${cached.name}" is already owned by another synchronization call.`,
				"already_owned",
				{ id: cached.id },
			);
		}
		cached.deliveryState = "awaited";
		cached.deliveredTo = "wait";
		return getSubagentWaitSuccessResult(cached);
	}

	const running = runningSubagents.get(params.id);
	if (!running) {
		return getSubagentWaitErrorResult(
			`No subagent matches "${params.id}".`,
			"not_found",
			{ id: params.id },
		);
	}
	if (running.resultOwner) {
		return getSubagentWaitErrorResult(
			`Sub-agent "${running.name}" is already owned by another synchronization call.`,
			"already_owned",
			{ id: running.id },
		);
	}
	if (!running.completionPromise) {
		return getSubagentWaitErrorResult(
			`Sub-agent "${running.name}" is missing completion tracking.`,
			"not_found",
			{ id: running.id },
		);
	}

	const ownerId = `wait:${randomUUID()}`;
	running.resultOwner = { kind: "wait", ownerId };
	running.allowSteerDelivery = false;
	running.deliveryState = "awaited";
	updateWidget();

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortCleanup = () => {};
	try {
		const completionPromise = running.completionPromise.then((result) => ({
			kind: "completed" as const,
			result,
		}));
		const races: Array<Promise<
			| { kind: "completed"; result: SubagentResult }
			| { kind: "timeout" }
			| { kind: "interrupted" }
		>> = [completionPromise];

		if (params.timeout && params.timeout > 0) {
			races.push(
				new Promise((resolve) => {
					timeoutHandle = setTimeout(
						() => resolve({ kind: "timeout" as const }),
						params.timeout! * 1000,
					);
				}),
			);
		}

		if (signal) {
			if (signal.aborted) {
				releaseSubagentWaitOwnership(running, ownerId);
				return getSubagentWaitErrorResult(
					`Waiting for sub-agent "${running.name}" was interrupted.`,
					"interrupted",
					{ id: running.id },
				);
			}
			races.push(
				new Promise((resolve) => {
					const onAbort = () => resolve({ kind: "interrupted" as const });
					signal.addEventListener("abort", onAbort, { once: true });
					abortCleanup = () => signal.removeEventListener("abort", onAbort);
				}),
			);
		}

		const outcome = await Promise.race(races);
		if (outcome.kind === "completed") {
			if (outcome.result.ping) {
				return getSubagentWaitPingResult(running, outcome.result, "awaited");
			}
			const completed =
				completedSubagentResults.get(running.id) ??
				cacheCompletedSubagentResult(running, outcome.result);
			if (completed.deliveredTo && completed.deliveredTo !== "wait") {
				return getSubagentWaitErrorResult(
					`Sub-agent result for "${running.id}" was already delivered via ${completed.deliveredTo}.`,
					"already_delivered",
					{ id: running.id },
				);
			}
			completed.deliveryState = "awaited";
			completed.deliveredTo = "wait";
			return getSubagentWaitSuccessResult(completed);
		}

		releaseSubagentWaitOwnership(running, ownerId);
		if (outcome.kind === "interrupted") {
			return getSubagentWaitErrorResult(
				`Waiting for sub-agent "${running.name}" was interrupted.`,
				"interrupted",
				{ id: running.id },
			);
		}
		if (params.onTimeout === "return_pending") {
			return {
				content: [
					{
						type: "text",
						text: `Sub-agent "${running.name}" is still running.`,
					},
				],
				details: {
					id: running.id,
					status: "pending" as const,
					deliveryState: "detached" as const,
					timeout: params.timeout,
				},
			};
		}
		return getSubagentWaitErrorResult(
			`Timed out waiting for sub-agent "${running.name}".`,
			"timeout",
			{ id: running.id, timeout: params.timeout },
		);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		abortCleanup();
	}
}

export function waitForSubagentForTest(
	params: WaitParams,
	signal?: AbortSignal,
) {
	return waitForSubagentResult(params, signal);
}

function getSubagentJoinResultFields(cached: CompletedSubagentResult) {
	return {
		exitCode: cached.exitCode,
		elapsed: cached.elapsed,
		outputTokens: cached.outputTokens,
		...(cached.sessionFile ? { sessionFile: cached.sessionFile } : {}),
	};
}

function getSubagentJoinErrorResult(
	message: string,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return {
		content: [{ type: "text", text: message }],
		details: { error, ...extra },
	};
}

function releaseSubagentJoinOwnership(
	running: RunningSubagent,
	ownerId: string,
): void {
	if (runningSubagents.get(running.id) !== running) return;
	if (running.resultOwner?.kind !== "join") return;
	if (running.resultOwner.ownerId !== ownerId) return;
	running.resultOwner = undefined;
	running.allowSteerDelivery = true;
	running.deliveryState = "detached";
	updateWidget();
}

function releaseCompletedJoinResultsToSteer(
	ids: string[],
	pi?: Pick<ExtensionAPI, "sendMessage">,
): void {
	for (const id of ids) {
		const cached = completedSubagentResults.get(id);
		if (!cached || cached.deliveredTo) continue;
		cached.deliveryState = "detached";
		if (pi) deliverCompletedSubagentResultViaSteer(pi, cached);
	}
}

function markJoinedResultsDelivered(ids: string[]): void {
	for (const id of ids) {
		const cached = completedSubagentResults.get(id);
		if (!cached) continue;
		cached.deliveryState = "joined";
		cached.deliveredTo = "join";
	}
}

function getSubagentJoinSuccessResult(
	ids: string[],
	results: Record<string, ReturnType<typeof getSubagentJoinResultFields>>,
	pendingIds: string[] = [],
	timeout?: number,
) {
	const completedCount = Object.keys(results).length;
	const isPartial = pendingIds.length > 0;
	return {
		content: [
			{
				type: "text",
				text: isPartial
					? `Joined ${completedCount} of ${ids.length} sub-agents before timeout.`
					: `Joined ${ids.length} sub-agent${ids.length === 1 ? "" : "s"}.`,
			},
		],
		details: {
			ids,
			status: isPartial ? ("partial" as const) : ("completed" as const),
			deliveryState: "joined" as const,
			results,
			...(isPartial ? { pendingIds, timeout } : {}),
		},
	};
}

async function joinSubagentResults(
	params: JoinParams,
	signal?: AbortSignal,
	pi?: Pick<ExtensionAPI, "sendMessage">,
) {
	if (params.ids.length === 0 || new Set(params.ids).size !== params.ids.length) {
		return getSubagentJoinErrorResult(
			"Join requires a non-empty set of unique child ids.",
			"invalid_ids",
			{ ids: params.ids },
		);
	}

	const ownerId = `join:${randomUUID()}`;
	const claimedRunning = new Map<string, RunningSubagent>();
	const claimedCached = new Map<string, CompletedSubagentResult>();
	for (const id of params.ids) {
		const cached = completedSubagentResults.get(id);
		if (cached) {
			if (cached.deliveredTo) {
				return getSubagentJoinErrorResult(
					`Sub-agent result for "${id}" was already delivered via ${cached.deliveredTo}.`,
					"already_delivered",
					{ id },
				);
			}
			if (cached.deliveryState !== "detached") {
				return getSubagentJoinErrorResult(
					`Sub-agent "${cached.name}" is already owned by another synchronization call.`,
					"already_owned",
					{ id: cached.id },
				);
			}
			claimedCached.set(id, cached);
			continue;
		}

		const running = runningSubagents.get(id);
		if (!running) {
			return getSubagentJoinErrorResult(
				`No subagent matches "${id}".`,
				"not_found",
				{ id },
			);
		}
		if (running.resultOwner) {
			return getSubagentJoinErrorResult(
				`Sub-agent "${running.name}" is already owned by another synchronization call.`,
				"already_owned",
				{ id: running.id },
			);
		}
		if (!running.completionPromise) {
			return getSubagentJoinErrorResult(
				`Sub-agent "${running.name}" is missing completion tracking.`,
				"not_found",
				{ id: running.id },
			);
		}
		claimedRunning.set(id, running);
	}

	for (const cached of claimedCached.values()) {
		cached.deliveryState = "joined";
	}
	for (const running of claimedRunning.values()) {
		running.resultOwner = { kind: "join", ownerId };
		running.allowSteerDelivery = false;
		running.deliveryState = "joined";
	}
	updateWidget();

	const results: Record<string, ReturnType<typeof getSubagentJoinResultFields>> = {};
	for (const [id, cached] of claimedCached.entries()) {
		results[id] = getSubagentJoinResultFields(cached);
	}

	const completedIds = new Set(Object.keys(results));
	const pending = new Map(claimedRunning);
	if (pending.size === 0) {
		markJoinedResultsDelivered([...completedIds]);
		return getSubagentJoinSuccessResult(params.ids, results);
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortCleanup = () => {};
	let timeoutPromise: Promise<{ kind: "timeout" }> | undefined;
	let interruptPromise: Promise<{ kind: "interrupted" }> | undefined;
	try {
		if (params.timeout && params.timeout > 0) {
			timeoutPromise = new Promise((resolve) => {
				timeoutHandle = setTimeout(
					() => resolve({ kind: "timeout" as const }),
					params.timeout! * 1000,
				);
			});
		}
		if (signal) {
			if (signal.aborted) {
				for (const running of pending.values()) {
					releaseSubagentJoinOwnership(running, ownerId);
				}
				releaseCompletedJoinResultsToSteer([...completedIds], pi);
				return getSubagentJoinErrorResult(
					"Joining sub-agents was interrupted.",
					"interrupted",
					{ ids: params.ids },
				);
			}
			interruptPromise = new Promise((resolve) => {
				const onAbort = () => resolve({ kind: "interrupted" as const });
				signal.addEventListener("abort", onAbort, { once: true });
				abortCleanup = () => signal.removeEventListener("abort", onAbort);
			});
		}

		while (pending.size > 0) {
			const races: Array<Promise<
				| { kind: "completed"; id: string; result: SubagentResult }
				| { kind: "timeout" }
				| { kind: "interrupted" }
			>> = [...pending.entries()].map(([id, running]) =>
				running.completionPromise!.then((result) => ({
					kind: "completed" as const,
					id,
					result,
				})),
			);
			if (timeoutPromise) races.push(timeoutPromise);
			if (interruptPromise) races.push(interruptPromise);

			const outcome = await Promise.race(races);
			if (outcome.kind === "completed") {
				pending.delete(outcome.id);
				const running = claimedRunning.get(outcome.id)!;
				if (outcome.result.ping) {
					for (const pendingRunning of pending.values()) {
						releaseSubagentJoinOwnership(pendingRunning, ownerId);
					}
					releaseCompletedJoinResultsToSteer([...completedIds], pi);
					return {
						content: [
							{
								type: "text",
								text:
									`Sub-agent "${running.name}" requested help and exited. ` +
									`Resume it with subagent_resume using sessionFile ${outcome.result.sessionFile ?? "(missing)"}.`,
							},
						],
						details: {
							ids: params.ids,
							id: running.id,
							status: "pinged" as const,
							deliveryState: "joined" as const,
							pendingIds: [...pending.keys()],
							sessionFile: outcome.result.sessionFile,
							message: outcome.result.ping.message,
							results,
						},
					};
				}
				const completed =
					completedSubagentResults.get(outcome.id) ??
					cacheCompletedSubagentResult(running, outcome.result);
				if (completed.deliveredTo && completed.deliveredTo !== "join") {
					for (const pendingRunning of pending.values()) {
						releaseSubagentJoinOwnership(pendingRunning, ownerId);
					}
					releaseCompletedJoinResultsToSteer([...completedIds], pi);
					return getSubagentJoinErrorResult(
						`Sub-agent result for "${outcome.id}" was already delivered via ${completed.deliveredTo}.`,
						"already_delivered",
						{ id: outcome.id },
					);
				}
				completed.deliveryState = "joined";
				results[outcome.id] = getSubagentJoinResultFields(completed);
				completedIds.add(outcome.id);
				continue;
			}

			for (const pendingRunning of pending.values()) {
				releaseSubagentJoinOwnership(pendingRunning, ownerId);
			}
			if (outcome.kind === "interrupted") {
				releaseCompletedJoinResultsToSteer([...completedIds], pi);
				return getSubagentJoinErrorResult(
					"Joining sub-agents was interrupted.",
					"interrupted",
					{ ids: params.ids },
				);
			}
			if (params.onTimeout === "return_partial") {
				markJoinedResultsDelivered([...completedIds]);
				return getSubagentJoinSuccessResult(
					params.ids,
					results,
					[...pending.keys()],
					params.timeout,
				);
			}
			releaseCompletedJoinResultsToSteer([...completedIds], pi);
			return getSubagentJoinErrorResult(
				"Timed out joining sub-agents.",
				"timeout",
				{ ids: params.ids, timeout: params.timeout },
			);
		}

		markJoinedResultsDelivered([...completedIds]);
		return getSubagentJoinSuccessResult(params.ids, results);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		abortCleanup();
	}
}

export function joinSubagentsForTest(
	params: JoinParams,
	signal?: AbortSignal,
	pi?: Pick<ExtensionAPI, "sendMessage">,
) {
	return joinSubagentResults(params, signal, pi);
}

export function detachSubagentForTest(
	params: DetachParams,
	pi?: Pick<ExtensionAPI, "sendMessage">,
) {
	return detachSubagentResult(params, pi);
}

function getBuiltinTools(tools?: string): string[] {
	if (!tools) return [];
	const builtinTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
	return tools
		.split(",")
		.map((tool) => tool.trim())
		.filter((tool) => builtinTools.has(tool));
}

interface SubagentLaunchContext {
	sessionManager: {
		getSessionFile(): string | null;
		getSessionId(): string;
	};
	cwd: string;
}

interface PreparedSubagentLaunch {
	agentDefs: AgentDefaults | null;
	effectiveModel?: string;
	effectiveThinking?: string;
	effectiveModelRef?: string;
	effectiveTools?: string;
	effectiveSkills?: string;
	sessionFile: string;
	runtimePaths: ResolvedSubagentRuntimePaths;
	subagentSessionFile: string;
	denySet: Set<string>;
	identity: string;
	identityInSystemPrompt: boolean;
}

function prepareSubagentLaunch(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
): PreparedSubagentLaunch {
	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, params.cwd, ctx.cwd)
		: null;
	const effectiveModel = params.model ?? agentDefs?.model;
	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const effectiveThinking = agentDefs?.thinking;
	const effectiveModelRef = effectiveThinking
		? `${effectiveModel}:${effectiveThinking}`
		: effectiveModel;

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("No session file");

	const runtimePaths = resolveSubagentRuntimePaths(
		params,
		agentDefs,
		ctx.cwd,
		dirname(sessionFile),
	);
	const subagentSessionFile = generateSubagentSessionFile(runtimePaths.sessionDir);
	const denySet = resolveDenyTools(agentDefs);
	const identity = buildIdentityBlock(agentDefs, params.systemPrompt);
	const identityInSystemPrompt = !!(agentDefs?.systemPromptMode && identity);

	return {
		agentDefs,
		effectiveModel,
		effectiveThinking,
		effectiveModelRef,
		effectiveTools,
		effectiveSkills,
		sessionFile,
		runtimePaths,
		subagentSessionFile,
		denySet,
		identity,
		identityInSystemPrompt,
	};
}

function getPreparedModel(prepared: PreparedSubagentLaunch): string | undefined {
	if (!prepared.effectiveModel) return undefined;
	return prepared.effectiveThinking
		? `${prepared.effectiveModel}:${prepared.effectiveThinking}`
		: prepared.effectiveModel;
}

function getPreparedSkillList(prepared: PreparedSubagentLaunch): string[] {
	if (!prepared.effectiveSkills) return [];
	return prepared.effectiveSkills
		.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean);
}

function getPreparedBuiltinTools(prepared: PreparedSubagentLaunch): string[] {
	return getBuiltinTools(prepared.effectiveTools);
}

function getPreparedRoleBlock(prepared: PreparedSubagentLaunch): string {
	return prepared.identity && !prepared.identityInSystemPrompt
		? `\n\n${prepared.identity}`
		: "";
}

function getBaseSubagentEnvVars(
	prepared: PreparedSubagentLaunch,
	ctx: SubagentLaunchContext,
	params: SubagentParamsInput,
): Record<string, string> {
	const envVars: Record<string, string> = {};
	if (prepared.runtimePaths.localAgentConfigDir) {
		envVars.PI_CODING_AGENT_DIR = prepared.runtimePaths.localAgentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		envVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	if (prepared.denySet.size > 0) envVars.PI_DENY_TOOLS = [...prepared.denySet].join(",");
	envVars.PI_SUBAGENT_NAME = params.name;
	if (params.agent) envVars.PI_SUBAGENT_AGENT = params.agent;
	envVars.PI_ARTIFACT_PROJECT_ROOT = resolveArtifactProjectRoot(ctx.cwd);
	return envVars;
}

// ── Background launch & watch ──

/**
 * Launch a background subagent as a headless `pi -p` child process.
 * No terminal pane or mux required.
 */
function launchBackgroundSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const prepared = prepareSubagentLaunch(params, ctx);
	const subagentDonePath = join(
		dirname(new URL(import.meta.url).pathname),
		"subagent-done.ts",
	);
	const roleBlock = getPreparedRoleBlock(prepared);
	const fullTask = params.fork
		? params.task
		: `${roleBlock}\n\nComplete your task autonomously.\n\n${params.task}\n\nYour FINAL assistant message should summarize what you accomplished.`;

	const args: string[] = ["-p", "--session", prepared.subagentSessionFile, "-e", subagentDonePath];
	if (params.fork) {
		createForkSessionFile(
			prepared.sessionFile,
			prepared.subagentSessionFile,
			prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
		);
	}

	const model = getPreparedModel(prepared);
	if (model) {
		args.push("--model", model);
	}

	if (prepared.identityInSystemPrompt && prepared.identity) {
		args.push(
			prepared.agentDefs?.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			prepared.identity,
		);
	}

	const builtins = getPreparedBuiltinTools(prepared);
	if (builtins.length > 0) args.push("--tools", builtins.join(","));

	for (const skill of getPreparedSkillList(prepared)) {
		args.push(`/skill:${skill}`);
	}

	if (params.fork) {
		args.push(fullTask);
	} else {
		const artifactPath = writeTaskArtifact(params.name, fullTask, ctx);
		args.push(`@${artifactPath}`);
	}

	const envVars = getBaseSubagentEnvVars(prepared, ctx, params);
	envVars.PI_SUBAGENT_AUTO_EXIT = "1";
	envVars.PI_SUBAGENT_SESSION = prepared.subagentSessionFile;

	const invocation = getPiInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd: prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...envVars },
	});
	child.unref();

	const running: RunningSubagent = {
		id,
		name: params.name,
		task: params.task,
		agent: params.agent,
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: params.parentClosePolicy ?? "terminate",
		blocking: params.blocking ?? false,
		childProcess: child,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		modelContextWindow: resolveModelContextWindow(prepared.effectiveModelRef),
	};

	runningSubagents.set(id, running);
	return running;
}

/**
 * Watch a background subagent until it exits. Listens for the child process
 * exit event, polls the session file for widget updates, and handles
 * timeout and abort.
 */
function watchBackgroundSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
	timeout?: number,
): Promise<SubagentResult> {
	const child = running.childProcess!;
	const terminalGraceMs = 1000;

	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let terminalSummary: string | null = null;
		let terminalSeenAt = 0;
		if (timeout && timeout > 0) {
			timer = setTimeout(() => {
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGTERM");
					} catch {
						child.kill("SIGTERM");
					}
				}
			}, timeout * 1000);
		}

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			clearInterval(pollInterval);
			signal.removeEventListener("abort", onAbort);
			child.removeListener("exit", onExit);
			child.removeListener("error", onError);
		};

		const finish = (result: SubagentResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const pollInterval = setInterval(() => {
			try {
				if (!existsSync(running.sessionFile)) return;
				const stat = statSync(running.sessionFile);
				running.entries = getEntryCount(running.sessionFile);
				running.bytes = stat.size;
				const summary = getTerminalAssistantSummaryForTest(
					getEntries(running.sessionFile) as SessionEntryLike[],
				);
				if (!summary) {
					terminalSummary = null;
					terminalSeenAt = 0;
					return;
				}
				if (summary !== terminalSummary) {
					terminalSummary = summary;
					terminalSeenAt = Date.now();
					return;
				}
				if (Date.now() - terminalSeenAt < terminalGraceMs) return;
				terminateBackgroundChildProcess(running, "SIGTERM");
			} catch {}
		}, 1000);

		const onAbort = () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
				setTimeout(() => {
					if (!child.killed && child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				}, 5000);
			}
		};
		const onExit = (code: number | null) => {
			const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
			const exitSignal = consumeSubagentExitSignal(running.sessionFile);
			const exitCode = exitSignal?.exitCode ?? code ?? 1;
			let summary = `Background agent exited with code ${exitCode}`;
			if (existsSync(running.sessionFile)) {
				const allEntries = getNewEntries(running.sessionFile, 0);
				summary =
					findLastAssistantMessage(allEntries) ??
					(exitCode !== 0
						? `Background agent exited with code ${exitCode}`
						: "Background agent exited without output");
			}
			finish({
				name: running.name,
				task: running.task,
				summary,
				sessionFile: running.sessionFile,
				exitCode,
				elapsed,
				outputTokens: exitSignal?.outputTokens,
				ping: exitSignal?.ping,
			});
		};
		const onError = (error: Error) => {
			finish({
				name: running.name,
				task: running.task,
				summary: `Background agent failed to start: ${error.message}`,
				sessionFile: running.sessionFile,
				exitCode: 1,
				elapsed: Math.floor((Date.now() - running.startTime) / 1000),
				error: error.message,
			});
		};

		signal.addEventListener("abort", onAbort, { once: true });
		child.once("exit", onExit);
		child.once("error", onError);
	});
}

// ── Interactive launch & watch ──

/**
 * Launch an interactive subagent in a multiplexer pane.
 */
async function launchSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	options?: { surface?: string },
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const prepared = prepareSubagentLaunch(params, ctx);
	const doneSentinelFile = getDoneSentinelFile(prepared.subagentSessionFile, id);

	const surfacePreCreated = !!options?.surface;
	const surface = options?.surface ?? createSurface(params.name);
	if (!surfacePreCreated) {
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
	}

	const agentType = params.agent ?? params.name;
	const modeHint = prepared.agentDefs?.autoExit
		? "Complete your task autonomously."
		: "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
	const summaryInstruction = prepared.agentDefs?.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
	const tabTitleInstruction = prepared.denySet.has("set_tab_title")
		? ""
		: `As your FIRST action, set the tab title using set_tab_title. ` +
			`The title MUST start with [${agentType}] followed by a short description of your current task. ` +
			`Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
	const roleBlock = getPreparedRoleBlock(prepared);
	const fullTask = params.fork
		? params.task
		: `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}\n\n${summaryInstruction}`;

	// Build pi command (shell-escaped for sendCommand)
	const parts: string[] = ["pi", "--session", shellEscape(prepared.subagentSessionFile)];
	if (params.fork) {
		createForkSessionFile(
			prepared.sessionFile,
			prepared.subagentSessionFile,
			prepared.runtimePaths.effectiveCwd ?? ctx.cwd,
		);
	}

	const subagentDonePath = join(
		dirname(new URL(import.meta.url).pathname),
		"subagent-done.ts",
	);
	parts.push("-e", shellEscape(subagentDonePath));

	const model = getPreparedModel(prepared);
	if (model) {
		parts.push("--model", shellEscape(model));
	}

	if (prepared.identityInSystemPrompt && prepared.identity) {
		const flag = prepared.agentDefs?.systemPromptMode === "replace"
			? "--system-prompt"
			: "--append-system-prompt";
		const systemPromptPath = writeSystemPromptArtifact(params.name, prepared.identity, ctx);
		parts.push(flag, shellEscape(systemPromptPath));
	}

	const builtins = getPreparedBuiltinTools(prepared);
	if (builtins.length > 0)
		parts.push("--tools", shellEscape(builtins.join(",")));

	for (const skill of getPreparedSkillList(prepared)) {
		parts.push(shellEscape(`/skill:${skill}`));
	}

	// Env vars (shell-escaped for inline prefix)
	const envVars = getBaseSubagentEnvVars(prepared, ctx, params);
	if (prepared.agentDefs?.autoExit) envVars.PI_SUBAGENT_AUTO_EXIT = "1";
	envVars.PI_SUBAGENT_SESSION = prepared.subagentSessionFile;
	envVars.PI_SUBAGENT_SURFACE = surface;
	const envPrefix = Object.entries(envVars)
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ") + " ";

	if (params.fork) {
		parts.push(shellEscape(fullTask));
	} else {
		const artifactPath = writeTaskArtifact(params.name, fullTask, ctx);
		parts.push(`@${artifactPath}`);
	}

	const cdPrefix = prepared.runtimePaths.effectiveCwd
		? `cd ${shellEscape(prepared.runtimePaths.effectiveCwd)} && `
		: "";

	const piCommand = cdPrefix + envPrefix + parts.join(" ");
	const command = `${piCommand}; printf '__SUBAGENT_DONE_'${exitStatusVar()}'__\\n' | tee ${shellEscape(doneSentinelFile)}`;
	sendCommand(surface, command);

	const running: RunningSubagent = {
		id,
		name: params.name,
		task: params.task,
		agent: params.agent,
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: params.parentClosePolicy ?? "terminate",
		blocking: params.blocking ?? false,
		surface,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		modelContextWindow: resolveModelContextWindow(prepared.effectiveModelRef),
		doneSentinelFile,
	};

	runningSubagents.set(id, running);
	return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface and fork file,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
	running: RunningSubagent,
	signal: AbortSignal,
): Promise<SubagentResult> {
	const { name, task, surface, startTime, sessionFile } =
		running;
	if (!surface)
		throw new Error(
			"watchSubagent called on a background agent (no surface)",
		);

	try {
		const pollResult = await pollForExit(surface, signal, {
			interval: 1000,
			sessionFile,
			doneSentinelFile: running.doneSentinelFile,
			onTick() {
				// Update entries/bytes for widget display
				try {
					if (existsSync(sessionFile)) {
						const stat = statSync(sessionFile);
						const raw = readFileSync(sessionFile, "utf8");
						running.entries = raw
							.split("\n")
							.filter((l) => l.trim()).length;
						running.bytes = stat.size;
					}
				} catch {}
			},
		});

		const elapsed = Math.floor((Date.now() - startTime) / 1000);

		// Extract summary from the known session file
		let summary: string;
		if (existsSync(sessionFile)) {
			const allEntries = getNewEntries(sessionFile, 0);
			summary =
				findLastAssistantMessage(allEntries) ??
				(pollResult.exitCode !== 0
					? `Sub-agent exited with code ${pollResult.exitCode}`
					: "Sub-agent exited without output");
		} else {
			summary =
				pollResult.exitCode !== 0
					? `Sub-agent exited with code ${pollResult.exitCode}`
					: "Sub-agent exited without output";
		}

		const exitSignal =
			pollResult.outputTokens !== undefined ? undefined : consumeSubagentExitSignal(sessionFile);
		if (running.doneSentinelFile && existsSync(running.doneSentinelFile)) {
			try {
				rmSync(running.doneSentinelFile, { force: true });
			} catch {}
		}
		closeSurface(surface);

		return {
			name,
			task,
			summary,
			sessionFile,
			exitCode: pollResult.exitCode,
			elapsed,
			outputTokens: pollResult.outputTokens ?? exitSignal?.outputTokens,
			ping: pollResult.ping,
		};
	} catch (err: unknown) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		if (running.doneSentinelFile && existsSync(running.doneSentinelFile)) {
			try {
				rmSync(running.doneSentinelFile, { force: true });
			} catch {}
		}
		try {
			closeSurface(surface);
		} catch {}

		if (signal.aborted) {
			return {
				name,
				task,
				summary: "Subagent cancelled.",
				exitCode: 1,
				elapsed: Math.floor((Date.now() - startTime) / 1000),
				outputTokens: 0,
				error: "cancelled",
			};
		}
		return {
			name,
			task,
			summary: `Subagent error: ${errorMessage}`,
			exitCode: 1,
			elapsed: Math.floor((Date.now() - startTime) / 1000),
			outputTokens: 0,
			error: errorMessage,
		};
	}
}

type ShutdownSubagentsOptions = {
	escalationMs?: number;
	interruptSurfaceImpl?: typeof interruptSurface;
};

function terminateBackgroundChildProcess(
	running: RunningSubagent,
	signal: NodeJS.Signals,
): void {
	if (!running.childProcess?.pid) return;
	try {
		process.kill(-running.childProcess.pid, signal);
	} catch {
		running.childProcess.kill(signal);
	}
}

function abortBackgroundSubagent(
	running: RunningSubagent,
	escalationMs: number,
): void {
	if (running.abortController) {
		running.abortController.abort();
		return;
	}

	terminateBackgroundChildProcess(running, "SIGTERM");
	if (!running.childProcess?.pid) return;
	clearSubagentShutdownTimer(running);
	running.shutdownTimer = setTimeout(() => {
		running.shutdownTimer = undefined;
		terminateBackgroundChildProcess(running, "SIGKILL");
	}, escalationMs);
	running.shutdownTimer.unref?.();
}

function terminateInteractiveSubagent(running: RunningSubagent): void {
	running.abortController?.abort();
	if (running.abortController || !running.surface) return;
	try {
		closeSurface(running.surface);
	} catch {}
}

function cancelInteractiveSubagent(
	running: RunningSubagent,
	escalationMs: number,
	interruptSurfaceImpl: typeof interruptSurface,
): void {
	if (!running.surface) {
		terminateInteractiveSubagent(running);
		return;
	}

	try {
		interruptSurfaceImpl(running.surface);
	} catch {
		terminateInteractiveSubagent(running);
		return;
	}

	clearSubagentShutdownTimer(running);
	running.shutdownTimer = setTimeout(() => {
		running.shutdownTimer = undefined;
		terminateInteractiveSubagent(running);
	}, escalationMs);
	running.shutdownTimer.unref?.();
}

function shutdownSubagentsForParentExit(
	options: ShutdownSubagentsOptions = {},
): Array<{ id: string; policy: ParentClosePolicy; action: ParentShutdownAction }> {
	const escalationMs = options.escalationMs ?? PARENT_CLOSE_ESCALATION_MS;
	const interruptSurfaceImpl =
		options.interruptSurfaceImpl ?? interruptSurface;
	const actions: Array<{
		id: string;
		policy: ParentClosePolicy;
		action: ParentShutdownAction;
	}> = [];

	for (const agent of runningSubagents.values()) {
		clearSubagentShutdownTimer(agent);
		agent.allowSteerDelivery = false;
		agent.resultOwner = undefined;
		agent.deliveryState = "detached";

		if (agent.parentClosePolicy === "abandon") {
			actions.push({
				id: agent.id,
				policy: agent.parentClosePolicy,
				action: "abandon",
			});
			continue;
		}

		if (agent.parentClosePolicy === "cancel") {
			actions.push({
				id: agent.id,
				policy: agent.parentClosePolicy,
				action: "cancel",
			});
			if (agent.mode === "interactive") {
				cancelInteractiveSubagent(agent, escalationMs, interruptSurfaceImpl);
			} else {
				abortBackgroundSubagent(agent, escalationMs);
			}
			continue;
		}

		actions.push({
			id: agent.id,
			policy: agent.parentClosePolicy,
			action: "terminate",
		});
		if (agent.mode === "interactive") {
			terminateInteractiveSubagent(agent);
		} else {
			abortBackgroundSubagent(agent, escalationMs);
		}
	}

	runningSubagents.clear();
	completedSubagentResults.clear();
	updateWidget();
	return actions;
}

export function shutdownSubagentsForTest(
	options?: ShutdownSubagentsOptions,
) {
	return shutdownSubagentsForParentExit(options);
}

export default function subagentsExtension(pi: ExtensionAPI) {
	function attachWidgetContext(ctx: ExtensionContext) {
		widgetManager.attachContext(ctx);
	}

	// Capture the UI context early so the widget keeps a stable slot above tasks.
	pi.on("session_start", (event, ctx) => {
		attachWidgetContext(ctx);
		if (isAmbientAwarenessDisabled()) {
			pendingAmbientCatalogReminder = null;
			return;
		}
		if (!shouldRegister("subagent")) return;
		if (ctx.sessionManager.getHeader()?.parentSession) return;

		const entries = getAmbientCatalogEntries(ctx.cwd);
		const signature = getSubagentCatalogSignature(entries);
		if (entries.length === 0) {
			if (event.reason === "reload") pendingAmbientCatalogReminder = null;
			lastAmbientCatalogSignature = null;
			return;
		}

		if (signature === lastAmbientCatalogSignature) {
			pendingAmbientCatalogReminder = null;
			return;
		}

		pendingAmbientCatalogReminder = {
			signature,
			content: renderSubagentCatalogReminder(entries),
			entries,
			supersedes: event.reason === "reload" ? true : undefined,
		};
	});

	pi.on("before_agent_start", () => {
		if (isAmbientAwarenessDisabled()) {
			pendingAmbientCatalogReminder = null;
			return undefined;
		}
		if (!pendingAmbientCatalogReminder) return undefined;

		const reminder = pendingAmbientCatalogReminder;
		lastAmbientCatalogSignature = reminder.signature;
		pendingAmbientCatalogReminder = null;
		return {
			message: {
				customType: "subagent_catalog",
				content: reminder.content,
				display: false,
				details: {
					entries: reminder.entries,
					signature: reminder.signature,
					...(reminder.supersedes ? { supersedes: true } : {}),
				},
			},
		};
	});

	pi.on("session_switch", (_event, ctx) => {
		attachWidgetContext(ctx);
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", (_event, ctx) => {
		widgetManager.reset();
		shutdownSubagentsForParentExit();
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagent-status", undefined);
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);
	const hideSubagentsListForAmbientTopLevel =
		!process.env.PI_SUBAGENT_SESSION &&
		!isAmbientAwarenessDisabled() &&
		shouldRegister("subagent");

	// ── subagent tool ──
	if (shouldRegister("subagent"))
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Spawn a named sub-agent from an existing agent definition for specialist or parallelizable work. " +
				"By default this returns immediately and results arrive later via steer. " +
				"If blocking is true, or agent frontmatter sets blocking: true, this call waits for the child to finish.",
			promptSnippet:
				"Use subagents for specialist, complex, or parallelizable work when the named-agent catalog suggests a good match. " +
				"Keep launches explicit, prefer one call per child, and launch independent children in parallel. " +
				"Interactive agents run in panes; background agents run headlessly; named-agent frontmatter is authoritative for runtime settings, and conflicting call-time execution overrides are rejected. " +
				"Handle trivial single-file reads, quick direct answers, and tiny one-shot edits yourself instead of delegating. " +
				"If the launch is non-blocking, move on and wait for the later steer result; do not fabricate unfinished child results, and use subagent_wait or subagent_join only when the outputs are real dependencies.",
			parameters: SubagentParams,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const agentDefs = loadAgentDefaults(params.agent, params.cwd, ctx.cwd);
				const agentError = getSubagentAgentRequirementError(params, agentDefs);
				if (agentError) return agentError;
				const agentOverrideError = getSubagentAgentOverrideError(params, agentDefs);
				if (agentOverrideError) return agentOverrideError;
				const effectiveParams = enforceAgentFrontmatter(params, agentDefs);

				// Prevent self-spawning (e.g. an agent spawning another copy of itself)
				const currentAgent = process.env.PI_SUBAGENT_AGENT;
				if (
					effectiveParams.agent &&
					currentAgent &&
					effectiveParams.agent === currentAgent
				) {
					return {
						content: [
							{
								type: "text",
								text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
							},
						],
						details: { error: "self-spawn blocked" },
					};
				}

				if (!ctx.sessionManager.getSessionFile()) {
					return {
						content: [
							{
								type: "text",
								text: "Error: no session file. Start pi with a persistent session to use subagents.",
							},
						],
						details: { error: "no session file" },
					};
				}

				// Resolve mode: agent frontmatter > interactive (default). Parent overrides are ignored when an agent is selected.
				const isBackground =
					effectiveParams.background ??
					(agentDefs?.mode === "background" ? true : false);

				// Helper: wire up the steer-back message after a subagent completes
				const wireSteerBack = (
					running: RunningSubagent,
					watchPromise: Promise<SubagentResult>,
				) => {
					watchPromise
						.then((result) => {
							handleDetachedSubagentOutcome(pi, running, result);
						})
						.catch((err) => {
							runningSubagents.delete(running.id);
							updateWidget();
							pi.sendMessage(
								{
									customType: "subagent_result",
									content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
									display: true,
									details: {
										id: running.id,
										name: running.name,
										task: running.task,
										deliveryState: running.deliveryState,
										parentClosePolicy: running.parentClosePolicy,
										error: err?.message,
									},
								},
								{ triggerTurn: true, deliverAs: "steer" },
							);
						});
				};

				let running: RunningSubagent;

				if (isBackground) {
					// Background mode — no mux required, headless child process
					running = await launchBackgroundSubagent(effectiveParams, ctx);
					const watcherAbort = new AbortController();
					running.abortController = watcherAbort;
					running.completionPromise = watchBackgroundSubagent(
						running,
						watcherAbort.signal,
						agentDefs?.timeout,
					);
					startWidgetRefresh();
					wireSteerBack(running, running.completionPromise);
				} else {
					// Interactive mode — requires a terminal multiplexer
					if (!isMuxAvailable()) {
						return muxUnavailableResult("subagents");
					}
					running = await launchSubagent(effectiveParams, ctx);
					const watcherAbort = new AbortController();
					running.abortController = watcherAbort;
					running.completionPromise = watchSubagent(
						running,
						watcherAbort.signal,
					);
					startWidgetRefresh();
					wireSteerBack(running, running.completionPromise);
				}

				return getLaunchedSubagentResult(running, signal);
			},

			renderCall(args, theme) {
				const agent = args.agent
					? theme.fg("dim", ` (${args.agent})`)
					: "";
				const cwdHint = args.cwd
					? theme.fg("dim", ` in ${args.cwd}`)
					: "";
				let text =
					"▸ " +
					theme.fg(
						"toolTitle",
						theme.bold(args.name ?? "(unnamed)"),
					) +
					agent +
					cwdHint;

				// Show a one-line task preview. renderCall is called repeatedly as the
				// LLM generates tool arguments, so args.task grows token by token.
				// We keep it compact here — Ctrl+O on renderResult expands the full content.
				const task = args.task ?? "";
				if (task) {
					const firstLine =
						task.split("\n").find((l: string) => l.trim()) ?? "";
					const preview =
						firstLine.length > 100
							? firstLine.slice(0, 100) + "…"
							: firstLine;
					if (preview) {
						text += "\n" + theme.fg("toolOutput", preview);
					}
					const totalLines = task.split("\n").length;
					if (totalLines > 1) {
						text += theme.fg("muted", ` (${totalLines} lines)`);
					}
				}

				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				const details = result.details as StartedSubagentToolDetails | undefined;
				const name = details?.name ?? "(unnamed)";

				if (details?.error) {
					return new Text(
						theme.fg("danger", `✗ ${details.error}`),
						0,
						0,
					);
				}

				if (details?.status === "started") {
					const deliveryState = details?.deliveryState ?? "detached";
					const closePolicy = details?.parentClosePolicy ?? "terminate";
					const blocking = details?.blocking ? " · blocking" : "";
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", ` — started · ${deliveryState}${blocking} · close:${closePolicy}`),
						0,
						0,
					);
				}

				if (details?.status) {
					const deliveryState = details?.deliveryState ? ` · ${details.deliveryState}` : "";
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", ` — ${details.status}${deliveryState}`),
						0,
						0,
					);
				}

				const text =
					typeof result.content?.[0]?.text === "string"
						? result.content[0].text
						: "";
				return new Text(theme.fg("dim", text), 0, 0);
			},
		});

	// ── subagent_wait tool ──
	if (shouldRegister("subagent_wait"))
		pi.registerTool({
			name: "subagent_wait",
			label: "Wait Subagent",
			description:
				"Wait for one child result. Returns the child result directly and suppresses duplicate steer delivery.",
			promptSnippet:
				"Wait for one child result. Returns the child result directly and suppresses duplicate steer delivery.",
			parameters: SubagentWaitParams,

			async execute(_toolCallId, params, signal) {
				return waitForSubagentResult(params, signal);
			},

			renderCall(args, theme) {
				return new Text(
					"▸ " +
						theme.fg("toolTitle", theme.bold("wait")) +
						theme.fg("dim", ` ${args.id}`),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				const details = result.details as SyncSubagentToolDetails | undefined;
				if (details?.error) {
					return new Text(
						theme.fg("danger", `✗ ${details.error}`),
						0,
						0,
					);
				}
				const status = details?.status ?? "completed";
				const deliveryState = details?.deliveryState ? ` · ${details.deliveryState}` : "";
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(details?.name ?? details?.id ?? "subagent")) +
						theme.fg("dim", ` — ${status}${deliveryState}`),
					0,
					0,
				);
			},
		});

	// ── subagent_join tool ──
	if (shouldRegister("subagent_join"))
		pi.registerTool({
			name: "subagent_join",
			label: "Join Subagents",
			description:
				"Wait for a fixed set of child results and return one grouped result.",
			promptSnippet:
				"Wait for a fixed set of child results and return one grouped result.",
			parameters: SubagentJoinParams,

			async execute(_toolCallId, params, signal) {
				return joinSubagentResults(params, signal, pi);
			},

			renderCall(args, theme) {
				const count = Array.isArray(args.ids) ? args.ids.length : 0;
				return new Text(
					"▸ " +
						theme.fg("toolTitle", theme.bold("join")) +
						theme.fg("dim", ` ${count} child${count === 1 ? "" : "ren"}`),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				const details = result.details as SyncSubagentToolDetails | undefined;
				if (details?.error) {
					return new Text(
						theme.fg("danger", `✗ ${details.error}`),
						0,
						0,
					);
				}
				const status = details?.status ?? "completed";
				const count = Array.isArray(details?.ids) ? details.ids.length : 0;
				const deliveryState = details?.deliveryState ? ` · ${details.deliveryState}` : "";
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(`join ${count}`)) +
						theme.fg("dim", ` — ${status}${deliveryState}`),
					0,
					0,
				);
			},
		});

	// ── subagent_detach tool ──
	if (shouldRegister("subagent_detach"))
		pi.registerTool({
			name: "subagent_detach",
			label: "Detach Subagent",
			description:
				"Release explicit wait/join ownership and return a child to detached async behavior.",
			promptSnippet:
				"Release explicit wait/join ownership and return a child to detached async behavior.",
			parameters: SubagentDetachParams,

			async execute(_toolCallId, params) {
				return detachSubagentResult(params, pi);
			},

			renderCall(args, theme) {
				return new Text(
					"▸ " +
						theme.fg("toolTitle", theme.bold("detach")) +
						theme.fg("dim", ` ${args.id}`),
					0,
					0,
				);
			},

			renderResult(result, _opts, theme) {
				const details = result.details as SyncSubagentToolDetails | undefined;
				if (details?.error) {
					return new Text(
						theme.fg("danger", `✗ ${details.error}`),
						0,
						0,
					);
				}
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(`detach ${details?.id ?? "subagent"}`)) +
						theme.fg("dim", " — detached"),
					0,
					0,
				);
			},
		});

	// ── subagents_list tool ──
	if (shouldRegister("subagents_list") && !hideSubagentsListForAmbientTopLevel)
		pi.registerTool({
			name: "subagents_list",
			label: "List Subagents",
			description:
				"List all available subagent definitions. " +
				"Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
				"Project-local agents override global ones with the same name.",
			promptSnippet:
				"List all available subagent definitions. " +
				"Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
				"Project-local agents override global ones with the same name.",
			parameters: Type.Object({}),

			async execute() {
				const agents = getEffectiveAgentDefinitions();

				if (agents.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "No subagent definitions found.",
							},
						],
						details: { agents: [] },
					};
				}

				const lines = agents.map((a) => {
					const badge = a.source === "project" ? " (project)" : "";
					const desc = a.description ? ` — ${a.description}` : "";
					return `• ${a.name}${badge}${desc}`;
				});

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { agents },
				};
			},

			renderResult(result, _opts, theme) {
				const details = result.details as SubagentsListToolDetails | undefined;
				const agents = details?.agents ?? [];
				if (agents.length === 0) {
					return new Text(
						theme.fg("dim", "No subagent definitions found."),
						0,
						0,
					);
				}
				const lines = agents.map((a) => {
					const badge =
						a.source === "project"
							? theme.fg("accent", " (project)")
							: "";
					const desc = a.description
						? theme.fg("dim", ` — ${a.description}`)
						: "";
					return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${desc}`;
				});
				return new Text(lines.join("\n"), 0, 0);
			},
		});

	// ── subagent_kill tool ──
	pi.registerTool({
		name: "subagent_kill",
		label: "Kill Subagent",
		description:
			"Stop a running subagent by id or display name. Works for both background and interactive subagents.",
		promptSnippet:
			"Stop a running subagent by id or display name. Works for both background and interactive subagents.",
		parameters: SubagentKillParams,

		async execute(_toolCallId, params) {
			const match = findRunningSubagent(params.id);
			if (!match.running) {
				return {
					content: [
						{ type: "text", text: match.error ?? "Subagent not found." },
					],
					details: { error: match.error ?? "not found" },
				};
			}

			stopRunningSubagent(match.running);
			return {
				content: [
					{
						type: "text",
						text: `Stopping subagent "${match.running.name}" (${match.running.id}).`,
					},
				],
				details: {
					id: match.running.id,
					name: match.running.name,
					status: "stopping",
				},
			};
		},
	});

	// ── set_tab_title tool ──
	if (shouldRegister("set_tab_title"))
		pi.registerTool({
			name: "set_tab_title",
			label: "Set Tab Title",
			description:
				"Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
				"(e.g. setup, executing todos, reviewing). Keep titles short and informative.",
			promptSnippet:
				"Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows " +
				"(e.g. setup, executing todos, reviewing). Keep titles short and informative.",
			parameters: Type.Object({
				title: Type.String({
					description:
						"New tab title (also applied to workspace/session when supported)",
				}),
			}),

			async execute(_toolCallId, params) {
				if (!isMuxAvailable()) {
					return muxUnavailableResult("tab-title");
				}
				try {
					renameCurrentTab(params.title);
					renameWorkspace(params.title);
					return {
						content: [
							{
								type: "text",
								text: `Title set to: ${params.title}`,
							},
						],
						details: { title: params.title },
					};
				} catch (err: unknown) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return {
						content: [
							{
								type: "text",
								text: `Failed to set title: ${errorMessage}`,
							},
						],
						details: { error: errorMessage },
					};
				}
			},
		});

	// ── subagent_resume tool ──
	if (shouldRegister("subagent_resume"))
		pi.registerTool({
			name: "subagent_resume",
			label: "Resume Subagent",
			description:
				"Resume a previous sub-agent session in a new multiplexer pane. " +
				"IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
				"Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			promptSnippet:
				"Resume a previous sub-agent session in a new multiplexer pane. " +
				"IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
				"Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
				"Use when a sub-agent was cancelled or needs follow-up work.",
			parameters: Type.Object({
				sessionFile: Type.Optional(
					Type.String({
						description: "Path to the session .jsonl file to resume",
					}),
				),
				name: Type.Optional(
					Type.String({
						description:
							"Display name for the terminal tab. Default: 'Resume'",
					}),
				),
				task: Type.Optional(
					Type.String({
						description:
							"Optional follow-up task to send after resuming",
					}),
				),
			}),

			renderCall(args, theme) {
				const name = args.name ?? "Resume";
				const text =
					"▸ " +
					theme.fg("toolTitle", theme.bold(name)) +
					theme.fg("dim", " — resuming session");
				return new Text(text, 0, 0);
			},

			renderResult(result, _opts, theme) {
				const details = result.details as ResumeToolDetails | undefined;
				const name = details?.name ?? "Resume";

				if (details?.status === "started") {
					return new Text(
						theme.fg("accent", "▸") +
							" " +
							theme.fg("toolTitle", theme.bold(name)) +
							theme.fg("dim", " — resumed"),
						0,
						0,
					);
				}

				// Fallback
				const text =
					typeof result.content?.[0]?.text === "string"
						? result.content[0].text
						: "";
				return new Text(theme.fg("dim", text), 0, 0);
			},

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const name = params.name ?? "Resume";
				const sessionFile = params.sessionFile;
				const task = params.task;
				const startTime = Date.now();

				if (!sessionFile) {
					return {
						content: [
							{ type: "text", text: "Error: sessionFile is required." },
						],
						details: { error: "session file required" },
					};
				}
				if (!isMuxAvailable()) {
					return muxUnavailableResult("subagents");
				}
				if (!existsSync(sessionFile)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: session file not found: ${sessionFile}`,
							},
						],
						details: { error: "session not found" },
					};
				}

				const entryCountBefore = getEntryCount(sessionFile);
				const surface = createSurface(name);
				await new Promise<void>((resolve) => setTimeout(resolve, 500));

				const parts = ["pi", "--session", shellEscape(sessionFile)];
				const subagentDonePath = join(
					dirname(new URL(import.meta.url).pathname),
					"subagent-done.ts",
				);
				parts.push("-e", shellEscape(subagentDonePath));

				let cleanupMsgFile: string | undefined;
				if (task) {
					const msgFile = join(tmpdir(), `subagent-resume-${Date.now()}.md`);
					writeFileSync(msgFile, task, "utf8");
					cleanupMsgFile = msgFile;
					parts.push(`@${msgFile}`);
				}

				const resumeEnvParts: string[] = [];
				if (process.env.PI_CODING_AGENT_DIR) {
					resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
				}
				if (process.env.PI_DENY_TOOLS) {
					resumeEnvParts.push(`PI_DENY_TOOLS=${shellEscape(process.env.PI_DENY_TOOLS)}`);
				}
				resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
				resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionFile)}`);
				resumeEnvParts.push("PI_SUBAGENT_AUTO_EXIT=1");
				resumeEnvParts.push(
					`PI_ARTIFACT_PROJECT_ROOT=${shellEscape(resolveArtifactProjectRoot(ctx.cwd))}`,
				);
				const resumeEnvPrefix = `${resumeEnvParts.join(" ")} `;
				const command = `${resumeEnvPrefix}${parts.join(" ")}${cleanupMsgFile ? `; rm -f ${shellEscape(cleanupMsgFile)}` : ""}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
				sendCommand(surface, command);

				const id = Math.random().toString(16).slice(2, 10);
				const running: RunningSubagent = {
					id,
					name,
					task: task ?? "resumed session",
					mode: "interactive",
					executionState: "running",
					deliveryState: "detached",
					parentClosePolicy: "terminate",
					blocking: false,
					surface,
					startTime,
					sessionFile,
				};
				runningSubagents.set(id, running);
				startWidgetRefresh();

				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;

				watchSubagent(running, watcherAbort.signal)
					.then((result) => {
						const allEntries = getNewEntries(sessionFile, entryCountBefore);
						const summary =
							findLastAssistantMessage(allEntries) ??
							(result.exitCode !== 0
								? `Resumed session exited with code ${result.exitCode}`
								: "Resumed session exited without new output");
						handleDetachedSubagentOutcome(pi, running, {
							...result,
							summary,
							sessionFile,
						});
					})
					.catch((err) => {
						updateWidget();
						pi.sendMessage(
							{
								customType: "subagent_result",
								content: `Resume error: ${err?.message ?? String(err)}`,
								display: true,
								details: { name, error: err?.message },
							},
							{ triggerTurn: true, deliverAs: "steer" },
						);
					});

				return {
					content: [{ type: "text", text: `Session "${name}" resumed.` }],
					details: {
						id,
						name,
						sessionFile,
						status: "started",
						deliveryState: "detached",
						parentClosePolicy: "terminate",
						blocking: false,
					},
				};
			},
		});

	// /iterate command — fork the session into a named iterate agent
	pi.registerCommand("iterate", {
		description:
			"Fork session into the named iterate agent for focused work",
		handler: async (args, ctx) => {
			const task = args?.trim() || "";
			const agentName = "iterate";
			const defs = loadAgentDefaults(agentName, null, ctx.cwd);
			if (!defs) {
				ctx.ui.notify(
					"/iterate now requires an existing \"iterate\" agent. Create that agent or use /subagent <agent> <task>.",
					"error",
				);
				return;
			}
			const taskText =
				task ||
				"The user wants to do some hands-on work. Help them with whatever they need.";
			const toolCall = `Use subagent with agent: "${agentName}", fork: true, name: "Iterate", task: ${JSON.stringify(taskText)}`;
			pi.sendUserMessage(toolCall);
		},
	});

	// /subagent command — spawn a subagent by name
	pi.registerCommand("subagent", {
		description: "Spawn a subagent: /subagent <agent> <task>",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
				return;
			}

			const spaceIdx = trimmed.indexOf(" ");
			const agentName =
				spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const task =
				spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			const defs = loadAgentDefaults(agentName, null, ctx.cwd);
			if (!defs) {
				ctx.ui.notify(
					`Agent "${agentName}" not found in the global agent config or .pi/agents/`,
					"error",
				);
				return;
			}

			const taskText =
				task ||
				`You are the ${agentName} agent. Wait for instructions.`;
			const displayName = agentName[0].toUpperCase() + agentName.slice(1);
			const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
			pi.sendUserMessage(toolCall);
		},
	});

	// /subagent-kill command — stop a running subagent by id or display name
	pi.registerCommand("subagent-kill", {
		description: "Stop a running subagent: /subagent-kill <id|name>",
		handler: async (args, ctx) => {
			const query = (args ?? "").trim();
			if (!query) {
				ctx.ui.notify("Usage: /subagent-kill <id|name>", "warning");
				return;
			}

			const match = findRunningSubagent(query);
			if (!match.running) {
				ctx.ui.notify(match.error ?? "Subagent not found.", "error");
				return;
			}

			stopRunningSubagent(match.running);
			ctx.ui.notify(
				`Stopping subagent \"${match.running.name}\" (${match.running.id})`,
				"info",
			);
		},
	});

	// ── subagent_result message renderer ──
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		const details = message.details as SubagentResultMessageDetails | undefined;
		if (!details) return undefined;

		return {
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const exitCode = details.exitCode ?? 0;
				const elapsed =
					details.elapsed != null
						? formatElapsed(details.elapsed)
						: "?";
				const bgFn =
					exitCode === 0
						? (text: string) => theme.bg("toolSuccessBg", text)
						: (text: string) => theme.bg("toolErrorBg", text);
				const icon =
					exitCode === 0
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
				const status =
					exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";

				const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
				const rawContent =
					typeof message.content === "string" ? message.content : "";

				const summary = rawContent
					.replace(/\n\nSession: .+\nResume: .+$/, "")
					.replace(
						`Sub-agent "${name}" completed (${elapsed}).\n\n`,
						"",
					)
					.replace(
						`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`,
						"",
					);

				const contentLines = [header];

				if (options.expanded) {
					if (summary) {
						for (const line of summary.split("\n")) {
							contentLines.push(line.slice(0, width - 6));
						}
					}
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(
							theme.fg("dim", `Session: ${details.sessionFile}`),
						);
						contentLines.push(
							theme.fg(
								"dim",
								`Resume:  pi --session ${details.sessionFile}`,
							),
						);
					}
				} else {
					if (summary) {
						const previewLines = summary.split("\n").slice(0, 5);
						for (const line of previewLines) {
							contentLines.push(
								theme.fg("dim", line.slice(0, width - 6)),
							);
						}
						const totalLines = summary.split("\n").length;
						if (totalLines > 5) {
							contentLines.push(
								theme.fg(
									"muted",
									`… ${totalLines - 5} more lines`,
								),
							);
						}
					}
					contentLines.push(
						theme.fg(
							"muted",
							keyHint("app.tools.expand", "to expand"),
						),
					);
				}

				const box = new Box(1, 1, bgFn);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		const details = message.details as SubagentPingMessageDetails | undefined;
		if (!details) return undefined;

		return {
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const elapsed =
					details.elapsed != null
						? formatElapsed(details.elapsed)
						: "?";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";
				const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} needs help ${theme.fg("dim", `(${elapsed})`)}`;
				const rawMessage = details.message ?? (typeof message.content === "string" ? message.content : "");
				const body = rawMessage.replace(/\n\nSession: .+\nResume: .+$/, "");
				const contentLines = [header];

				if (options.expanded) {
					for (const line of body.split("\n")) {
						if (line) contentLines.push(line.slice(0, width - 6));
					}
					if (details.sessionFile) {
						contentLines.push("");
						contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
						contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
					}
				} else {
					const previewLines = body.split("\n").filter(Boolean).slice(0, 4);
					for (const line of previewLines) {
						contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
					}
					contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
				}

				const box = new Box(1, 1, (text: string) => theme.bg("toolBg", text));
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}
