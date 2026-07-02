type LocalSubagentRuntimeBackend = "local-process" | "local-mux";
export type RunningSubagentBackend = LocalSubagentRuntimeBackend | "paseo";

interface LocalBackendResolution {
	kind: "local";
	preference: "local" | "auto" | "unset";
	strictPaseo: false;
	reason: string;
}

export interface PaseoBackendResolution {
	kind: "paseo";
	preference: "paseo" | "auto" | "unset";
	strictPaseo: boolean;
	fallbackLocalOnUnavailable: boolean;
	parentAgentId?: string;
	reason: string;
}

export type SubagentBackendResolution =
	| LocalBackendResolution
	| PaseoBackendResolution;
