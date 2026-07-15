import {
	DefaultPackageManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "../agents/definitions.ts";
import type { ResumeMode } from "../session/session-files.ts";
import { parseCommandWords } from "./child-command.ts";

interface NpmSource {
	name: string;
	version?: string;
}

function isGitSource(source: string): boolean {
	return /^(?:git:|https?:\/\/|ssh:\/\/|git:\/\/)/.test(source);
}

function parseNpmSource(source: string): NpmSource | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice("npm:".length).trim();
	if (!spec) return undefined;
	const versionSeparator = spec.lastIndexOf("@");
	if (versionSeparator > 0) {
		return {
			name: spec.slice(0, versionSeparator),
			version: spec.slice(versionSeparator + 1),
		};
	}
	return { name: spec };
}

function isProjectTrustedForLaunch(
	agentDefs: AgentDefaults | null,
	mode: ResumeMode,
): boolean {
	let trusted = mode !== "background" && agentDefs?.trustProject === true;
	for (const flag of parseCommandWords(agentDefs?.flags ?? "")) {
		if (flag === "--approve") trusted = true;
		if (flag === "--no-approve") trusted = false;
	}
	return trusted;
}

/**
 * Reuse configured, unfiltered package installations for child allowlists.
 * Unversioned npm sources match by package name. Git sources require the exact
 * configured source, including any ref, so managed reuse cannot change refs.
 * Other sources retain Pi's normal temporary CLI resolution semantics.
 */
export function resolveConfiguredExtensionSources(
	sources: string[] | undefined,
	options: {
		cwd: string;
		agentDir: string;
		agentDefs: AgentDefaults | null;
		mode: ResumeMode;
	},
): string[] | undefined {
	if (sources === undefined || sources.length === 0) return sources;

	const projectTrusted = isProjectTrustedForLaunch(options.agentDefs, options.mode);
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted,
	});
	const packageManager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
	});
	const configured = packageManager.listConfiguredPackages();
	const resolved: string[] = [];

	for (const source of sources) {
		const npmSource = parseNpmSource(source);
		const matches = configured.filter((entry) => {
			if (entry.scope === "project" && !projectTrusted) return false;
			if (npmSource && !npmSource.version) {
				return parseNpmSource(entry.source)?.name === npmSource.name;
			}
			return isGitSource(source) && entry.source === source;
		});
		const match = matches.find((entry) => entry.scope === "project") ?? matches[0];
		if (!match || match.filtered || !match.installedPath) {
			resolved.push(source);
			continue;
		}
		resolved.push(match.installedPath);
	}

	return [...new Set(resolved)];
}
