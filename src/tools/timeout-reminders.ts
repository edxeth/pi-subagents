import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentTimeoutKind } from "../types.ts";

export const PI_SUBAGENT_TIMEOUT = "PI_SUBAGENT_TIMEOUT";
export const PI_SUBAGENT_IDLE_TIMEOUT = "PI_SUBAGENT_IDLE_TIMEOUT";
export const PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD = "PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD";
/** Epoch ms the parent started this child's wall-clock budget. */
export const PI_SUBAGENT_TIMEOUT_STARTED_AT = "PI_SUBAGENT_TIMEOUT_STARTED_AT";
/** Internal flag for the parent-forced report-only continuation. */
export const PI_SUBAGENT_TIMEOUT_WRAP_UP = "PI_SUBAGENT_TIMEOUT_WRAP_UP";

const DEFAULT_TIMEOUT_WARN_THRESHOLD = 80;

/**
 * Parse the opt-in percentage of a timeout budget reserved for the forced
 * report-only continuation. `true` takes the default 80%. Decimals round down.
 * Anything outside 1–99 turns the policy off, which is also the default.
 */
export function parseTimeoutWarnThreshold(raw: string | undefined): number | null {
	if (!raw) return null;
	const normalized = raw.trim().toLowerCase();
	if (!normalized || normalized === "false" || normalized === "off") return null;
	if (normalized === "true") return DEFAULT_TIMEOUT_WARN_THRESHOLD;
	const match = normalized.match(/^(\d+(?:\.\d+)?)%?$/);
	if (!match) return null;
	const threshold = Math.floor(Number.parseFloat(match[1]));
	return threshold >= 1 && threshold <= 99 ? threshold : null;
}

/** Read a budget the parent is enforcing. Only whole positive seconds count. */
export function parseTimeoutSeconds(raw: string | undefined): number | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const seconds = Number(trimmed);
	return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The warning the child reads.
 *
 * A child knows nothing about this extension. It never saw the agent file, it
 * cannot read the frontmatter, and words like "idle budget" mean nothing to
 * it. So the message states the limit, what counts against it, what happens at
 * the end, and what to do now — without naming anything outside the child.
 */
export function formatTimeoutWarning(kind: SubagentTimeoutKind, budgetSeconds: number, spentSeconds: number): string {
	const remaining = Math.max(0, budgetSeconds - spentSeconds);
	const clockOrigin =
		"This clock belongs to the current logical sub-agent run. A process restart for wrap-up does not reset it. " +
		"Conversation inherited or forked when the original child was spawned consumed zero seconds of it. " +
		"The elapsed and remaining values below are authoritative; do not infer time from the transcript. ";
	if (kind === "idle-timeout") {
		return (
			clockOrigin +
			`Idle limit: you have produced no output for ${spentSeconds}s, and your limit is ${budgetSeconds}s ` +
			`without output. About ${remaining}s remain. ` +
			"Output means a message from you or a completed tool result. Time spent inside one long tool call counts as silence until that result exists. " +
			"At the limit the system stops you, and work you did not report is lost. " +
			"If you wait for something that will not finish, stop waiting. " +
			"Report what you have now, even if it is incomplete."
		);
	}
	return (
		clockOrigin +
		`Time limit: you have been running for ${spentSeconds}s, and your limit is ${budgetSeconds}s ` +
		`for this whole run. About ${remaining}s remain. ` +
		"At the limit the system stops you, and work you did not report is lost. " +
		"Stop taking on new work. Report your result now, even if it is incomplete."
	);
}

function parseStartedAt(raw: string | undefined): number | null {
	if (!raw) return null;
	const value = Number(raw.trim());
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The clock contract every bounded child receives before its first model call. */
function formatTimeoutLaunchInstruction(
	timeoutSeconds: number | null,
	idleTimeoutSeconds: number | null,
	threshold: number,
	startedAt: number,
): string {
	const started = new Date(startedAt).toISOString();
	const limits: string[] = [];
	if (timeoutSeconds) {
		const warningAt = new Date(startedAt + (timeoutSeconds * 1000 * threshold) / 100).toISOString();
		const hardStopAt = new Date(startedAt + timeoutSeconds * 1000).toISOString();
		limits.push(
			`The whole-run limit is ${timeoutSeconds}s. The parent runtime will interrupt active work at ${threshold}% ` +
			`(${warningAt}) and hard-stop this invocation at ${hardStopAt}.`,
		);
	}
	if (idleTimeoutSeconds) {
		limits.push(
			`The no-output limit is ${idleTimeoutSeconds}s. Each message from you or completed tool result restarts it. ` +
			`The parent runtime will interrupt active work at ${threshold}% of any quiet interval.`,
		);
	}
	return [
		"Time-budget contract for this child sub-agent invocation:",
		`This logical run's clock started at ${started}. A process restart for wrap-up will not reset it.`,
		"Conversation inherited or forked when this child was spawned consumed zero seconds of this run.",
		"The runtime timestamps and remaining-time messages are authoritative; do not infer elapsed time from transcript length.",
		...limits,
		"An interrupt at the warning threshold can cancel an active tool and restart this same session only to report committed work. Plan to finish executable work before that point.",
	].join(" ");
}

/**
 * Install the timeout contract inside the child Pi process.
 *
 * The parent owns both the warning-threshold interrupt and the hard kill. A
 * child timer cannot provide that guarantee: Pi queues steers until tools
 * finish, and synchronous child code can block the child's event loop. The
 * child therefore receives the clock contract before work starts, while the
 * parent performs the actual interrupt from another process.
 */
export function installSubagentTimeoutReminders(pi: ExtensionAPI): void {
	const threshold = parseTimeoutWarnThreshold(process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD]);
	if (threshold === null) return;
	const timeoutSeconds = parseTimeoutSeconds(process.env[PI_SUBAGENT_TIMEOUT]);
	const idleTimeoutSeconds = parseTimeoutSeconds(process.env[PI_SUBAGENT_IDLE_TIMEOUT]);
	if (!timeoutSeconds && !idleTimeoutSeconds) return;
	const startedAt = parseStartedAt(process.env[PI_SUBAGENT_TIMEOUT_STARTED_AT]) ?? Date.now();
	const contract = formatTimeoutLaunchInstruction(timeoutSeconds, idleTimeoutSeconds, threshold, startedAt);
	const wrapUpMode = process.env[PI_SUBAGENT_TIMEOUT_WRAP_UP] === "1";

	pi.on("before_agent_start", (event) => ({
		systemPrompt:
			event.systemPrompt +
			`\n\n${contract}` +
			(wrapUpMode
				? "\n\nTime-limit wrap-up mode is active. The parent interrupted the previous operation. Do not start or retry tools; return the best final report now."
				: ""),
	}));

	if (!wrapUpMode) return;
	pi.on("tool_call", () => ({
		block: true,
		reason: "Time-limit wrap-up mode only allows the final report; do not start or retry tools.",
	}));
}
