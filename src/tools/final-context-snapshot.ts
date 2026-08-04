import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface FinalContextSnapshot {
	contextTokens: number;
	contextWindow: number;
}

export function getFinalContextSnapshot(
	ctx: Pick<ExtensionContext, "getContextUsage"> | undefined,
): FinalContextSnapshot | undefined {
	const usage = ctx?.getContextUsage?.();
	if (
		typeof usage?.tokens !== "number" ||
		typeof usage.contextWindow !== "number" ||
		!Number.isFinite(usage.tokens) ||
		!Number.isFinite(usage.contextWindow) ||
		usage.tokens < 0 ||
		usage.contextWindow <= 0
	) {
		return undefined;
	}
	return {
		contextTokens: usage.tokens,
		contextWindow: usage.contextWindow,
	};
}
