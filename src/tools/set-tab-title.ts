import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSetTabTitleToolEnabled } from "../agents/titles.ts";
import { isMuxAvailable, muxSetupHint, renameCurrentTab, renameWorkspace } from "../mux.ts";
import { asSubagentToolResult } from "../runtime/state.ts";
import { SET_TAB_TITLE_TOOL_NAME } from "./tool-names.ts";

const SET_TAB_TITLE_DESCRIPTION =
	"Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows (e.g. setup, executing todos, reviewing). Keep titles short and informative.";

/**
 * Whether the optional set_tab_title tool should be registered for the given
 * denied-tool set. Gated on the PI_SUBAGENT_ENABLE_SET_TAB_TITLE opt-in and on
 * the tool not being denied. Shared by the parent extension and the mandatory
 * child extension so the child-side protocol tool contract actually holds even
 * under `extensions: none`.
 */
export function shouldRegisterSetTabTitleTool(deniedTools: ReadonlySet<string>): boolean {
	return isSetTabTitleToolEnabled() && !deniedTools.has(SET_TAB_TITLE_TOOL_NAME);
}

/**
 * Register the optional set_tab_title tool. Self-contained: it reads the
 * opt-in env var, checks the live mux backend, and renames the current tab
 * and workspace. Safe to call from both parent and child (mandatory)
 * extension entry points.
 */
export function registerSetTabTitleTool(pi: ExtensionAPI): void {
	if (!isSetTabTitleToolEnabled()) return;
	pi.registerTool({
		name: SET_TAB_TITLE_TOOL_NAME,
		label: "Set Tab Title",
		description: SET_TAB_TITLE_DESCRIPTION,
		promptSnippet: SET_TAB_TITLE_DESCRIPTION,
		parameters: Type.Object({
			title: Type.String({
				description: "New tab title (also applied to workspace/session when supported)",
			}),
		}),
		execute: async (_toolCallId, params) => {
			if (!isMuxAvailable()) {
				return asSubagentToolResult({
					content: [
						{
							type: "text" as const,
							text: `Terminal multiplexer not available. ${muxSetupHint()}`,
						},
					],
					details: { error: "mux not available" },
				});
			}
			try {
				renameCurrentTab(params.title);
				renameWorkspace(params.title);
				return asSubagentToolResult({
					content: [{ type: "text" as const, text: `Title set to: ${params.title}` }],
					details: { title: params.title },
				});
			} catch (err: unknown) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				return asSubagentToolResult({
					content: [
						{
							type: "text" as const,
							text: `Failed to set title: ${errorMessage}`,
						},
					],
					details: { error: errorMessage },
				});
			}
		},
	});
}
