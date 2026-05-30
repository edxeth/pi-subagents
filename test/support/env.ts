import { afterEach, beforeEach } from "node:test";

export const TRACKED_ENV_KEYS = [
	"CMUX_SOCKET_PATH",
	"CMUX_SURFACE_ID",
	"FAKE_CMUX_LOG",
	"FAKE_CMUX_SCREEN",
	"FAKE_TMUX_LOG",
	"FAKE_WEZTERM_LOG",
	"FAKE_WEZTERM_SCREEN",
	"FAKE_ZELLIJ_LOG",
	"FAKE_ZELLIJ_PANE_ID",
	"FAKE_ZELLIJ_SCREEN",
	"PATH",
	"PI_ARTIFACT_PROJECT_ROOT",
	"PI_CODING_AGENT_DIR",
	"PI_PACKAGE_DIR",
	"PI_SUBAGENT_MUX",
	"PI_SUBAGENT_PI_COMMAND",
	"PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN",
	"PI_SUBAGENT_RENAME_TMUX_SESSION",
	"PI_SUBAGENT_RENAME_TMUX_WINDOW",
	"SHELL",
	"TMUX",
	"TMUX_PANE",
	"WEZTERM_PANE",
	"WEZTERM_UNIX_SOCKET",
	"ZELLIJ",
	"ZELLIJ_SESSION_NAME",
] as const;

export const ORIGINAL_ENV = Object.fromEntries(
	TRACKED_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined>;

export const ISOLATED_SUBAGENT_ENV_KEYS = [
	"PI_DENY_TOOLS",
	"PI_SUBAGENT_AUTO_EXIT",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_SESSION",
] as const;

export function clearIsolatedSubagentEnv(): void {
	for (const key of ISOLATED_SUBAGENT_ENV_KEYS) delete process.env[key];
}

export function restoreTrackedEnv(): void {
	for (const key of TRACKED_ENV_KEYS) {
		const value = ORIGINAL_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

beforeEach(() => {
	clearIsolatedSubagentEnv();
});

afterEach(() => {
	restoreTrackedEnv();
});
