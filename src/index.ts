import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import subagentsExtension from "./subagents.ts";

export {
	registerAgentSourceProvider,
	type AgentSourceProvider,
	type AgentSourceProviderContext,
	type NormalizedExternalAgentDefinition,
} from "./agents/external-sources.ts";

export default function combinedExtension(pi: ExtensionAPI) {
	subagentsExtension(pi);
}
