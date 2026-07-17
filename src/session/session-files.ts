import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.ts";
import type { ParentClosePolicy, SubagentParamsInput } from "../types.ts";
import type { ZellijPlacementPolicy } from "../mux/zellij-placement.ts";
import { getEntries } from "./session.ts";


export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface ChildContextBoundaryOptions {
	name: string;
	agent?: string;
	spawningAllowed: boolean;
}

export type ResumeMode = "interactive" | "background";

export interface PersistedSubagentLaunchMetadata {
	version: 1;
	timestamp: string;
	name: string;
	title?: string;
	sessionTitle?: string;
	agent?: string;
	mode: ResumeMode;
	sessionMode: SubagentSessionMode;
	autoExit?: boolean;
	parentClosePolicy: ParentClosePolicy;
	/** @deprecated compat — stop writing. Readers treat `blocking: true` as `async: false`. */
	blocking?: boolean;
	async: boolean;
	model?: string;
	thinking?: string;
	modelRef?: string;
	definitionModel?: string;
	definitionThinking?: string;
	allowedModels?: string;
	allowModelOverride?: boolean;
	modelSource?: "parent" | "agent" | "launch-override" | "resume-override";
	requestedModelOverride?: string;
	requestedThinkingOverride?: string;
	ignoredModelOverride?: string;
	ignoredThinkingOverride?: string;
	tools?: string;
	skills?: string;
	injectSkills?: string;
	denyTools: string[];
	extensions?: string[];
	noContextFiles: boolean;
	noSession: boolean;
	trustProject?: boolean;
	agentConfigDir: string;
	cwd: string;
	systemPromptMode?: "append" | "replace";
	systemPrompt?: string;
	boundarySystemPrompt: boolean;
	taskExpansion?: "shell";
	zellijPlacementPolicy?: ZellijPlacementPolicy;
	zellijPlacementGroupKey?: string;

	flags?: string;
	env?: string;
}

const SUBAGENT_LAUNCH_METADATA_CUSTOM_TYPE =
	"pi-subagents_launch_metadata";

/**
 * Generate a unique session file path for a subagent.
 */
export function generateSubagentSessionFile(sessionDir: string): string {
	const ts = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23)}Z`;
	const uuid = [
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	return join(sessionDir, `${ts}_${uuid}.jsonl`);
}

export function getDoneSentinelFile(sessionFile: string, id: string): string {
	const base = basename(sessionFile, ".jsonl");
	return join(tmpdir(), `pi-subagent-done-${base}-${id}.txt`);
}

function writeHeaderOnlySubagentSessionFile(
	childSessionFile: string,
	cwd = process.cwd(),
	parentSessionFile?: string,
	sessionName?: string,
): void {
	if (existsSync(childSessionFile)) return;
	mkdirSync(dirname(childSessionFile), { recursive: true });
	writeFileSync(
		childSessionFile,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd,
			...(sessionName ? { name: sessionName } : {}),
			...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
		})}\n`,
		"utf8",
	);
}

export function seedSubagentSessionFile(
	mode: Exclude<SubagentSessionMode, "standalone">,
	parentSessionFile: string,
	childSessionFile: string,
	cwd = process.cwd(),
	seedOptions?: {
		sessionName?: string;
		activeLeafId?: string | null;
	},
): void {
	void cwd;
	mkdirSync(dirname(childSessionFile), { recursive: true });
	// Write a session header for lineage-only so the session file exists before
	// the background child starts. This prevents a race where the parent's
	// writeSubagentLaunchMetadataEntryWhenReady fallback writes a header that
	// the child then duplicates when Pi starts.
	if (mode === "lineage-only") {
		writeHeaderOnlySubagentSessionFile(childSessionFile, cwd, parentSessionFile, seedOptions?.sessionName);
		return;
	}

	if (mode === "fork") {
		const parentManager = SessionManager.open(parentSessionFile, undefined, cwd);
		const leafId = seedOptions?.activeLeafId ?? parentManager.getLeafId();
		if (!leafId) {
			writeHeaderOnlySubagentSessionFile(childSessionFile, cwd, parentSessionFile, seedOptions?.sessionName);
			return;
		}
		const branch = parentManager.getBranch(leafId);
		if (branch.length === 0) {
			writeHeaderOnlySubagentSessionFile(childSessionFile, cwd, parentSessionFile, seedOptions?.sessionName);
			return;
		}
		const header = {
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd,
			...(seedOptions?.sessionName ? { name: seedOptions.sessionName } : {}),
			parentSession: parentSessionFile,
		};
		writeFileSync(
			childSessionFile,
			`${[header, ...branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf8",
		);
		return;
	}
}

function getLastSessionEntryId(sessionFile: string): string | null {
	if (!existsSync(sessionFile)) return null;
	const lines = readFileSync(sessionFile, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const entry = JSON.parse(lines[i]);
			if (entry.type !== "session" && typeof entry.id === "string")
				return entry.id;
		} catch {
			// Ignore malformed historical lines here; session loading will report them later.
		}
	}
	return null;
}

export function writeChildContextBoundaryEntry(
	childSessionFile: string,
	options: ChildContextBoundaryOptions,
	content: string,
): void {
	if (!existsSync(childSessionFile)) return;
	const parentId = getLastSessionEntryId(childSessionFile);
	const line = JSON.stringify({
		type: "custom_message",
		customType: "subagent_boundary",
		content,
		display: false,
		details: { name: options.name, spawningAllowed: options.spawningAllowed },
		id: randomUUID().replace(/-/g, "").slice(0, 8),
		parentId,
		timestamp: new Date().toISOString(),
	});
	writeFileSync(childSessionFile, `${line}\n`, { flag: "a" });
}

export function writeSubagentExtensionEntry(
	path: string,
	extensions: string[] | undefined,
): void {
	if (extensions === undefined) return;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		`${path}.ext`,
		`${JSON.stringify({ extensions, timestamp: new Date().toISOString() })}\n`,
	);
}

export function writeSubagentModelStateEntries(
	path: string,
	metadata: Pick<PersistedSubagentLaunchMetadata, "model" | "thinking">,
): void {
	if (!metadata.model) return;
	const slash = metadata.model.indexOf("/");
	if (slash === -1) return;
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) writeHeaderOnlySubagentSessionFile(path);
	let parentId = getLastSessionEntryId(path);
	const modelId = randomUUID().slice(0, 8);
	appendFileSync(
		path,
		`${JSON.stringify({
			type: "model_change",
			id: modelId,
			parentId,
			timestamp: new Date().toISOString(),
			provider: metadata.model.slice(0, slash),
			modelId: metadata.model.slice(slash + 1),
		})}\n`,
		"utf8",
	);
	parentId = modelId;
	if (!metadata.thinking) return;
	appendFileSync(
		path,
		`${JSON.stringify({
			type: "thinking_level_change",
			id: randomUUID().slice(0, 8),
			parentId,
			timestamp: new Date().toISOString(),
			thinkingLevel: metadata.thinking,
		})}\n`,
		"utf8",
	);
}

export function writeSubagentLaunchMetadataEntry(
	path: string,
	metadata: PersistedSubagentLaunchMetadata,
): void {
	if (!existsSync(path)) return;
	const parentId = getLastSessionEntryId(path);
	const line = JSON.stringify({
		type: "custom",
		customType: SUBAGENT_LAUNCH_METADATA_CUSTOM_TYPE,
		data: metadata,
		id: randomUUID().replace(/-/g, "").slice(0, 8),
		parentId,
		timestamp: new Date().toISOString(),
	});
	appendFileSync(path, `${line}\n`, "utf8");
}

async function waitForSessionFile(
	path: string,
	timeoutMs = 5000,
): Promise<boolean> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (existsSync(path)) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	return existsSync(path);
}

export async function writeSubagentLaunchMetadataEntryWhenReady(
	path: string,
	metadata: PersistedSubagentLaunchMetadata,
	timeoutMs = 5000,
): Promise<void> {
	if (await waitForSessionFile(path, timeoutMs)) {
		writeSubagentLaunchMetadataEntry(path, metadata);
		return;
	}
	writeHeaderOnlySubagentSessionFile(path, metadata.cwd, undefined, metadata.sessionTitle);
	writeSubagentLaunchMetadataEntry(path, metadata);
}

export function isResumeMode(value: unknown): value is ResumeMode {
	return value === "interactive" || value === "background";
}

/**
 * Index of the first entry that belongs to this subagent's own activity.
 *
 * Forked child sessions are seeded with the parent transcript before the
 * `pi-subagents_launch_metadata` marker. Counting stats or usage from index 0
 * would include inherited parent history. Return the index just after the
 * marker, or 0 for standalone/lineage sessions that have no marker.
 */
export function getSubagentActivityStartIndex(
	entries: ReadonlyArray<{ type?: unknown; customType?: unknown }>,
): number {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry?.type === "custom" &&
			entry.customType === SUBAGENT_LAUNCH_METADATA_CUSTOM_TYPE
		) {
			return i + 1;
		}
	}
	return 0;
}

export function readSubagentLaunchMetadata(
	path: string,
): PersistedSubagentLaunchMetadata | undefined {
	try {
		const entries = getEntries(path) as Array<Record<string, unknown>>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry?.type !== "custom" ||
				entry.customType !== SUBAGENT_LAUNCH_METADATA_CUSTOM_TYPE
			)
				continue;
			const data = entry.data as
				| Partial<PersistedSubagentLaunchMetadata>
				| undefined;
			if (!data || data.version !== 1 || !isResumeMode(data.mode))
				return undefined;
			return data as PersistedSubagentLaunchMetadata;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

/**
 * Reads the extension list written by writeSubagentExtensionEntry from the
 * companion file. Returns the extension array or undefined if no file exists.
 */
export function readSubagentExtensionEntry(path: string): string[] | undefined {
	try {
		const extPath = `${path}.ext`;
		if (!existsSync(extPath)) return undefined;
		const content = readFileSync(extPath, "utf8");
		const entry = JSON.parse(content.trim());
		if (Array.isArray(entry?.extensions)) return entry.extensions;
	} catch {
		// best-effort; fall back to --no-extensions
	}
	return undefined;
}

export function resolveEffectiveSessionMode(
	_params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	if (agentDefs?.sessionMode) return agentDefs.sessionMode;
	if (agentDefs?.fork) return "fork";
	return "lineage-only";
}

export type ResolveSubagentNoSession = (agentDefs: AgentDefaults | null) => boolean;

export function resolveTaskSessionMode(
	agentDefs: AgentDefaults | null,
	resolveSubagentNoSession: ResolveSubagentNoSession,
	getNoSessionSeedMode: (
		sessionMode: SubagentSessionMode,
	) => Exclude<SubagentSessionMode, "standalone"> | null,
): SubagentSessionMode {
	const sessionMode = resolveEffectiveSessionMode({}, agentDefs);
	if (!resolveSubagentNoSession(agentDefs)) return sessionMode;
	return getNoSessionSeedMode(sessionMode) ?? sessionMode;
}

export function buildPiPromptArgs(
	skills: string[],
	taskArg: string,
	directTask: boolean,
): string[] {
	const skillPrompts = skills.map((skill) => `/skill:${skill}`);
	const isArtifactTask = taskArg.startsWith("@");
	const needsSeparator = isArtifactTask && (skillPrompts.length > 0 || directTask);
	return [...(needsSeparator ? [""] : []), ...skillPrompts, taskArg];
}

export function buildIdentityBlock(
	agentDefs: AgentDefaults | null,
	systemPrompt?: string,
): string {
	return [agentDefs?.body, systemPrompt]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim() !== "",
		)
		.join("\n\n");
}
