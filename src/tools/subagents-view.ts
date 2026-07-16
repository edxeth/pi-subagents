import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completedSubagentResults, runningSubagents } from "../runtime/state.ts";
import { getEffectiveAgentDefinitions } from "../agents/definitions.ts";
import { SubagentsOverlayController, type OverlayRuntime } from "./overlay/index.ts";

export { SubagentsOverlayController as SubagentsOverlay } from "./overlay/index.ts";

export function registerSubagentsView(pi: ExtensionAPI, runtime: OverlayRuntime) {
	let activeOverlay: SubagentsOverlayController | null = null;

	function open(ctx: ExtensionContext) {
		if (activeOverlay) return;
		if (!runningSubagents.size && !completedSubagentResults.size && !getEffectiveAgentDefinitions().length) {
			ctx.ui.notify("No subagents or definitions.", "info");
			return;
		}

		ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
			const overlay = new SubagentsOverlayController(
				done,
				ctx,
				{
					fg: (tone, text) => theme.fg(tone as Parameters<typeof theme.fg>[0], text),
					bg: (color, text) => theme.bg(color as Parameters<typeof theme.bg>[0], text),
					bold: (text) => theme.bold(text),
				},
				runtime,
				tui,
			);
			activeOverlay = overlay;
			return overlay;
		})
			.finally(() => {
				activeOverlay = null;
			});
	}

	pi.registerCommand("subagents", {
		description: "Open subagent manager",
		handler: async (_args, ctx) => open(ctx),
	});

	pi.registerShortcut?.("alt+s", {
		description: "Toggle subagent manager",
		handler: async (ctx) => {
			if (activeOverlay) {
				activeOverlay.close();
				activeOverlay = null;
				return;
			}
			open(ctx);
		},
	});

	pi.on("session_shutdown", async () => {
		activeOverlay?.dispose();
		activeOverlay = null;
	});
}
