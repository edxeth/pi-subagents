import { isFishShell, shellEscape } from "../mux.ts";

export interface InteractiveSentinelShellCommands {
	/** Runs when the pane shell exits before the pi command can write its own sentinel. */
	exitTrap: string;
	/** Runs immediately after the pi command exits and records that command's status. */
	direct: string;
}

/**
 * Build shell snippets that signal interactive subagent completion.
 *
 * The EXIT trap is only a forced-close fallback: interactive pane shells can stay
 * alive after the pi subprocess exits, so the direct command must run immediately
 * after pi. The direct command captures the child status before clearing the trap;
 * the trap also refuses to overwrite an existing sentinel in staged-shell backends.
 */
export function buildInteractiveSentinelShellCommands(
	doneSentinelFile: string,
): InteractiveSentinelShellCommands {
	const sentinelPath = shellEscape(doneSentinelFile);
	if (isFishShell()) {
		return {
			exitTrap: `set pi_subagent_status $status; if not test -f ${sentinelPath}; printf "__SUBAGENT_DONE_%s__\\n" "$pi_subagent_status" > ${sentinelPath}; end`,
			direct: `set pi_subagent_status $status; trap - EXIT; printf "__SUBAGENT_DONE_%s__\\n" "$pi_subagent_status" > ${sentinelPath}`,
		};
	}

	return {
		exitTrap: `pi_subagent_status=$?; if [ ! -f ${sentinelPath} ]; then printf "__SUBAGENT_DONE_%s__\\n" "$pi_subagent_status" > ${sentinelPath}; fi`,
		direct: `pi_subagent_status=$?; trap - EXIT; printf "__SUBAGENT_DONE_%s__\\n" "$pi_subagent_status" > ${sentinelPath}`,
	};
}
