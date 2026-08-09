import { existsSync } from "node:fs";
import { SUBAGENT_COMPLETION_ENTRY, SUBAGENT_CONTEXT_PRESSURE_REASON } from "../tools/context-reminders.ts";
import { getEntries } from "./session.ts";

/**
 * True when the child's last completed run ended because its context-warning
 * policy told it to stop. Only a terminal wrap-up sets this, so a child that
 * merely saw an early warning and then finished normally is not reported.
 *
 * The last marker wins: a later clean completion releases a session that an
 * earlier context-pressure exit had blocked.
 */
export function endedUnderContextPressure(sessionFile: string): boolean {
	if (!existsSync(sessionFile)) return false;
	try {
		const entries = getEntries(sessionFile) as Array<{
			id?: string;
			parentId?: string;
			type?: unknown;
			customType?: unknown;
			data?: { reason?: unknown };
		}>;
		if (entries.length === 0) return false;
		// Walk back from the active leaf. A marker on an abandoned branch
		// describes a run this session no longer descends from.
		const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id as string, entry]));
		let current: (typeof entries)[number] | undefined = entries[entries.length - 1];
		const seen = new Set<string>();
		while (current) {
			if (current.type === "custom" && current.customType === SUBAGENT_COMPLETION_ENTRY) {
				return current.data?.reason === SUBAGENT_CONTEXT_PRESSURE_REASON;
			}
			if (current.id) {
				if (seen.has(current.id)) break;
				seen.add(current.id);
			}
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return false;
	} catch {
		return false;
	}
}
