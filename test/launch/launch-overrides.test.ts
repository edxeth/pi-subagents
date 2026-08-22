import { launchBackgroundSubagent } from "../../src/launch/background.ts";
import { coordinateSubagentLaunch } from "../../src/launch/launch-coordinator.ts";
import {
	getLaunchEnvCollisions,
	resolveForcedChildCwd,
	stripInternalLaunchOverrides,
} from "../../src/launch/launch-overrides.ts";
import { getBaseSubagentEnvVars } from "../../src/launch/prep.ts";
import { enforceAgentFrontmatter } from "../../src/launch/policy.ts";
import { SubagentChildParams, SubagentParams } from "../../src/tools/subagent-tools.ts";
import type { PreparedSubagentLaunch } from "../../src/launch/prep.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	join,
	mkdirSync,
	readFileSync,
	SESSION_HEADER,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

async function readEventually(path: string): Promise<string> {
	let lastText = "";
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) {
			lastText = readFileSync(path, "utf8");
			if (lastText.trim()) return lastText;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}; last content: ${lastText}`);
}

function extractTaskArtifactPath(argvLog: string): string {
	const match = argvLog.match(/\s@([^\s]+)/);
	if (!match?.[1]) throw new Error(`Expected task artifact argument in ${argvLog}`);
	return match[1];
}

function captureWarnings<T>(run: () => T): { value: T; warnings: string[] } {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		return { value: run(), warnings };
	} finally {
		console.warn = originalWarn;
	}
}

function fakePrepared(agentDefs: PreparedSubagentLaunch["agentDefs"]): PreparedSubagentLaunch {
	return ({
		agentDefs,
		denySet: new Set<string>(),
		runtimePaths: {} as PreparedSubagentLaunch["runtimePaths"],
		subagentSessionFile: "child.jsonl",
		sessionFile: "parent.jsonl",
		identity: "",
		identityInSystemPrompt: false,
	}) as PreparedSubagentLaunch;
}

describe("internal launch overrides (forcedCwd/launchEnv)", () => {
	it("strips the internal fields from model-callable tool input", () => {
		const stripped = stripInternalLaunchOverrides({
			name: "cand",
			task: "Do work",
			title: "Do work",
			agent: "worker",
			forcedCwd: "/tmp/worktree",
			launchEnv: { COMPOSE_PROJECT_NAME: "bo-run-w0" },
		});
		assert.equal(stripped.forcedCwd, undefined);
		assert.equal(stripped.launchEnv, undefined);
		assert.equal(stripped.agent, "worker");
		assert.equal(stripped.name, "cand");
	});

	it("keeps the internal fields off the model-callable subagent tool schema", () => {
		for (const schema of [SubagentParams, SubagentChildParams]) {
			const properties = Object.keys(schema.properties ?? {});
			assert.equal(properties.includes("forcedCwd"), false, `forcedCwd leaked onto ${JSON.stringify(properties)}`);
			assert.equal(properties.includes("launchEnv"), false, `launchEnv leaked onto ${JSON.stringify(properties)}`);
			assert.equal(properties.includes("cwd"), false, `cwd leaked onto ${JSON.stringify(properties)}`);
		}
	});

	it("preserves internal overrides through frontmatter enforcement for trusted internal callers", () => {
		const enforced = enforceAgentFrontmatter(
			{
				name: "cand",
				task: "Do work",
				title: "Do work",
				agent: "worker",
				forcedCwd: "/tmp/worktree",
				launchEnv: { PORT_OFFSET: "1000" },
			},
			null,
		);
		assert.equal(enforced.forcedCwd, "/tmp/worktree");
		assert.deepEqual(enforced.launchEnv, { PORT_OFFSET: "1000" });
	});

	it("resolves a relative forcedCwd against the source cwd", () => {
		assert.equal(resolveForcedChildCwd({ forcedCwd: "/abs/worktree" }, "/source"), "/abs/worktree");
		assert.equal(resolveForcedChildCwd({ forcedCwd: "rel/wt" }, "/source"), join("/source", "rel/wt"));
		assert.equal(resolveForcedChildCwd({}, "/source"), undefined);
	});

	it("reports frontmatter env keys a launchEnv override replaces", () => {
		assert.deepEqual(getLaunchEnvCollisions({ A: "1", C: "3", NEW: "x" }, "A=1\nB=2\nC=3"), ["A", "C"]);
		assert.deepEqual(getLaunchEnvCollisions(undefined, "A=1"), []);
		assert.deepEqual(getLaunchEnvCollisions({ A: "1" }, undefined), []);
	});

	it("freezes the resolved blueprint and keeps it resolved against the source cwd", async () => {
		const source = createTestDir();
		const worktree = createTestDir();
		mkdirSync(join(source, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(source, ".pi", "agents", "worker.md"),
			"---\nname: worker\nmode: background\nauto-exit: true\n---\nYou work.",
		);
		const parentSession = join(source, "parent.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);

		const launch = await coordinateSubagentLaunch(
			{
				name: "vf-candidate",
				title: "VF candidate",
				task: "Do work",
				agent: "worker",
				forcedCwd: worktree,
				launchEnv: { COMPOSE_PROJECT_NAME: "bo-run-w0" },
			},
			{
				cwd: source,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ mode: "background" },
		);

		assert.equal(launch.forcedCwd, worktree);
		// Blueprint resolution stays source-based: the forced cwd never leaks
		// into runtime path resolution or persisted metadata.
		assert.equal(launch.prepared.runtimePaths.effectiveCwd, null);
		assert.equal(launch.prepared.runtimePaths.cwdBase, source);
		assert.equal(launch.launchMetadata.cwd, source);
		assert.equal(Object.isFrozen(launch.prepared), true);
		assert.equal(Object.isFrozen(launch.prepared.agentDefs), true);
		assert.throws(() => {
			(launch.prepared as unknown as { identity: string }).identity = "mutated";
		});
	});

	it("launchEnv wins over frontmatter env with a warning and cannot touch reserved spawn keys", () => {
		const { value: env, warnings } = captureWarnings(() =>
			getBaseSubagentEnvVars(
				fakePrepared({ env: "FRONTMATTER_KEY=from-frontmatter\nCOLLIDING=from-frontmatter\nPI_SUBAGENT_SPAWNABLE=evil" }),
				{
					name: "vf-candidate",
					title: "VF candidate",
					task: "Do work",
					agent: "cand",
					launchEnv: {
						COLLIDING: "from-launch",
						COMPOSE_PROJECT_NAME: "bo-run-w0",
						PORT_OFFSET: "1000",
						PI_SUBAGENT_SPAWNABLE: "evil",
					},
				},
				() => "standalone",
			),
		);
		assert.equal(env.FRONTMATTER_KEY, "from-frontmatter");
		assert.equal(env.COLLIDING, "from-launch");
		assert.equal(env.COMPOSE_PROJECT_NAME, "bo-run-w0");
		assert.equal(env.PORT_OFFSET, "1000");
		assert.notEqual(env.PI_SUBAGENT_SPAWNABLE, "evil");
		assert.deepEqual(warnings, ["[pi-subagents] launchEnv overrides frontmatter env: COLLIDING"]);
	});

	it("delivers forcedCwd, launchEnv, frontmatter env, and source-resolved task expansion to the real child process", async () => {
		const source = createTestDir();
		const worktree = createTestDir();
		process.env.PI_ARTIFACT_PROJECT_ROOT = join(source, "artifacts");
		mkdirSync(join(source, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(source, ".pi", "agents", "cand.md"),
			[
				"---",
				"name: cand",
				"mode: background",
				"auto-exit: true",
				"task-expansion: shell",
				"env: |",
				"  FRONTMATTER_KEY=from-frontmatter",
				"  COLLIDING=from-frontmatter",
				"---",
				"You are a candidate.",
			].join("\n"),
		);
		const parentSession = join(source, "parent.jsonl");
		writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
		const childLog = join(source, "child-env.log");
		const fakeBin = writeExecutable(
			createTestDir(),
			"fake-pi",
			[
				"#!/bin/sh",
				`printf 'CWD=%s\\n' "$(pwd)" > '${childLog}'`,
				`printf 'COMPOSE_PROJECT_NAME=%s\\n' "\${COMPOSE_PROJECT_NAME-unset}" >> '${childLog}'`,
				`printf 'PORT_OFFSET=%s\\n' "\${PORT_OFFSET-unset}" >> '${childLog}'`,
				`printf 'FRONTMATTER_KEY=%s\\n' "\${FRONTMATTER_KEY-unset}" >> '${childLog}'`,
				`printf 'COLLIDING=%s\\n' "\${COLLIDING-unset}" >> '${childLog}'`,
				`printf 'ARGV=%s\\n' "$*" >> '${childLog}'`,
			].join("\n"),
		);
		process.env.PI_SUBAGENT_PI_COMMAND = fakeBin;

		await launchBackgroundSubagent(
			{
				name: "vf-candidate",
				title: "VF candidate",
				task: "Work here: !`pwd`",
				agent: "cand",
				forcedCwd: worktree,
				launchEnv: { COMPOSE_PROJECT_NAME: "bo-run-w0", PORT_OFFSET: "1000", COLLIDING: "from-launch" },
			},
			{
				cwd: source,
				sessionManager: {
					getSessionFile: () => parentSession,
					getSessionId: () => "parent-session-id",
					getLeafId: () => null,
				},
			},
			{ getContextWindow: () => undefined },
		);

		const childLogText = await readEventually(childLog);
		assert.ok(childLogText.includes(`CWD=${worktree}`), `child ran in the worktree: ${childLogText}`);
		assert.ok(childLogText.includes("COMPOSE_PROJECT_NAME=bo-run-w0"), childLogText);
		assert.ok(childLogText.includes("PORT_OFFSET=1000"), childLogText);
		assert.ok(childLogText.includes("FRONTMATTER_KEY=from-frontmatter"), childLogText);
		assert.ok(childLogText.includes("COLLIDING=from-launch"), childLogText);
		// Task expansion ran once against the SOURCE tree, not the worktree.
		const taskArtifact = readFileSync(extractTaskArtifactPath(childLogText), "utf8");
		assert.ok(taskArtifact.includes(source), "task artifact embeds the source cwd");
		assert.ok(!taskArtifact.includes(worktree), "task artifact must not embed the worktree cwd");
	});
});
