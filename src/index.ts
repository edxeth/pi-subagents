import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import sessionArtifactsExtension from "./session-artifacts/index.ts";
import subagentsExtension from "./subagents/index.ts";

export default function combinedExtension(pi: ExtensionAPI) {
	subagentsExtension(pi);
	sessionArtifactsExtension(pi);
}
