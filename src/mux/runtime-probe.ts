import { execFileSync, execSync } from "node:child_process";

export interface MuxRuntimeProbeOptions {
	getPath?: () => string;
	commandExists?: (command: string) => boolean;
}

type CommandAvailability = {
	path: string;
	available: boolean;
};

export class MuxRuntimeProbe {
	private readonly getPath: () => string;
	private readonly commandExists: (command: string) => boolean;
	private readonly commandAvailability = new Map<string, CommandAvailability>();

	constructor(options: MuxRuntimeProbeOptions = {}) {
		this.getPath = options.getPath ?? (() => process.env.PATH ?? "");
		this.commandExists = options.commandExists ?? defaultCommandExists;
	}

	hasCommand(command: string): boolean {
		const path = this.getPath();
		const cached = this.commandAvailability.get(command);
		if (cached && cached.path === path) return cached.available;

		const available = this.commandExists(command);
		this.commandAvailability.set(command, { path, available });
		return available;
	}
}

export const defaultMuxRuntimeProbe = new MuxRuntimeProbe();

function defaultCommandExists(command: string): boolean {
	if (process.platform === "win32") {
		try {
			execFileSync("where.exe", [command], { stdio: "ignore" });
			return true;
		} catch {
			return shellCommandExists(command);
		}
	}
	return shellCommandExists(command);
}

function shellCommandExists(command: string): boolean {
	try {
		execSync(`command -v ${command}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
