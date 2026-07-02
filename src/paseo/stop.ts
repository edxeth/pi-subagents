import type { RunningSubagent } from "../types.ts";
import { createPaseoClient } from "./client.ts";

export async function stopPaseoSubagent(running: RunningSubagent): Promise<void> {
	if (!running.paseoAgentId) return;
	const client = await createPaseoClient();
	try {
		await client.cancelAgent(running.paseoAgentId);
	} finally {
		await client.close().catch(() => {});
	}
}
