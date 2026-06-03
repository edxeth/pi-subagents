/**
 * Single source of truth for tool names that pi-subagents itself registers
 * or treats specially. Importing constants from here instead of repeating
 * string literals keeps the classifier, orchestrator allowlist, deny-tool
 * defaults, and tool-registration sites in lockstep when names change.
 */

// Tools that pi-subagents registers (or owns the protocol for):
export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_RESUME_TOOL_NAME = "subagent_resume";
export const SUBAGENT_KILL_TOOL_NAME = "subagent_kill";
export const SET_TAB_TITLE_TOOL_NAME = "set_tab_title";

// Child-side protocol tools provided by the bundled subagent extension:
export const CALLER_PING_TOOL_NAME = "caller_ping";
export const SUBAGENT_DONE_TOOL_NAME = "subagent_done";

/**
 * Tools that LAUNCH a subagent run. Used by the mixed-batch classifier to
 * tell launches apart from siblings.
 */
export const SUBAGENT_LAUNCH_TOOL_NAMES: ReadonlySet<string> = new Set([
	SUBAGENT_TOOL_NAME,
	SUBAGENT_RESUME_TOOL_NAME,
]);

/**
 * Tools the parent uses to manage subagents. Gated by `spawning: false` in
 * agent frontmatter.
 */
export const SPAWNING_TOOL_NAMES: ReadonlySet<string> = new Set([
	SUBAGENT_TOOL_NAME,
	SUBAGENT_RESUME_TOOL_NAME,
]);

/**
 * Child-side protocol tools that pi-subagents injects into every child
 * regardless of `tools:` allowlist (unless explicitly denied).
 */
export const SUBAGENT_PROTOCOL_TOOL_NAMES: readonly string[] = [
	CALLER_PING_TOOL_NAME,
	SUBAGENT_DONE_TOOL_NAME,
	SET_TAB_TITLE_TOOL_NAME,
];

/**
 * pi-subagents-internal tools that should NOT count as a "non-subagent
 * sibling" in the mixed-batch classifier. These are control/cosmetic tools
 * that don't do side-effecting work; pairing them with an async subagent
 * launch does not create the race the barrier prevents.
 */
export const PI_SUBAGENTS_INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
	SUBAGENT_TOOL_NAME,
	SUBAGENT_RESUME_TOOL_NAME,
	SUBAGENT_KILL_TOOL_NAME,
	SET_TAB_TITLE_TOOL_NAME,
]);
