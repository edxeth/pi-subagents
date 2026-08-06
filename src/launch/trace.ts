import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function traceSubagentLaunch(event: string, details: Record<string, unknown>): void {
	const logPath = process.env.PI_SUBAGENT_TRACE_LOG?.trim();
	if (!logPath) return;

	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`);
	} catch {
		// Tracing is best-effort and must never break subagent launch.
	}
}
