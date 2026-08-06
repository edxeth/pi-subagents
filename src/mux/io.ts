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
import {
	closeHerdrPane,
	readHerdrPaneScreen,
	readHerdrPaneScreenAsync,
	runHerdrPaneCommand,
	sendHerdrPaneEnter,
} from "./herdr.ts";
import { closeZellijSurface } from "./zellij-runtime.ts";

export function sendCommand(surface: string, command: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(`${command}\n`)}`, { encoding: "utf8" });
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
	if (backend === "wezterm") {
		execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", `${command}\n`], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "zellij") {
		zellijActionSync(["write-chars", command], surface);
		zellijActionSync(["write", "13"], surface);
		return;
	}
	if (backend === "herdr") {
		if (command.length > 0) runHerdrPaneCommand(surface, command);
		else sendHerdrPaneEnter(surface);
		return;
	}
	throw new Error("Unsupported mux backend");
}

function stageShellCommand(command: string): string {
	const shell = (process.env.SHELL ?? "/bin/sh").trim() || "/bin/sh";
	const ext = isFishShell() ? ".fish" : ".sh";
	const scriptPath = join(tmpdir(), `pi-subagent-shell-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
	writeFileSync(scriptPath, `#!${shell}\n${command}\n`, "utf8");
	chmodSync(scriptPath, 0o700);
	return scriptPath;
}

function buildStagedShellCommand(scriptPath: string): string {
	return `${shellEscape(scriptPath)}; rm -f ${shellEscape(scriptPath)}`;
}

export function sendShellCommand(surface: string, command: string): void {
	const backend = requireMuxBackend();
	if (backend !== "cmux" && backend !== "herdr") {
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
		return execSync(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, { encoding: "utf8" });
	}
	if (backend === "tmux") {
		return execFileSync("tmux", ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`], {
			encoding: "utf8",
		});
	}
	if (backend === "wezterm") {
		const raw = execFileSync("wezterm", ["cli", "get-text", "--pane-id", surface], {
			encoding: "utf8",
		});
		return tailLines(raw, lines);
	}
	if (backend === "zellij") {
		const raw = execFileSync("zellij", ["action", "dump-screen", "--pane-id", zellijPaneId(surface)], {
			encoding: "utf8",
		});
		return tailLines(raw, lines);
	}
	if (backend === "herdr") return readHerdrPaneScreen(surface, lines);
	throw new Error("Unsupported mux backend");
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		const { stdout } = await execFileAsync("cmux", ["read-screen", "--surface", surface, "--lines", String(lines)], {
			encoding: "utf8",
		});
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
	if (backend === "wezterm") {
		const { stdout } = await execFileAsync("wezterm", ["cli", "get-text", "--pane-id", surface], { encoding: "utf8" });
		return tailLines(stdout, lines);
	}
	if (backend === "zellij") {
		const { stdout } = await execFileAsync("zellij", ["action", "dump-screen", "--pane-id", zellijPaneId(surface)], {
			encoding: "utf8",
		});
		return tailLines(stdout, lines);
	}
	if (backend === "herdr") return readHerdrPaneScreenAsync(surface, lines);
	throw new Error("Unsupported mux backend");
}

export async function closeSurfaceAsync(
	surface: string,
	zellijTarget?: { sessionName: string; parentPaneId: number },
): Promise<void> {
	if (requireMuxBackend() === "zellij") {
		await closeZellijSurface(surface, zellijTarget);
		return;
	}
	closeSurface(surface);
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
	if (backend === "wezterm") {
		execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "zellij") {
		void closeZellijSurface(surface).catch(() => {});
		return;
	}
	if (backend === "herdr") {
		closeHerdrPane(surface);
		return;
	}
	throw new Error("Unsupported mux backend");
}
