import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentTimeoutKind } from "../types.ts";

export const PI_SUBAGENT_TIMEOUT = "PI_SUBAGENT_TIMEOUT";
export const PI_SUBAGENT_IDLE_TIMEOUT = "PI_SUBAGENT_IDLE_TIMEOUT";
export const PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD = "PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD";
/** Epoch ms the parent started this child's wall-clock budget. */
export const PI_SUBAGENT_TIMEOUT_STARTED_AT = "PI_SUBAGENT_TIMEOUT_STARTED_AT";

const DEFAULT_TIMEOUT_WARN_THRESHOLD = 80;

/**
 * Parse the opt-in percentage of a timeout budget at which the child warns
 * itself. `true` takes the default 80%. Decimals round down. Anything the
 * child cannot read as a whole 1–99 percentage turns the warning off, which is
 * also the default.
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
 * How long until the warning is due. A budget already past its warning point —
 * a resumed child whose clock started before this process did — warns at once.
 */
export function getTimeoutWarnDelayMs(budgetSeconds: number, threshold: number, elapsedMs: number): number {
	return Math.max(0, (budgetSeconds * 1000 * threshold) / 100 - elapsedMs);
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
	if (kind === "idle-timeout") {
		return (
			`Idle limit: you have produced no output for ${spentSeconds}s, and your limit is ${budgetSeconds}s ` +
			`without output. About ${remaining}s remain. ` +
			"Output means a message from you or a tool result. Time spent waiting inside one long tool call does not count. " +
			"At the limit the system stops you, and work you did not report is lost. " +
			"If you wait for something that will not finish, stop waiting. " +
			"Report what you have now, even if it is incomplete."
		);
	}
	return (
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

/**
 * Install the timeout warning inside the child Pi process.
 *
 * The parent owns the kill; this only gives the child a chance to deliver a
 * usable partial result first, so a budget kill is not automatically a wasted
 * run. It is inert unless the agent opted in with `timeout-warn-threshold` and
 * configured at least one budget.
 *
 * A child parked in a blocking tool call cannot act on the warning — its steer
 * is only committed once the call returns. That case is what the parent's hard
 * kill exists for.
 */
export function installSubagentTimeoutReminders(pi: ExtensionAPI): void {
	const threshold = parseTimeoutWarnThreshold(process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD]);
	if (threshold === null) return;
	const timeoutSeconds = parseTimeoutSeconds(process.env[PI_SUBAGENT_TIMEOUT]);
	const idleTimeoutSeconds = parseTimeoutSeconds(process.env[PI_SUBAGENT_IDLE_TIMEOUT]);
	if (!timeoutSeconds && !idleTimeoutSeconds) return;
	const startedAt = parseStartedAt(process.env[PI_SUBAGENT_TIMEOUT_STARTED_AT]) ?? Date.now();

	const warn = (message: string) => {
		try {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		} catch {}
	};

	if (timeoutSeconds) {
		const timer = setTimeout(
			() => warn(formatTimeoutWarning("timeout", timeoutSeconds, Math.round((Date.now() - startedAt) / 1000))),
			getTimeoutWarnDelayMs(timeoutSeconds, threshold, Date.now() - startedAt),
		);
		timer.unref?.();
	}

	if (!idleTimeoutSeconds) return;
	// The idle budget restarts whenever the child produces something, so its
	// warning has to restart with it rather than fire once per run.
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdleWarning = () => {
		if (idleTimer) clearTimeout(idleTimer);
		const armedAt = Date.now();
		idleTimer = setTimeout(
			() =>
				warn(
					formatTimeoutWarning("idle-timeout", idleTimeoutSeconds, Math.round((Date.now() - armedAt) / 1000)),
				),
			getTimeoutWarnDelayMs(idleTimeoutSeconds, threshold, 0),
		);
		idleTimer.unref?.();
	};
	armIdleWarning();
	pi.on("message_end", armIdleWarning);
	pi.on("turn_end", armIdleWarning);
}
