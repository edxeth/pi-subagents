import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvString } from "../launch/env.ts";
import { getAgentConfigDir } from "../agents/definitions.ts";

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

/** Reasoning efforts the library's `DEEPSEEK_EFFORT` setting understands. */
export const LIBRARY_REASONING_EFFORTS = ["off", "low", "high", "max"] as const;
export type LibraryReasoningEffort = (typeof LIBRARY_REASONING_EFFORTS)[number];

const EFFORT_ALIASES: Record<string, LibraryReasoningEffort> = {
	off: "off",
	disabled: "off",
	none: "off",
	low: "low",
	high: "high",
	max: "max",
};

export type VerifierProfileSource = "project" | "global" | "bundled";

export class VerifierProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifierProfileError";
	}
}

export class VerifierCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifierCredentialError";
	}
}

export interface NormalizedVerifierModelRef {
	/** Provider prefix as written (`deepseek` in `deepseek/deepseek-v4-flash`), if any. */
	provider: string | null;
	/** Plain library model id: provider prefix and `:thinking` suffix stripped. */
	modelId: string;
	/** Reasoning effort translated from a `:thinking` suffix, if present. */
	thinking: LibraryReasoningEffort | null;
	/** Canonical display form (`deepseek/deepseek-v4-flash:high`). */
	normalizedRef: string;
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

/**
 * Normalize a `provider/model[:thinking]` ref to what the library accepts:
 * a plain model id. The library forwards the model string verbatim
 * (`resolve_model`), so a prefixed or suffixed ref would be rejected upstream.
 */
export function normalizeVerifierModelRef(ref: string): NormalizedVerifierModelRef {
	const trimmed = ref.trim();
	if (!trimmed) throw new VerifierProfileError("Verifier model ref is empty.");
	let main = trimmed;
	let thinking: LibraryReasoningEffort | null = null;
	const colon = trimmed.lastIndexOf(":");
	if (colon !== -1) {
		const suffix = trimmed.slice(colon + 1).trim();
		const effort = EFFORT_ALIASES[suffix.toLowerCase()];
		if (!effort) {
			throw new VerifierProfileError(
				`Verifier model ref ${JSON.stringify(ref)} has an invalid :thinking suffix. Use one of ${LIBRARY_REASONING_EFFORTS.join(", ")}.`,
			);
		}
		thinking = effort;
		main = trimmed.slice(0, colon).trim();
	}
	let provider: string | null = null;
	let modelId = main;
	if (main.includes("/")) {
		const parts = main.split("/").map((part) => part.trim());
		if (parts.length !== 2) {
			throw new VerifierProfileError(
				`Verifier model ref ${JSON.stringify(ref)} must be provider/model or model (got ${parts.length} "/"-separated parts).`,
			);
		}
		if (!parts[0] || !parts[1]) {
			throw new VerifierProfileError(
				`Verifier model ref ${JSON.stringify(ref)} has an empty provider or model id.`,
			);
		}
		provider = parts[0];
		modelId = parts[1];
	}
	if (!modelId) throw new VerifierProfileError(`Verifier model ref ${JSON.stringify(ref)} has an empty model id.`);
	const normalizedRef = `${provider ? `${provider}/` : ""}${modelId}${thinking ? `:${thinking}` : ""}`;
	return { provider, modelId, thinking, normalizedRef };
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

/** Credential the library needs for a given plain model id (mirrors its create_client order). */
export function requiredCredentialForModel(modelId: string): string {
	if (modelId.startsWith("deepseek")) return "DEEPSEEK_API_KEY";
	if (modelId.startsWith("gemini")) return "VERTEX_API_KEY";
	return "OPENAI_BASE_URL";
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
	credential: { key: string | null; via: "profile-env" | "process-env" | "endpoint" | "not-required" };
}

/**
 * Resolve the verifier model for a launch. Precedence:
 * `llm-as-a-verifier-model` override → `verifiers/default.md` profile →
 * library default. A `-model`-only override still inherits the default
 * profile's `env` block for credentials.
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
	const credential = checkCredential(model, effectiveEnv, profile.env);
	return {
		model,
		modelRef: { ...modelRef, modelId: model },
		profile: { name: profile.name, source: profile.source, path: profile.path },
		thinking: thinking ?? null,
		env: profile.env,
		credential,
	};
}

function checkCredential(
	modelId: string,
	effectiveEnv: NodeJS.ProcessEnv,
	profileEnv: Record<string, string>,
): ResolvedVerifierModel["credential"] {
	// OPENAI_BASE_URL satisfies any model: the library builds an
	// OpenAI-compatible client for whatever id it is handed.
	if (effectiveEnv.OPENAI_BASE_URL) return { key: null, via: "endpoint" };
	const key = requiredCredentialForModel(modelId);
	if (profileEnv[key]) return { key, via: "profile-env" };
	if (effectiveEnv[key]) return { key, via: "process-env" };
	return { key, via: "not-required" };
}

/**
 * Fail closed before any candidate spend when the resolved verifier model has
 * no credential in the profile env block or the process env. The library
 * would otherwise raise MissingAPIKeyError only after candidates were paid
 * for (or silently score with the wrong backend).
 */
export function assertVerifierCredentials(
	resolved: ResolvedVerifierModel,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (resolved.credential.via !== "not-required") return;
	const key = resolved.credential.key;
	if (!key) return;
	const pinnedKeys = Object.keys(resolved.env ?? {});
	const repair = [
		`Verifier model "${resolved.model}" needs ${key} before any candidate can launch (never send a keyless request).`,
		pinnedKeys.length > 0
			? `The verifier profile (${resolved.profile.path}) pins env ${pinnedKeys.join(", ")} but not ${key}.`
			: `The verifier profile (${resolved.profile.path}) pins no env keys.`,
		`Fix: add "${key}=..." to the env block of ${resolved.profile.path}, export ${key} in the environment, or set llm-as-a-verifier-model to a model you have credentials for.`,
	].join(" ");
	throw new VerifierCredentialError(repair);
}
