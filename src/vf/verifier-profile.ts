import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvString } from "../launch/env.ts";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { EFFORT_ALIASES, LIBRARY_REASONING_EFFORTS, normalizeVerifierModelRef } from "./model-ref.ts";
import type { LibraryReasoningEffort, NormalizedVerifierModelRef } from "./model-ref.ts";

// Re-exported for callers of the profile module; the ref grammar itself lives
// in model-ref.ts so agent-definition parsing can validate refs without a
// config-dir cycle back into definitions.
export { normalizeVerifierModelRef, LIBRARY_REASONING_EFFORTS } from "./model-ref.ts";

/**
 * Verifier profiles (`agents/verifiers/<name>.md`).
 *
 * A verifier profile is a scoring PROFILE, not an agent: it names the model
 * that scores candidate traces and the credentials the scoring bridge needs.
 * It is never launched as a child session and accepts no tools, skills,
 * spawning, session-mode, or cwd fields.
 */

/** Model id the `llm-verifier` library uses when none is passed. */
export const LIBRARY_DEFAULT_VERIFIER_MODEL = "gemini-2.5-flash";

export type VerifierProfileSource = "project" | "global" | "bundled";

export class VerifierProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifierProfileError";
	}
}

export interface VerifierProfile {
	name: string;
	source: VerifierProfileSource;
	/** File the profile was read from; synthetic for the bundled profile. */
	path: string;
	/** Plain library model id (provider prefix / `:thinking` stripped). */
	model: string;
	modelRef: NormalizedVerifierModelRef;
	thinking: LibraryReasoningEffort | null;
	env: Record<string, string>;
}

/** The bundled profile that makes `llm-as-a-verifier: true` work out of the box. */
const BUNDLED_DEFAULT_PROFILE_SOURCE = `---
model: deepseek-v4-flash
env:
  # Credentials come from the launching process env (DEEPSEEK_API_KEY=...).
  # Set them here instead if you prefer keeping the key in the profile:
  # DEEPSEEK_API_KEY=sk-...
---
Bundled default verifier profile: DeepSeek deepseek-v4-flash, credentials
from the environment. Override with .pi/agents/verifiers/default.md (project)
or ~/.pi/agent/agents/verifiers/default.md (global).
`;

export function getVerifierProfileDirs(baseCwd: string): { project: string; global: string } {
	return {
		project: join(baseCwd, ".pi", "agents", "verifiers"),
		global: join(getAgentConfigDir(), "agents", "verifiers"),
	};
}

interface ParsedFrontmatter {
	/** Top-level keys in declaration order. */
	keys: string[];
	values: Map<string, string | undefined>;
	envBlock: string | undefined;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return { keys: [], values: new Map(), envBlock: undefined };
	const lines = match[1].split(/\r?\n/);
	const keys: string[] = [];
	const values = new Map<string, string | undefined>();
	let envBlock: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim() || line.trim().startsWith("#")) continue;
		if (/^\s/.test(line)) continue; // block continuation
		const keyMatch = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
		if (!keyMatch) continue;
		const key = keyMatch[1];
		const inline = keyMatch[2].trim();
		keys.push(key);
		if (inline === "|") {
			const block: string[] = [];
			for (let i = index + 1; i < lines.length; i++) {
				const blockLine = lines[i];
				if (blockLine.trim() && !/^[ \t]/.test(blockLine)) break;
				block.push(blockLine.replace(/^[ \t]{1,2}/, ""));
			}
			const blockText = block.join("\n").trim();
			if (key === "env") envBlock = blockText;
			else values.set(key, blockText);
			continue;
		}
		values.set(key, inline || undefined);
	}
	return { keys, values, envBlock };
}

const ALLOWED_PROFILE_KEYS = new Set(["model", "thinking", "env"]);

export function parseVerifierProfileSource(
	name: string,
	content: string,
	source: VerifierProfileSource,
	path: string,
): VerifierProfile {
	const { keys, values, envBlock } = parseFrontmatter(content);
	if (keys.length === 0) {
		throw new VerifierProfileError(
			`Verifier profile ${path} has no frontmatter. Expected a --- block with model (required), thinking (optional), and env (optional).`,
		);
	}
	const disallowed = keys.filter((key) => !ALLOWED_PROFILE_KEYS.has(key));
	if (disallowed.length > 0) {
		throw new VerifierProfileError(
			`Verifier profile ${path} has field(s) ${disallowed
				.map((key) => `"${key}"`)
				.join(", ")} that a verifier profile must not have. Allowed fields: model (required), thinking (optional), env (optional block). A verifier is a scoring profile, not an agent.`,
		);
	}
	const modelRaw = values.get("model");
	if (!modelRaw) {
		throw new VerifierProfileError(`Verifier profile ${path} is missing the required "model" field.`);
	}
	const modelRef = normalizeVerifierModelRef(modelRaw);
	const thinkingRaw = values.get("thinking");
	const fieldThinking = thinkingRaw ? parseEffort("thinking", thinkingRaw, path) : null;
	if (fieldThinking !== null && modelRef.thinking !== null && fieldThinking !== modelRef.thinking) {
		throw new VerifierProfileError(
			`Verifier profile ${path} sets thinking twice with different values: model suffix ":${modelRef.thinking}" vs field "${fieldThinking}". Remove one.`,
		);
	}
	let env: Record<string, string> = {};
	if (envBlock !== undefined && envBlock !== "") {
		try {
			env = parseEnvString(envBlock);
		} catch (error) {
			throw new VerifierProfileError(`Verifier profile ${path} has an invalid env block: ${(error as Error).message}`);
		}
	}
	return {
		name,
		source,
		path,
		model: modelRef.modelId,
		modelRef,
		thinking: fieldThinking ?? modelRef.thinking,
		env,
	};
}

function parseEffort(field: string, raw: string, path: string): LibraryReasoningEffort {
	const effort = EFFORT_ALIASES[raw.trim().toLowerCase()];
	if (!effort) {
		throw new VerifierProfileError(
			`Verifier profile ${path}: ${field} must be one of ${LIBRARY_REASONING_EFFORTS.join(", ")} (got ${JSON.stringify(raw)}).`,
		);
	}
	return effort;
}

export function resolveVerifierProfile(name: string, baseCwd: string): VerifierProfile {
	const dirs = getVerifierProfileDirs(baseCwd);
	const file = `${name}.md`;
	const projectPath = join(dirs.project, file);
	if (existsSync(projectPath)) {
		return parseVerifierProfileSource(name, readFileSync(projectPath, "utf8"), "project", projectPath);
	}
	const globalPath = join(dirs.global, file);
	if (existsSync(globalPath)) {
		return parseVerifierProfileSource(name, readFileSync(globalPath, "utf8"), "global", globalPath);
	}
	if (name === "default") {
		return parseVerifierProfileSource(name, BUNDLED_DEFAULT_PROFILE_SOURCE, "bundled", "(bundled: verifiers/default.md)");
	}
	throw new VerifierProfileError(
		`Verifier profile "${name}" was not found. Looked for ${projectPath} and ${globalPath}. A verifier profile is a model+credentials file with model (required), thinking (optional), and env (optional).`,
	);
}

export interface ResolvedVerifierModel {
	/** Plain library model id — the exact string `select(model=...)` receives. */
	model: string;
	modelRef: NormalizedVerifierModelRef;
	/** Profile the credentials were inherited from. */
	profile: { name: string; source: VerifierProfileSource; path: string };
	/** Reasoning effort for the bridge to apply (library setting `DEEPSEEK_EFFORT`). */
	thinking: LibraryReasoningEffort | null;
	/** Env vars the profile pins; merged over the process env for the bridge process. */
	env: Record<string, string>;
}

/**
 * Resolve the verifier model for a launch. Precedence:
 * `llm-as-a-verifier-model` override → `verifiers/default.md` profile →
 * library default. A `-model`-only override still inherits the default
 * profile's `env` block for credentials. Resolution is credential-agnostic:
 * which env var a backend needs is the library's contract — the bridge probe
 * surfaces it (typed `credentials` failure) before any candidate spend, so no
 * env-var name is ever inferred here from the model name.
 */
export function resolveVerifierModel(options: {
	override?: string | undefined;
	baseCwd: string;
	env?: NodeJS.ProcessEnv;
}): ResolvedVerifierModel {
	const processEnv = options.env ?? process.env;
	const profile = resolveVerifierProfile("default", options.baseCwd);
	const effectiveEnv = { ...processEnv, ...profile.env };
	const modelRef = options.override ? normalizeVerifierModelRef(options.override) : profile.modelRef;
	// The bundled/project/global default always names a model, so the library
	// default is a safety net, not a reachable branch.
	const model = modelRef.modelId || LIBRARY_DEFAULT_VERIFIER_MODEL;
	const thinking = options.override ? modelRef.thinking : profile.thinking;
	return {
		model,
		modelRef: { ...modelRef, modelId: model },
		profile: { name: profile.name, source: profile.source, path: profile.path },
		thinking: thinking ?? null,
		env: profile.env,
	};
}
