import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompletedSubagentResult, RunningSubagent, SubagentResult } from "../types.ts";

interface TrackedSubagentMatch {
	id?: string;
	running?: RunningSubagent;
	cached?: CompletedSubagentResult;
	error?: string;
}

export interface WaitRuntime {
	runningSubagents: Map<string, RunningSubagent>;
	completedSubagentResults: Map<string, CompletedSubagentResult>;
	findTrackedSubagent(query: string): TrackedSubagentMatch;
	cacheCompletedSubagentResult(running: RunningSubagent, result: SubagentResult): CompletedSubagentResult;
	updateWidget(): void;
	deliverCompletedSubagentResultViaSteer(
		pi: Pick<ExtensionAPI, "sendMessage">,
		cached: CompletedSubagentResult,
	): CompletedSubagentResult;
	stopRunningSubagent(running: RunningSubagent): Promise<void>;
	closeSurface(surface: string): void;
}

export { waitForSubagentResult } from "./wait-result.ts";
