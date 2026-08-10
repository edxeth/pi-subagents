const RUNNING_SUBAGENT_COUNT_KEY = Symbol.for("pi-subagents/running-subagent-count");

type RunningSubagentCountGetter = () => number;

/** Publish the live child count across separately loaded extension module graphs. */
export function publishRunningSubagentCount(getCount: RunningSubagentCountGetter): void {
	(globalThis as Record<PropertyKey, unknown>)[RUNNING_SUBAGENT_COUNT_KEY] = getCount;
}

/** Read the live child count without requiring the main extension to be loaded. */
export function getPublishedRunningSubagentCount(): number {
	const getCount = (globalThis as Record<PropertyKey, unknown>)[RUNNING_SUBAGENT_COUNT_KEY];
	if (typeof getCount !== "function") return 0;
	const count = (getCount as RunningSubagentCountGetter)();
	return Number.isFinite(count) && count > 0 ? count : 0;
}

export function clearPublishedRunningSubagentCountForTest(): void {
	delete (globalThis as Record<PropertyKey, unknown>)[RUNNING_SUBAGENT_COUNT_KEY];
}
