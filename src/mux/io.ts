import { execFileSync, execSync } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	execFileAsync,
	isFishShell,
	requireMuxBackend,
	shellEscape,
	tailLines,
	zellijActionSync,
	zellijPaneId,
} from "./core.ts";
import { readHerdrJson, runHerdrText, runHerdrTextAsync } from "./herdr.ts";

export function sendCommand(surface: string, command: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		execSync(
			`cmux send --surface ${shellEscape(surface)} ${shellEscape(`${command}\n`)}`,
			{ encoding: "utf8" },
		);
		return;
	}
	if (backend === "tmux") {
		if (command.length > 0) {
			execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], {
				encoding: "utf8",
			});
			execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
				encoding: "utf8",
			});
			return;
		}
		execFileSync("tmux", ["send-keys", "-t", surface, "C-m"], {
			encoding: "utf8",
		});
		execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "herdr") {
		if (command.length > 0) {
			runHerdrText(["pane", "run", surface, command]);
			return;
		}
		runHerdrText(["pane", "send-keys", surface, "Enter"]);
		return;
	}
	if (backend === "wezterm") {
		execFileSync(
			"wezterm",
			["cli", "send-text", "--pane-id", surface, "--no-paste", `${command}\n`],
			{ encoding: "utf8" },
		);
		return;
	}
	zellijActionSync(["write-chars", command], surface);
	zellijActionSync(["write", "13"], surface);
}

function stageShellCommand(command: string): string {
	const shell = (process.env.SHELL ?? "/bin/sh").trim() || "/bin/sh";
	const ext = isFishShell() ? ".fish" : ".sh";
	const scriptPath = join(
		tmpdir(),
		`pi-subagent-cmux-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
	);
	writeFileSync(scriptPath, `#!${shell}\n${command}\n`, "utf8");
	chmodSync(scriptPath, 0o700);
	return scriptPath;
}

function buildStagedShellCommand(scriptPath: string): string {
	return `${shellEscape(scriptPath)}; rm -f ${shellEscape(scriptPath)}`;
}

export function sendShellCommand(surface: string, command: string): void {
	const backend = requireMuxBackend();
	if (backend !== "cmux") {
		sendCommand(surface, command);
		return;
	}
	const scriptPath = stageShellCommand(command);
	try {
		sendCommand(surface, buildStagedShellCommand(scriptPath));
	} catch (error) {
		try {
			rmSync(scriptPath, { force: true });
		} catch {}
		throw error;
	}
}

export function readScreen(surface: string, lines = 50): string {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		return execSync(
			`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`,
			{ encoding: "utf8" },
		);
	}
	if (backend === "tmux") {
		return execFileSync(
			"tmux",
			["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
			{ encoding: "utf8" },
		);
	}
	if (backend === "herdr") {
		return runHerdrText([
			"pane",
			"read",
			surface,
			"--source",
			"visible",
			"--lines",
			String(Math.max(1, lines)),
		]);
	}
	if (backend === "wezterm") {
		const raw = execFileSync("wezterm", ["cli", "get-text", "--pane-id", surface], {
			encoding: "utf8",
		});
		return tailLines(raw, lines);
	}
	const raw = execFileSync(
		"zellij",
		["action", "dump-screen", "--pane-id", zellijPaneId(surface)],
		{ encoding: "utf8" },
	);
	return tailLines(raw, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		const { stdout } = await execFileAsync(
			"cmux",
			["read-screen", "--surface", surface, "--lines", String(lines)],
			{ encoding: "utf8" },
		);
		return stdout;
	}
	if (backend === "tmux") {
		const { stdout } = await execFileAsync(
			"tmux",
			["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
			{ encoding: "utf8" },
		);
		return stdout;
	}
	if (backend === "herdr") {
		return runHerdrTextAsync([
			"pane",
			"read",
			surface,
			"--source",
			"visible",
			"--lines",
			String(Math.max(1, lines)),
		]);
	}
	if (backend === "wezterm") {
		const { stdout } = await execFileAsync(
			"wezterm",
			["cli", "get-text", "--pane-id", surface],
			{ encoding: "utf8" },
		);
		return tailLines(stdout, lines);
	}
	const { stdout } = await execFileAsync(
		"zellij",
		["action", "dump-screen", "--pane-id", zellijPaneId(surface)],
		{ encoding: "utf8" },
	);
	return tailLines(stdout, lines);
}

export function closeSurface(surface: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "tmux") {
		execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
		return;
	}
	if (backend === "herdr") {
		readHerdrJson(["pane", "close", surface], "pane close");
		return;
	}
	if (backend === "wezterm") {
		execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
			encoding: "utf8",
		});
		return;
	}
	zellijActionSync(["close-pane"], surface);
}
