import { execFileSync } from "node:child_process";
import { execFileAsync } from "./core.ts";

export interface HerdrPaneInfo {
	pane_id: string;
	tab_id?: string;
	workspace_id?: string;
}

interface HerdrResponse {
	result?: unknown;
	error?: { code?: string; message?: string };
}

function formatHerdrError(response: HerdrResponse, command: string): string {
	const code = response.error?.code ? `${response.error.code}: ` : "";
	return `herdr ${command} failed: ${code}${response.error?.message ?? "unknown error"}`;
}

export function runHerdrText(args: string[]): string {
	return execFileSync("herdr", args, { encoding: "utf8" });
}

export async function runHerdrTextAsync(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
	return stdout;
}

export function readHerdrJson(args: string[], command: string): unknown {
	const output = runHerdrText(args).trim();
	let parsed: HerdrResponse;
	try {
		parsed = JSON.parse(output) as HerdrResponse;
	} catch {
		throw new Error(`Unexpected herdr ${command} output: ${output || "(empty)"}`);
	}

	if (parsed.error) throw new Error(formatHerdrError(parsed, command));
	return parsed.result;
}

export function extractHerdrPaneInfo(value: unknown, command: string): HerdrPaneInfo {
	const record = value && typeof value === "object"
		? value as Record<string, unknown>
		: null;
	const paneValue = record?.pane ?? value;
	const pane = paneValue && typeof paneValue === "object"
		? paneValue as Record<string, unknown>
		: null;
	const paneId = pane?.pane_id;
	if (!pane || typeof paneId !== "string" || paneId.trim() === "") {
		throw new Error(`Unexpected herdr ${command} pane response`);
	}

	return {
		pane_id: paneId,
		tab_id: typeof pane.tab_id === "string" ? pane.tab_id : undefined,
		workspace_id: typeof pane.workspace_id === "string"
			? pane.workspace_id
			: undefined,
	};
}

export function getHerdrPaneInfo(paneId: string): HerdrPaneInfo {
	return extractHerdrPaneInfo(
		readHerdrJson(["pane", "get", paneId], "pane get"),
		"pane get",
	);
}
