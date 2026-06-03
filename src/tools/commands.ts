import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent } from "../types.ts";

export interface SubagentCommandRuntime {
	stopRunningSubagent(running: RunningSubagent): void;
}

export function registerSubagentCommands(
	pi: ExtensionAPI,
	runtime: SubagentCommandRuntime,
): void {
	// /subagent-kill was removed in favor of the /subagents TUI overlay (alt+s).
	// Re-add /subagent-kill here if a CLI kill shortcut is needed later.
}
