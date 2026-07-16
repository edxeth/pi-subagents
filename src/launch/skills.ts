import { readFileSync } from "node:fs";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	SettingsManager,
	stripFrontmatter,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { getAgentConfigDir } from "../agents/definitions.ts";

type SkillAvailability =
	| { mode: "all" }
	| { mode: "none" }
	| { mode: "only"; names: string[]; skills: Skill[] };

export interface SkillLaunchPlan {
	availability: SkillAvailability;
	injectNames: string[];
	injectSkills: Skill[];
	betterSkillsActive: boolean;
	launchArgs: string[];
}

function splitSkillNames(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

function includesBetterSkills(values: Array<string | undefined>): boolean {
	return values.some((value) => value?.includes("pi-better-skills"));
}

async function resolveExtensionSkillResources(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	extensionSpecs: string[] | undefined,
): Promise<{ additionalSkillPaths: string[]; betterSkillsActive: boolean }> {
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	if (extensionSpecs === undefined) {
		const resolved = await packageManager.resolve();
		return {
			additionalSkillPaths: [],
			betterSkillsActive: resolved.extensions.some((extension) =>
				extension.enabled && includesBetterSkills([
					extension.path,
					extension.metadata.source,
				]),
			),
		};
	}
	if (extensionSpecs.length === 0) {
		return { additionalSkillPaths: [], betterSkillsActive: false };
	}
	const resolved = await packageManager.resolveExtensionSources(extensionSpecs, {
		temporary: true,
	});
	return {
		additionalSkillPaths: resolved.skills
			.filter((skill) => skill.enabled)
			.map((skill) => skill.path),
		betterSkillsActive: resolved.extensions.some((extension) =>
			extension.enabled && includesBetterSkills([
				extension.path,
				extension.metadata.source,
			]),
		),
	};
}

async function discoverSkills(
	cwd: string,
	agentDir = getAgentConfigDir(),
	extensionSpecs?: string[],
): Promise<{ skills: Skill[]; betterSkillsActive: boolean }> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const extensionResources = await resolveExtensionSkillResources(
		cwd,
		agentDir,
		settingsManager,
		extensionSpecs,
	);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalSkillPaths: extensionResources.additionalSkillPaths,
		noExtensions: true,
	});
	await loader.reload();
	return {
		skills: loader.getSkills().skills,
		betterSkillsActive: extensionResources.betterSkillsActive,
	};
}

function resolveSkillNames(names: string[], skills: Skill[]): Skill[] {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	const missing = names.filter((name) => !byName.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
		);
	}
	return names.map((name) => byName.get(name)!);
}

function resolveAvailability(
	rawSkills: string | undefined,
	skills: Skill[],
): SkillAvailability {
	const names = splitSkillNames(rawSkills);
	if (names.length === 0 || (names.length === 1 && names[0] === "all")) {
		return { mode: "all" };
	}
	if (names.length === 1 && names[0] === "none") return { mode: "none" };
	if (names.includes("all") || names.includes("none")) {
		throw new Error(
			"Use `skills: all`, `skills: none`, or a comma-separated skill name list; do not mix these forms.",
		);
	}
	return {
		mode: "only",
		names,
		skills: resolveSkillNames(names, skills),
	};
}

function resolveInjectSkills(
	rawInjectSkills: string | undefined,
	availability: SkillAvailability,
	skills: Skill[],
): Skill[] {
	const names = splitSkillNames(rawInjectSkills);
	if (names.length === 0 || (names.length === 1 && names[0] === "none")) return [];
	if (names.includes("all") || names.includes("none")) {
		throw new Error("Use `inject-skills: none` or a comma-separated skill name list.");
	}
	if (availability.mode === "none") {
		throw new Error("Cannot inject skills when `skills: none` disables skill loading.");
	}
	if (availability.mode === "only") {
		const byName = new Map(availability.skills.map((skill) => [skill.name, skill]));
		const blocked = names.filter((name) => !byName.has(name));
		if (blocked.length > 0) {
			throw new Error(
				`Cannot inject unavailable skill${blocked.length === 1 ? "" : "s"}: ${blocked.join(", ")}`,
			);
		}
		return names.map((name) => byName.get(name)!);
	}
	return resolveSkillNames(names, skills);
}

export async function buildSkillLaunchPlan(
	rawSkills: string | undefined,
	rawInjectSkills: string | undefined,
	cwd: string,
	agentDir?: string,
	extensionSpecs?: string[],
): Promise<SkillLaunchPlan> {
	const skillNames = splitSkillNames(rawSkills);
	const injectNamesInput = splitSkillNames(rawInjectSkills);
	const noInject = injectNamesInput.length === 0 ||
		(injectNamesInput.length === 1 && injectNamesInput[0] === "none");
	if (noInject && (skillNames.length === 0 || (skillNames.length === 1 && skillNames[0] === "all"))) {
		return {
			availability: { mode: "all" },
			injectNames: [],
			injectSkills: [],
			betterSkillsActive: false,
			launchArgs: [],
		};
	}
	if (noInject && skillNames.length === 1 && skillNames[0] === "none") {
		return {
			availability: { mode: "none" },
			injectNames: [],
			injectSkills: [],
			betterSkillsActive: false,
			launchArgs: ["--no-skills"],
		};
	}
	const discovered = await discoverSkills(cwd, agentDir, extensionSpecs);
	const availability = resolveAvailability(rawSkills, discovered.skills);
	const injectSkills = resolveInjectSkills(
		rawInjectSkills,
		availability,
		discovered.skills,
	);
	const injectNames = injectSkills.map((skill) => skill.name);
	const launchArgs: string[] = [];
	if (availability.mode === "none") launchArgs.push("--no-skills");
	if (availability.mode === "only") {
		launchArgs.push("--no-skills");
		for (const skill of availability.skills) launchArgs.push("--skill", skill.filePath);
	}
	return {
		availability,
		injectNames,
		injectSkills,
		betterSkillsActive: discovered.betterSkillsActive,
		launchArgs,
	};
}

function formatSkillContext(skill: Skill, workspace: string): string {
	return `<skill_context>\n  <skill_dir>${skill.baseDir}</skill_dir>\n  <workspace_dir>${workspace}</workspace_dir>\n\n  <path_policy>\n    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.\n    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.\n    Use $PI_SKILL_DIR/path for explicit bundled skill files.\n    Use $PI_WORKSPACE/path for explicit workspace/project files.\n  </path_policy>\n</skill_context>`;
}

export function formatInjectedSkills(
	skills: Skill[],
	workspace: string,
	betterSkillsActive: boolean,
): string {
	return skills
		.map((skill) => {
			const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
			const prefix = betterSkillsActive
				? formatSkillContext(skill, workspace)
				: `References are relative to ${skill.baseDir}.`;
			return `<skill name="${skill.name}">\n${prefix}\n\n${body}\n</skill>`;
		})
		.join("\n\n");
}
