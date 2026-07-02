import type { SubagentBackendResolution } from "./types.ts";

function normalizeBackendPreference(value: string | undefined): string | undefined {
	const trimmed = value?.trim().toLowerCase();
	return trimmed || undefined;
}

export function resolveSubagentBackend(
	env: Partial<Pick<NodeJS.ProcessEnv, "PI_SUBAGENT_BACKEND" | "PASEO_AGENT_ID">> =
		process.env,
): SubagentBackendResolution {
	const raw = normalizeBackendPreference(env.PI_SUBAGENT_BACKEND);
	const parentAgentId = env.PASEO_AGENT_ID?.trim() || undefined;

	if (raw === "local") {
		return {
			kind: "local",
			preference: "local",
			strictPaseo: false,
			reason: "PI_SUBAGENT_BACKEND=local",
		};
	}

	if (raw === "paseo") {
		return {
			kind: "paseo",
			preference: "paseo",
			strictPaseo: true,
			fallbackLocalOnUnavailable: false,
			...(parentAgentId ? { parentAgentId } : {}),
			reason: "PI_SUBAGENT_BACKEND=paseo",
		};
	}

	if (raw === "auto") {
		if (!parentAgentId) {
			return {
				kind: "local",
				preference: "auto",
				strictPaseo: false,
				reason: "PI_SUBAGENT_BACKEND=auto without PASEO_AGENT_ID",
			};
		}
		return {
			kind: "paseo",
			preference: "auto",
			strictPaseo: false,
			fallbackLocalOnUnavailable: true,
			parentAgentId,
			reason: "PI_SUBAGENT_BACKEND=auto with PASEO_AGENT_ID",
		};
	}

	if (raw) {
		throw new Error(
			`Invalid PI_SUBAGENT_BACKEND=${JSON.stringify(env.PI_SUBAGENT_BACKEND)}. Use local, paseo, or auto.`,
		);
	}

	if (parentAgentId) {
		return {
			kind: "paseo",
			preference: "unset",
			strictPaseo: true,
			fallbackLocalOnUnavailable: false,
			parentAgentId,
			reason: "PASEO_AGENT_ID is set",
		};
	}

	return {
		kind: "local",
		preference: "unset",
		strictPaseo: false,
		reason: "no Paseo environment detected",
	};
}
