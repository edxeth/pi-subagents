import { exec } from "node:child_process";
import { promisify } from "node:util";

const DYNAMIC_INLINE_PATTERN = /(^|\s)!`([^`]+)`/gm;
const FENCE_OPEN_PATTERN = /```([^\r\n]*)(?:\r?\n|$)/g;
const MAX_DYNAMIC_OUTPUT_CHARS = 50_000;
const execAsync = promisify(exec);

type TaskExpansionReplacement = {
	start: number;
	end: number;
	replacement: string;
};

type TaskExpansionPlaceholder = {
	start: number;
	end: number;
	command: string;
	prefix?: string;
};

export interface SubagentTaskExpansionOptions {
	enabled: boolean;
	cwd: string;
}

function containsPosition(ranges: Array<{ start: number; end: number }>, index: number): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

function formatShellOutput(stdout: string, stderr: string): string {
	const parts: string[] = [];
	if (stdout.trim()) parts.push(stdout.trim());
	if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
	const output = parts.join("\n");
	return output.length > MAX_DYNAMIC_OUTPUT_CHARS
		? `${output.slice(0, MAX_DYNAMIC_OUTPUT_CHARS)}\n[output truncated]`
		: output;
}

async function runTaskExpansionCommand(command: string, cwd: string): Promise<string> {
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd,
			timeout: 30_000,
			maxBuffer: 2 * 1024 * 1024,
			env: {
				...process.env,
				PI_WORKSPACE: cwd,
			},
		});
		return formatShellOutput(stdout, stderr);
	} catch (error) {
		const err = error as {
			stdout?: string;
			stderr?: string;
			message?: string;
			killed?: boolean;
			signal?: string;
			code?: number;
		};
		const output = formatShellOutput(err.stdout ?? "", err.stderr ?? "");
		const status = err.killed
			? `timed out${err.signal ? ` (${err.signal})` : ""}`
			: `failed${typeof err.code === "number" ? ` with code ${err.code}` : ""}`;
		return `[task shell ${status}: ${command}${output ? `\n${output}` : err.message ? `\n${err.message}` : ""}]`;
	}
}

function collectFencePlaceholders(task: string): {
	fenceRanges: Array<{ start: number; end: number }>;
	placeholders: TaskExpansionPlaceholder[];
} {
	const fenceRanges: Array<{ start: number; end: number }> = [];
	const placeholders: TaskExpansionPlaceholder[] = [];

	FENCE_OPEN_PATTERN.lastIndex = 0;
	while (true) {
		const match = FENCE_OPEN_PATTERN.exec(task);
		if (!match) break;
		const start = match.index;
		const bodyStart = start + match[0].length;
		const closingStart = task.indexOf("```", bodyStart);
		if (closingStart === -1) {
			fenceRanges.push({ start, end: task.length });
			break;
		}

		const end = closingStart + 3;
		const marker = match[1]?.trim() ?? "";
		fenceRanges.push({ start, end });
		if (marker.startsWith("!")) {
			const markerCommand = marker.slice(1).trim();
			const bodyCommand = task.slice(bodyStart, closingStart);
			const command = [markerCommand, bodyCommand]
				.filter((part) => part.trim())
				.join("\n")
				.trim();
			if (command) placeholders.push({ start, end, command });
		}
		FENCE_OPEN_PATTERN.lastIndex = end;
	}

	return { fenceRanges, placeholders };
}

function collectInlinePlaceholders(
	task: string,
	fenceRanges: Array<{ start: number; end: number }>,
): TaskExpansionPlaceholder[] {
	const placeholders: TaskExpansionPlaceholder[] = [];
	for (const match of task.matchAll(DYNAMIC_INLINE_PATTERN)) {
		const command = match[2]?.trim();
		if (!command || match.index === undefined) continue;
		const prefix = match[1] ?? "";
		const bangIndex = match.index + prefix.length;
		if (containsPosition(fenceRanges, bangIndex)) continue;
		placeholders.push({
			start: match.index,
			end: match.index + match[0].length,
			command,
			prefix,
		});
	}
	return placeholders;
}

async function collectReplacements(task: string, cwd: string): Promise<TaskExpansionReplacement[]> {
	const { fenceRanges, placeholders: fencePlaceholders } = collectFencePlaceholders(task);
	const placeholders = [...fencePlaceholders, ...collectInlinePlaceholders(task, fenceRanges)].sort(
		(a, b) => a.start - b.start,
	);

	const replacements: TaskExpansionReplacement[] = [];
	for (const placeholder of placeholders) {
		const output = await runTaskExpansionCommand(placeholder.command, cwd);
		replacements.push({
			start: placeholder.start,
			end: placeholder.end,
			replacement: `${placeholder.prefix ?? ""}${output}`,
		});
	}
	return replacements;
}

export async function expandSubagentTask(task: string, options: SubagentTaskExpansionOptions): Promise<string> {
	if (!options.enabled) return task;
	if (!task.includes("!`") && !task.includes("```!")) return task;

	let transformed = task;
	const replacements = await collectReplacements(task, options.cwd);
	for (const { start, end, replacement } of replacements.sort((a, b) => b.start - a.start)) {
		transformed = `${transformed.slice(0, start)}${replacement}${transformed.slice(end)}`;
	}
	return transformed;
}
