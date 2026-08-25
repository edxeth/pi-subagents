/**
 * Verifier model refs (`provider/model[:thinking]`).
 *
 * Split from verifier-profile.ts so agent-definition parsing can validate
 * `llm-as-a-verifier-model` without importing the profile resolver (which
 * reads agent config dirs and would cycle back into definitions).
 */

/** Reasoning efforts the library's `DEEPSEEK_EFFORT` setting understands. */
export const LIBRARY_REASONING_EFFORTS = ["off", "low", "high", "max"] as const;
export type LibraryReasoningEffort = (typeof LIBRARY_REASONING_EFFORTS)[number];

export const EFFORT_ALIASES: Record<string, LibraryReasoningEffort> = {
	off: "off",
	disabled: "off",
	none: "off",
	low: "low",
	high: "high",
	max: "max",
};

class VerifierModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerifierModelError";
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

/**
 * Normalize a `provider/model[:thinking]` ref to what the library accepts:
 * a plain model id. The library forwards the model string verbatim
 * (`resolve_model`), so a prefixed or suffixed ref would be rejected upstream.
 */
export function normalizeVerifierModelRef(ref: string): NormalizedVerifierModelRef {
	const trimmed = ref.trim();
	if (!trimmed) throw new VerifierModelError("Verifier model ref is empty.");
	let main = trimmed;
	let thinking: LibraryReasoningEffort | null = null;
	const colon = trimmed.lastIndexOf(":");
	if (colon !== -1) {
		const suffix = trimmed.slice(colon + 1).trim();
		const effort = EFFORT_ALIASES[suffix.toLowerCase()];
		if (!effort) {
			throw new VerifierModelError(
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
			throw new VerifierModelError(
				`Verifier model ref ${JSON.stringify(ref)} must be provider/model or model (got ${parts.length} "/"-separated parts).`,
			);
		}
		if (!parts[0] || !parts[1]) {
			throw new VerifierModelError(`Verifier model ref ${JSON.stringify(ref)} has an empty provider or model id.`);
		}
		provider = parts[0];
		modelId = parts[1];
	}
	if (!modelId) throw new VerifierModelError(`Verifier model ref ${JSON.stringify(ref)} has an empty model id.`);
	const normalizedRef = `${provider ? `${provider}/` : ""}${modelId}${thinking ? `:${thinking}` : ""}`;
	return { provider, modelId, thinking, normalizedRef };
}
