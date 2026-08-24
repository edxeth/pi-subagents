import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvString } from "../launch/env.ts";
import { getAgentConfigDir } from "../agents/definitions.ts";
import { normalizeVerifierModelRef } from "./model-ref.ts";
import type { LibraryReasoningEffort } from "./model-ref.ts";

// Re-exported for callers of the profile module; the ref grammar itself lives
// in model-ref.ts so agent-definition parsing can validate refs without a
// config-dir cycle back into definitions.
export { normalizeVerifierModelRef, LIBRARY_REASONING_EFFORTS } from "./model-ref.ts";

/**
 * Verifier profiles (`agents/verifiers/<name>.md`).
 *
 * A verifier profile is a scoring PROFILE, not an agent: it names the model
 * that scores candidate traces and may pin the credentials the scoring bridge
 * needs. It is never launched as a child session and accepts no tools, skills,
 * spawning, session-mode, or cwd fields.
 */

export type VerifierProfileSource = "project" | "global";

export class VerifierProfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifierProfileError";
	}
}

export interface VerifierProfile {
	name: string;
	source: VerifierProfileSource;
	/** File the profile was read from. */
	path: string;
	/** Plain library model id (provider prefix / `:thinking` stripped). */
	model: string;
	thinking: LibraryReasoningEffort | null;
	/** Provider named by a `provider/model` ref, when the profile used one. */
	provider: string | null;
	env: Record<string, string>;
}

/** Everything a launch needs to run the verifier: model, effort, and the
 * complete set of library env vars — exactly one backend door. */
export interface ResolvedVerifierModel {
	model: string;
	thinking: LibraryReasoningEffort | null;
	env: Record<string, string>;
}

export function getVerifierProfileDirs(baseCwd: string): { project: string; global: string } {
	return {
		project: join(baseCwd, ".pi", "agents", "verifiers"),
		global: join(getAgentConfigDir(), "agents", "verifiers"),
	};
}

interface ParsedFrontmatter {
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
		if (/^env:\s*(\|.*)?$/.test(line)) {
			const block: string[] = [];
			for (let next = index + 1; next < lines.length; next++) {
				if (lines[next].startsWith("  ") || lines[next].startsWith("\t")) block.push(lines[next]);
				else break;
			}
			envBlock = block.map((l) => l.replace(/^(\t| )/, "")).join("\n");
			index += block.length;
			continue;
		}
		const split = line.indexOf(":");
		if (split === -1) continue;
		const key = line.slice(0, split).trim();
		if (!key) continue;
		if (keys.includes(key)) continue;
		keys.push(key);
		values.set(key, line.slice(split + 1).trim() || undefined);
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
	const unknown = keys.filter((key) => !ALLOWED_PROFILE_KEYS.has(key));
	if (unknown.length > 0) {
		throw new VerifierProfileError(
			`verifier profile ${path} has unknown field(s) ${unknown.join(", ")}; allowed: model, thinking, env.`,
		);
	}
	const modelRaw = values.get("model");
	if (!modelRaw) throw new VerifierProfileError(`verifier profile ${path} must set model.`);
	const thinkingRaw = values.get("thinking");
	let thinking: LibraryReasoningEffort | null = null;
	if (thinkingRaw) {
		const map: Record<string, LibraryReasoningEffort> = {
			off: "off",
			disabled: "off",
			none: "off",
			low: "low",
			high: "high",
			max: "max",
		};
		thinking = map[thinkingRaw.toLowerCase()] ?? null;
		if (!thinking) {
			throw new VerifierProfileError(
				`verifier profile ${path}: thinking must be one of off, low, high, max (got ${JSON.stringify(thinkingRaw)}).`,
			);
		}
	}
	let provider: string | null = null;
	let model = modelRaw;
	if (modelRaw.includes("/")) {
		try {
			const ref = normalizeVerifierModelRef(modelRaw);
			provider = ref.provider;
			model = ref.modelId;
			thinking = thinking ?? ref.thinking;
		} catch (error) {
			throw new VerifierProfileError(`verifier profile ${path}: ${(error as Error).message}`);
		}
	}
	const env = envBlock ? parseEnvString(envBlock) : {};
	return { name, source, path, model, thinking, provider, env };
}

class VerifierProfileNotFoundError extends VerifierProfileError {
	constructor(message: string) {
		super(message);
		this.name = "VerifierProfileNotFoundError";
	}
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
	throw new VerifierProfileNotFoundError(
		`Verifier profile "${name}" was not found. Looked for ${projectPath} and ${globalPath}. A verifier profile is a model+credentials file with model (required), thinking (optional), and env (optional).`,
	);
}

/** The library's env-var "doors" — exactly one complete door may be open. */
const GENERIC_DOOR_VARS = ["OPENAI_BASE_URL", "OPENAI_API_KEY"] as const;
const DOOR_FAMILIES = [GENERIC_DOOR_VARS, ["DEEPSEEK_API_KEY"], ["VERTEX_API_KEY"]] as const;

/** A profile env block pins at most one door family, and a generic door
 * without its URL is incomplete (a key alone routes nowhere). */
function assertCompleteProfileDoor(env: Record<string, string>, profilePath: string): boolean {
	const families = DOOR_FAMILIES.filter((family) => family.some((name) => env[name]));
	if (families.length > 1) {
		throw new VerifierProfileError(
			`verifier profile ${profilePath} sets more than one backend door (${families.map((f) => f[0]).join(", ")}); keep exactly one so the choice is unambiguous.`,
		);
	}
	if (env.OPENAI_API_KEY && !env.OPENAI_BASE_URL) {
		throw new VerifierProfileError(
			`verifier profile ${profilePath} sets OPENAI_API_KEY without OPENAI_BASE_URL; a key alone does not name an endpoint.`,
		);
	}
	return families.length === 1;
}

interface PiModelEndpoint {
	baseUrl: string;
	apiKey?: string;
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

/** Literal, usable api key: pi's config allows `$ENV` and `!command` values
 * that only pi itself can resolve — those are not passed through raw. */
function literalKey(value: unknown): string | undefined {
	const key = asString(value);
	return key && !key.startsWith("$") && !key.startsWith("!") ? key : undefined;
}

/** The exact effective endpoint for provider/model from the user's own pi
 * config: models.json (exact-model entry, then provider default), then the
 * /login store's entry for that exact model. Never borrows another model's
 * URL. Key: models.json value, else the auth store. */
function piEndpointFor(provider: string, modelId: string): PiModelEndpoint | null {
	const configDir = getAgentConfigDir();
	const modelsJson = readJson(join(configDir, "models.json"));
	const providers = (modelsJson?.providers ?? {}) as Record<
		string,
		{ baseUrl?: unknown; apiKey?: unknown; models?: Array<{ id?: unknown; baseUrl?: unknown; apiKey?: unknown }> }
	>;
	const def = providers[provider];
	if (def) {
		const exact = (def.models ?? []).find((m) => asString(m.id) === modelId && asString(m.baseUrl));
		if (exact) {
			return { baseUrl: asString(exact.baseUrl)!, apiKey: literalKey(exact.apiKey) ?? literalKey(def.apiKey) };
		}
		const providerUrl = asString(def.baseUrl);
		if (providerUrl) return { baseUrl: providerUrl, apiKey: literalKey(def.apiKey) };
	}
	const store = readJson(join(configDir, "models-store.json"));
	const entry = ((store?.[provider] as { models?: Array<{ id?: unknown; baseUrl?: unknown }> } | undefined)?.models ?? []).find(
		(m) => asString(m.id) === modelId && asString(m.baseUrl),
	);
	if (entry) return { baseUrl: asString(entry.baseUrl)! };
	return null;
}

function authStoreKey(providerName: string): string {
	const auth = readJson(join(getAgentConfigDir(), "auth.json"));
	const key = (auth?.[providerName] as { key?: unknown } | undefined)?.key;
	return asString(key) ?? "";
}

/**
 * One deterministic door for the chosen provider/model. Order:
 *   1. the profile's own env block (validated complete, max one family)
 *   2. the matching provider-specific export (DEEPSEEK_API_KEY / VERTEX_API_KEY)
 *   3. the exact provider/model endpoint in pi's own config
 *   4. the exported generic door (OPENAI_BASE_URL, key optional) — only for
 *      providers pi does not know (self-hosted, custom)
 *   5. otherwise a fail-closed error naming what is missing
 * The fixed providers (deepseek, gemini) never route through a generic
 * export, and a provider is never inferred from the model id.
 */
function selectDoor(options: {
	provider: string | null;
	modelId: string;
	profileEnv: Record<string, string>;
	profilePath: string;
	processEnv: NodeJS.ProcessEnv;
}): Record<string, string> {
	const { provider, modelId, profileEnv, profilePath, processEnv } = options;
	if (assertCompleteProfileDoor(profileEnv, profilePath)) return {};
	if (!provider) {
		throw new VerifierProfileError(
			`verifier profile ${profilePath} names the model without a provider; write model: provider/${modelId}, or give the profile an env block with OPENAI_BASE_URL (and key if the endpoint needs one).`,
		);
	}
	const specific = provider === "deepseek" ? "DEEPSEEK_API_KEY" : provider === "gemini" ? "VERTEX_API_KEY" : null;
	if (specific && processEnv[specific]) return { [specific]: processEnv[specific] as string };
	const ep = piEndpointFor(provider, modelId);
	if (ep) {
		const key = ep.apiKey ?? authStoreKey(provider);
		return { OPENAI_BASE_URL: ep.baseUrl, ...(key ? { OPENAI_API_KEY: key } : {}) };
	}
	if (!specific && processEnv.OPENAI_BASE_URL) {
		return {
			OPENAI_BASE_URL: processEnv.OPENAI_BASE_URL,
			...(processEnv.OPENAI_API_KEY ? { OPENAI_API_KEY: processEnv.OPENAI_API_KEY } : {}),
		};
	}
	const wanted = specific ?? "OPENAI_BASE_URL (and OPENAI_API_KEY if the endpoint needs one)";
	throw new VerifierProfileError(
		`verifier model "${modelId}" (provider "${provider}") has no usable endpoint: pi's models.json and models-store.json have no entry for it and ${wanted} is not set. ` +
			`Add the provider to pi (/login or models.json), export ${specific ?? "OPENAI_BASE_URL"}, or give ${profilePath} an env block with OPENAI_BASE_URL.`,
	);
}

/**
 * Resolve the verifier for a launch. Grammar:
 *  - `provider/model[:thinking]` — a direct, binding model choice.
 *  - a bare value — a verifier profile (`verifiers/<name>.md`).
 *  - omitted — the `default` profile; with no field and no default profile
 *    the launch fails closed (a user setup decision — the error states the
 *    fact, never file-creation instructions).
 */
export function resolveVerifierModel(options: {
	override?: string | undefined;
	baseCwd: string;
	env?: NodeJS.ProcessEnv;
}): ResolvedVerifierModel {
	const override = options.override?.trim();
	const processEnv = options.env ?? process.env;
	if (override && override.includes("/")) {
		const ref = normalizeVerifierModelRef(override);
		return {
			model: ref.modelId,
			thinking: ref.thinking,
			env: selectDoor({
				provider: ref.provider,
				modelId: ref.modelId,
				profileEnv: {},
				profilePath: "the agent file",
				processEnv,
			}),
		};
	}
	const profileName = override ?? "default";
	let profile: VerifierProfile;
	try {
		profile = resolveVerifierProfile(profileName, options.baseCwd);
	} catch (error) {
		if (!override && error instanceof VerifierProfileNotFoundError) {
			throw new VerifierProfileError(
				"the verifier model is not configured for this agent — a user setup decision.",
			);
		}
		throw error;
	}
	return {
		model: profile.model,
		thinking: profile.thinking,
		env: {
			...selectDoor({
				provider: profile.provider,
				modelId: profile.model,
				profileEnv: profile.env,
				profilePath: profile.path,
				processEnv,
			}),
			...profile.env,
		},
	};
}
