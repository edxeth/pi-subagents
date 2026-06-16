import { execFileSync } from "node:child_process";

export function parseHerdrPaneId(output: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error(`Unexpected herdr pane split output: ${output.trim() || "(empty)"}`);
	}
	const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
	if (typeof paneId !== "string" || !paneId.trim()) {
		throw new Error(`Unexpected herdr pane split output: ${output.trim() || "(empty)"}`);
	}
	return paneId;
}

export function createHerdrSplit(
	_name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const parentPane = fromSurface ?? process.env.HERDR_PANE_ID;
	if (!parentPane) throw new Error("HERDR_PANE_ID not set");
	const herdrDirection = direction === "left" || direction === "right" ? "right" : "down";
	const output = execFileSync(
		"herdr",
		["pane", "split", parentPane, "--direction", herdrDirection, "--no-focus"],
		{ encoding: "utf8" },
	);
	const paneId = parseHerdrPaneId(output);
	try {
		execFileSync("herdr", ["pane", "rename", paneId, _name], { encoding: "utf8" });
	} catch {}
	return paneId;
}
