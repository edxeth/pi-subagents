import type {
	RunningSubagent,
	SubagentResult,
	SubagentResultMessageDetails,
	SubagentTimeoutBudget,
	SubagentTimeoutKind,
} from "../types.ts";

/** Grace between the SIGTERM that starts a timeout kill and the SIGKILL. */
export const TIMEOUT_KILL_ESCALATION_MS = 5000;

export interface ExpiredTimeoutBudget {
	kind: SubagentTimeoutKind;
	/** The configured budget, in seconds, that expired. */
	seconds: number;
}

export interface DueTimeoutWrapUp extends ExpiredTimeoutBudget {
	/** Percentage of the hard budget at which work is interrupted for reporting. */
	threshold: number;
}

/**
 * Which budget, if any, is spent. The wall-clock budget is checked first, so a
 * child that exhausts both in the same tick is reported against the one that
 * bounds its whole run rather than its last quiet stretch.
 */
export function findExpiredTimeoutBudget(
	budget: SubagentTimeoutBudget,
	startedAt: number,
	lastProgressAt: number,
	now: number,
): ExpiredTimeoutBudget | null {
	if (budget.timeoutSeconds && now - startedAt >= budget.timeoutSeconds * 1000) {
		return { kind: "timeout", seconds: budget.timeoutSeconds };
	}
	if (budget.idleTimeoutSeconds && now - lastProgressAt >= budget.idleTimeoutSeconds * 1000) {
		return { kind: "idle-timeout", seconds: budget.idleTimeoutSeconds };
	}
	return null;
}

/**
 * Which soft deadline, if any, is due. The same ordering as the hard limits is
 * deliberate: when both clocks cross together, the wall clock explains the
 * run-wide bound better than the last quiet stretch.
 */
export function findDueTimeoutWrapUp(
	budget: SubagentTimeoutBudget,
	threshold: number,
	startedAt: number,
	lastProgressAt: number,
	now: number,
): DueTimeoutWrapUp | null {
	if (budget.timeoutSeconds && now - startedAt >= (budget.timeoutSeconds * 1000 * threshold) / 100) {
		return { kind: "timeout", seconds: budget.timeoutSeconds, threshold };
	}
	if (
		budget.idleTimeoutSeconds &&
		now - lastProgressAt >= (budget.idleTimeoutSeconds * 1000 * threshold) / 100
	) {
		return { kind: "idle-timeout", seconds: budget.idleTimeoutSeconds, threshold };
	}
	return null;
}

/**
 * Record the child's session size and, when the child itself produced
 * something, treat that as progress.
 *
 * Growth is the only progress signal the parent can read for both background
 * and interactive children, and it deliberately does not exempt an in-flight
 * tool call: a child parked in a blocking tool is exactly what the idle budget
 * exists to catch.
 *
 * This owns `running.bytes` so the comparison can never read a value a caller
 * already overwrote. The first observation only takes a baseline: the file
 * already holds the launch header, and counting that as progress would hand
 * every child a free interval before its idle clock starts.
 *
 * `producedOutput` is what separates the child's own work from traffic the
 * runtime wrote into its session.
 */
export function observeSubagentProgress(
	running: RunningSubagent,
	bytes: number,
	now: number,
	producedOutput = true,
): void {
	const previous = running.bytes;
	running.bytes = bytes;
	if (previous === undefined) return;
	if (bytes > previous && producedOutput) running.lastProgressAt = now;
}

/**
 * The expired budget for a child that is not already being killed. Returns
 * null once a kill is underway so a slow-dying child is never re-reported.
 */
export function checkSubagentTimeout(running: RunningSubagent, now: number): ExpiredTimeoutBudget | null {
	if (!running.timeoutBudget || running.timeoutExpiry) return null;
	if (
		running.timeoutBudget.timeoutSeconds &&
		now - running.startTime >= running.timeoutBudget.timeoutSeconds * 1000
	) {
		return { kind: "timeout", seconds: running.timeoutBudget.timeoutSeconds };
	}
	if (running.timeoutWrapUp?.kind === "idle-timeout" && running.timeoutWrapUpDeadlineAt !== undefined) {
		if (now >= running.timeoutWrapUpDeadlineAt) {
			return { kind: "idle-timeout", seconds: running.timeoutWrapUp.seconds };
		}
		return null;
	}
	return findExpiredTimeoutBudget(
		running.timeoutBudget,
		running.startTime,
		running.lastProgressAt ?? running.startTime,
		now,
	);
}

/**
 * The report-only soft deadline for a child that has not already entered its
 * one allowed wrap-up phase.
 */
export function checkSubagentTimeoutWrapUp(running: RunningSubagent, now: number): DueTimeoutWrapUp | null {
	if (!running.timeoutBudget || !running.timeoutWarnThreshold || running.timeoutWrapUp) return null;
	return findDueTimeoutWrapUp(
		running.timeoutBudget,
		running.timeoutWarnThreshold,
		running.startTime,
		running.lastProgressAt ?? running.startTime,
		now,
	);
}

/** Absolute time of the first hard limit that can stop this logical run. */
export function getSubagentHardDeadlineAt(running: RunningSubagent): number | undefined {
	if (!running.timeoutBudget) return undefined;
	const deadlines: number[] = [];
	if (running.timeoutBudget.timeoutSeconds) {
		deadlines.push(running.startTime + running.timeoutBudget.timeoutSeconds * 1000);
	}
	if (running.timeoutBudget.idleTimeoutSeconds) {
		deadlines.push(
			running.timeoutWrapUp?.kind === "idle-timeout" && running.timeoutWrapUpDeadlineAt !== undefined
				? running.timeoutWrapUpDeadlineAt
				: (running.lastProgressAt ?? running.startTime) + running.timeoutBudget.idleTimeoutSeconds * 1000,
		);
	}
	return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

/** Absolute time of the next soft or hard deadline the parent should inspect. */
export function getSubagentNextDeadlineAt(running: RunningSubagent): number | undefined {
	if (!running.timeoutBudget || running.timeoutExpiry) return undefined;
	const deadlines: number[] = [];
	const hardDeadline = getSubagentHardDeadlineAt(running);
	if (hardDeadline !== undefined) deadlines.push(hardDeadline);
	if (running.timeoutWarnThreshold && !running.timeoutWrapUp) {
		if (running.timeoutBudget.timeoutSeconds) {
			deadlines.push(
				running.startTime +
					(running.timeoutBudget.timeoutSeconds * 1000 * running.timeoutWarnThreshold) / 100,
			);
		}
		if (running.timeoutBudget.idleTimeoutSeconds) {
			deadlines.push(
				(running.lastProgressAt ?? running.startTime) +
					(running.timeoutBudget.idleTimeoutSeconds * 1000 * running.timeoutWarnThreshold) / 100,
			);
		}
	}
	return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

export function formatTimeoutSeconds(seconds: number): string {
	if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/**
 * The timeout fields a parent-visible result carries, or nothing when no budget
 * was spent. Both delivery paths use this so a structured consumer sees the
 * same shape whether the result arrived by steer or by an explicit wait.
 */
export function getTimeoutResultDetails(
	result: Pick<SubagentResult, "timedOut" | "timedOutAfter" | "timeoutBlocksResume">,
): Pick<SubagentResultMessageDetails, "timedOut" | "timedOutAfter" | "timeoutBlocksResume"> {
	if (!result.timedOut) return {};
	return {
		timedOut: result.timedOut,
		...(result.timedOutAfter !== undefined ? { timedOutAfter: result.timedOutAfter } : {}),
		...(result.timeoutBlocksResume ? { timeoutBlocksResume: true } : {}),
	};
}

export function formatTimeoutWrapUpOutcome(
	result: Pick<SubagentResult, "name" | "elapsed" | "summary"> & {
		timeoutWrapUp: NonNullable<SubagentResult["timeoutWrapUp"]>;
	},
	formatElapsed: (elapsed: number) => string,
): string {
	const limit = result.timeoutWrapUp.kind === "timeout" ? "whole-run limit" : "no-output limit";
	return (
		`Sub-agent "${result.name}" completed its time-limit wrap-up (${formatElapsed(result.elapsed)}). ` +
		`The parent interrupted its active operation at ${result.timeoutWrapUp.threshold}% of its ${limit} ` +
		`so the remaining time was reserved for this report. A short or partial report is expected; check what remains unfinished.\n\n` +
		result.summary
	);
}

export interface TimeoutNoticeInput {
	name: string;
	summary: string;
	elapsed: number;
	timedOut: SubagentTimeoutKind;
	timedOutAfter?: number;
	timeoutBlocksResume?: boolean;
	timeoutKillFailed?: boolean;
}

/**
 * What the parent reads when the runtime stopped a child on a limit.
 *
 * Without this the parent sees an ordinary non-zero exit and retries the same
 * run. The parent can also be a sub-agent that never read this project's
 * documentation, so the text says where the limit came from instead of naming
 * a field it cannot look up.
 */
export function formatTimeoutOutcome(
	result: TimeoutNoticeInput,
	hasOutput: boolean,
	formatElapsed: (elapsed: number) => string,
): string {
	const budget = result.timedOutAfter !== undefined ? formatTimeoutSeconds(result.timedOutAfter) : "its";
	const headline =
		result.timedOut === "idle-timeout"
			? `Sub-agent "${result.name}" stopped producing output, so the system stopped it ` +
				`after ${formatElapsed(result.elapsed)}. Its agent file sets a limit of ${budget} without output.`
			: `Sub-agent "${result.name}" ran out of time, so the system stopped it ` +
				`after ${formatElapsed(result.elapsed)}. Its agent file sets a limit of ${budget} for the whole run.`;
	const body = hasOutput
		? `Partial work from before it stopped. It is incomplete, so check it before you trust it:\n\n${result.summary}`
		: "It produced no output before it stopped.";
	const guidance = result.timeoutBlocksResume
		? "This agent does not allow a resume after a limit stops it. " +
			"Start a new sub-agent with a smaller task instead."
		: "A sub-agent that used its whole limit once usually does it again. " +
			"A resume gets the same limit, so it can stop at the same point. " +
			"It is usually better to finish the work yourself, or to start a new sub-agent with a smaller task.";
	// An unconfirmed kill must not read as a clean one: the operator may still
	// have a live pane burning tokens.
	const killWarning = result.timeoutKillFailed
		? "\n\nWarning: the system could not confirm that this sub-agent stopped. " +
			"Its pane can still be running. Check it and close it before you trust this result."
		: "";
	return `${headline}\n\n${body}\n\n${guidance}${killWarning}`;
}
import type { SessionEntry } from "../session/session.ts";

/**
 * True when this entry is the child producing something.
 *
 * Steers the runtime sends *to* the child are user-role entries, and the idle
 * warning is one of them. Counting those as progress would let the warning
 * reset the very budget it is warning about, handing the child a fresh full
 * budget while its message claims only 20% remains.
 */
function isChildProducedEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const role = (entry as { message?: { role?: unknown } }).message?.role;
	return role === "assistant" || role === "toolResult";
}

/** Whether any of these new session entries counts as child progress. */
export function hasChildProgress(entries: SessionEntry[]): boolean {
	return entries.some(isChildProducedEntry);
}
