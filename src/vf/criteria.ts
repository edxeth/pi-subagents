import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Criteria resolution for verified fan-out (ticket 10).
 *
 * `llm-as-a-verifier-criteria` is either a built-in packaged rubric name or
 * a filesystem path. It resolves to an absolute file at pre-flight — before
 * any candidate spend — and fails closed with the tried locations when it
 * cannot.
 */

export const BUILTIN_VERIFIER_CRITERIA_NAMES = ["generic", "code-change", "research"] as const;
type BuiltinVerifierCriteriaName = (typeof BUILTIN_VERIFIER_CRITERIA_NAMES)[number];

export const DEFAULT_VERIFIER_CANDIDATES = 3;
export const VERIFIER_CANDIDATES_ENV_VAR = "PI_SUBAGENT_LLM_VERIFIER_CANDIDATES";

export class VerifierCriteriaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifierCriteriaError";
	}
}

/** Directory of packaged rubrics shipped with the extension. */
export function getPackagedCriteriaDir(): string {
	return fileURLToPath(new URL("./criteria/", import.meta.url));
}

export interface ResolvedVerifierCriteria {
	kind: "builtin" | "path";
	/** Built-in rubric name, when kind is "builtin". */
	name?: BuiltinVerifierCriteriaName;
	/** Absolute path of the criteria file the bridge receives. */
	path: string;
	/** True when no value was set and the packaged generic fallback applied. */
	default: boolean;
}

function assertReadableCriteriaFile(path: string, raw: string): void {
	if (!existsSync(path)) {
		throw new VerifierCriteriaError(
			`llm-as-a-verifier-criteria ${JSON.stringify(raw)} does not resolve to an existing file (tried ${path}). Built-in names: ${BUILTIN_VERIFIER_CRITERIA_NAMES.join(", ")}. Relative paths resolve against the launch cwd.`,
		);
	}
	if (!statSync(path).isFile()) {
		throw new VerifierCriteriaError(
			`llm-as-a-verifier-criteria ${JSON.stringify(raw)} resolves to ${path}, which is not a file.`,
		);
	}
	if (readFileSync(path, "utf8").trim().length === 0) {
		throw new VerifierCriteriaError(
			`llm-as-a-verifier-criteria ${JSON.stringify(raw)} resolves to ${path}, which is empty.`,
		);
	}
}

/**
 * Resolve the criteria value to an absolute file path. Relative paths resolve
 * against the launch cwd. Unresolvable values throw before any candidate
 * spend; format validity is additionally enforced by the bridge runner
 * (criteria exit code) before it calls the verifier backend.
 */
export function resolveVerifierCriteria(raw: string | undefined, baseCwd: string): ResolvedVerifierCriteria {
	const value = raw?.trim();
	if (!value) {
		const name = "generic";
		const path = join(getPackagedCriteriaDir(), `${name}.md`);
		assertReadableCriteriaFile(path, "(default: generic)");
		return { kind: "builtin", name, path, default: true };
	}
	if ((BUILTIN_VERIFIER_CRITERIA_NAMES as readonly string[]).includes(value)) {
		const name = value as BuiltinVerifierCriteriaName;
		const path = join(getPackagedCriteriaDir(), `${name}.md`);
		assertReadableCriteriaFile(path, value);
		return { kind: "builtin", name, path, default: false };
	}
	const path = isAbsolute(value) ? value : resolve(baseCwd, value);
	assertReadableCriteriaFile(path, value);
	return { kind: "path", path, default: false };
}

/**
 * Resolve the candidate count: explicit frontmatter value (validated at agent
 * load) > PI_SUBAGENT_LLM_VERIFIER_CANDIDATES > 3. The env fallback is a
 * global default, so an invalid value still fails closed here rather than
 * silently running a 1-candidate "fan-out".
 */
export function resolveVerifierCandidateCount(
	explicit: number | undefined,
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (explicit !== undefined) {
		if (!Number.isSafeInteger(explicit) || explicit < 2) {
			throw new VerifierCriteriaError(`llm-as-a-verifier-candidates must be an integer >= 2 (got ${explicit}).`);
		}
		return explicit;
	}
	const raw = env[VERIFIER_CANDIDATES_ENV_VAR]?.trim();
	if (raw) {
		if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 2) {
			throw new VerifierCriteriaError(
				`${VERIFIER_CANDIDATES_ENV_VAR} must be an integer >= 2 (got ${JSON.stringify(raw)}).`,
			);
		}
		return Number(raw);
	}
	return DEFAULT_VERIFIER_CANDIDATES;
}

/** The three verified-fan-out sibling fields as parsed from a definition. */
export interface VerifiedFanOutFrontmatter {
	llmAsVerifierCandidates?: number;
	llmAsVerifierModel?: string;
	llmAsVerifierCriteria?: string;
}

export interface ResolvedVerifiedFanOut {
	/** Number of candidates to fan out to. */
	candidates: number;
	/** Canonical verifier model override ref, or null to use the default profile. */
	modelOverride: string | null;
	/** Absolute criteria file the verifier scores against. */
	criteria: ResolvedVerifierCriteria;
}

/**
 * The single pre-flight seam a launch calls before any candidate spend
 * (ticket 07 consumes this). Throws VerifierCriteriaError on an
 * unresolvable criteria file or an invalid candidate count.
 */
export function resolveVerifiedFanOutLaunch(
	fields: VerifiedFanOutFrontmatter,
	baseCwd: string,
	env: NodeJS.ProcessEnv = process.env,
): ResolvedVerifiedFanOut {
	return {
		candidates: resolveVerifierCandidateCount(fields.llmAsVerifierCandidates, env),
		modelOverride: fields.llmAsVerifierModel ?? null,
		criteria: resolveVerifierCriteria(fields.llmAsVerifierCriteria, baseCwd),
	};
}
