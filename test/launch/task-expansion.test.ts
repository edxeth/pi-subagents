import { launchBackgroundSubagent } from "../../src/launch/background.ts";
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

async function launchAndReadTaskArtifact(options: {
	agentBody?: string;
	agentFrontmatter?: string[];
	cwd?: string;
	task: string;
}): Promise<{ cwd: string; taskArtifact: string }> {
	const cwd = options.cwd ?? createTestDir();
	mkdirSync(cwd, { recursive: true });
	process.env.PI_ARTIFACT_PROJECT_ROOT = join(cwd, "artifacts");
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "agents", "expander.md"),
		[
			"---",
			"name: expander",
			"mode: background",
			"auto-exit: true",
			...(options.agentFrontmatter ?? []),
			"---",
			options.agentBody ?? "You receive prepared task context.",
		].join("\n"),
	);
	const parentSession = join(cwd, "parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify(SESSION_HEADER)}\n`);
	const childLog = join(cwd, "child-argv.log");
	const fakeBin = writeExecutable(
		createTestDir(),
		"fake-pi",
		`#!/bin/sh
printf '%s\n' "$*" > '${childLog}'
`,
	);
	process.env.PI_SUBAGENT_PI_COMMAND = fakeBin;

	await launchBackgroundSubagent(
		{
			name: "expand-child",
			title: "Expand child",
			task: options.task,
			agent: "expander",
		},
		{
			cwd,
			sessionManager: {
				getSessionFile: () => parentSession,
				getSessionId: () => "parent-session-id",
				getLeafId: () => null,
			},
		},
		{ getContextWindow: () => undefined },
	);

	const argvLog = await readEventually(childLog);
	return {
		cwd,
		taskArtifact: readFileSync(extractTaskArtifactPath(argvLog), "utf8"),
	};
}

describe("subagent task expansion", () => {
	it("expands command placeholders in the child task artifact when the agent opts in", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			agentFrontmatter: ["task-expansion: shell"],
			task: [
				"Summarize this prepared context.",
				"",
				"Inline: !`printf inline-marker`",
				"",
				"```!",
				"printf block-marker",
				"```",
			].join("\n"),
		});

		assert.match(taskArtifact, /Inline: inline-marker/);
		assert.match(taskArtifact, /block-marker/);
		assert.doesNotMatch(taskArtifact, /!`printf inline-marker`/);
	});

	it("leaves command placeholders literal without agent opt-in", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			task: "Inline: !`printf inline-marker`",
		});

		assert.match(taskArtifact, /Inline: !`printf inline-marker`/);
		assert.doesNotMatch(taskArtifact, /Inline: inline-marker/);
	});

	it("does not expand placeholders outside the explicit task text", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			agentBody: "Identity marker: !`printf identity-marker`",
			agentFrontmatter: ["task-expansion: shell"],
			task: "Task marker: !`printf task-marker`",
		});

		assert.match(taskArtifact, /Task marker: task-marker/);
		assert.match(taskArtifact, /Identity marker: !`printf identity-marker`/);
		assert.doesNotMatch(taskArtifact, /Identity marker: identity-marker/);
	});

	it("runs commands from the child cwd and exposes PI_WORKSPACE without shell-source substitution", async () => {
		const base = createTestDir();
		const cwd = join(base, "workspace-$(touch${IFS}injected)");
		const { taskArtifact } = await launchAndReadTaskArtifact({
			cwd,
			agentFrontmatter: ["task-expansion: shell"],
			task: 'Workspace: !`printf "%s" "${PI_WORKSPACE}"`',
		});

		assert.match(taskArtifact, /Workspace: /);
		assert.ok(taskArtifact.includes(`Workspace: ${cwd}`));
		assert.equal(existsSync(join(cwd, "injected")), false);
	});

	it("does not expand inline placeholders inside ordinary Markdown code fences", async () => {
		const { cwd, taskArtifact } = await launchAndReadTaskArtifact({
			agentFrontmatter: ["task-expansion: shell"],
			task: [
				"```sh",
				"literal !`touch should-not-run && printf SHOULD_NOT_RUN`",
				"```",
				"Actual: !`printf actual-marker`",
			].join("\n"),
		});

		assert.match(taskArtifact, /literal !`touch should-not-run && printf SHOULD_NOT_RUN`/);
		assert.match(taskArtifact, /Actual: actual-marker/);
		assert.equal(existsSync(join(cwd, "should-not-run")), false);
	});

	it("executes mixed inline and fenced placeholders in source order", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			agentFrontmatter: ["task-expansion: shell"],
			task: [
				"Create: !`printf ordered > order.txt && printf created`",
				"Read it back:",
				"```!",
				"cat order.txt",
				"```",
			].join("\n"),
		});

		assert.match(taskArtifact, /Create: created/);
		assert.match(taskArtifact, /Read it back:\nordered/);
		assert.doesNotMatch(taskArtifact, /task shell failed/);
	});

	it("expands three inline commands in source order", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			agentFrontmatter: ["task-expansion: shell"],
			task: [
				"First: !`printf one > inline-order.txt && printf first`",
				"Second: !`cat inline-order.txt`",
				"Third: !`printf two >> inline-order.txt && cat inline-order.txt`",
			].join("\n"),
		});

		assert.match(taskArtifact, /First: first/);
		assert.match(taskArtifact, /Second: one/);
		assert.match(taskArtifact, /Third: onetwo/);
		assert.doesNotMatch(taskArtifact, /task shell failed/);
	});

	it("runs multiple commands from one fenced shell block", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			agentFrontmatter: ["task-expansion: shell"],
			task: [
				"Block output:",
				"```!",
				"printf 'alpha\\n' > block-output.txt",
				"printf 'beta\\n' >> block-output.txt",
				"cat block-output.txt",
				"```",
			].join("\n"),
		});

		assert.match(taskArtifact, /Block output:\nalpha\nbeta/);
		assert.doesNotMatch(taskArtifact, /task shell failed/);
	});

	it("expands task-expansion placeholders in orchestrator mode when explicitly opted in", async () => {
		const originalOrchestratorMode = process.env.PI_ORCHESTRATOR_MODE;
		process.env.PI_ORCHESTRATOR_MODE = "1";
		try {
			const { cwd, taskArtifact } = await launchAndReadTaskArtifact({
				agentFrontmatter: ["task-expansion: shell"],
				task: "Inline: !`touch orchestrator-ran && printf orchestrator-marker`",
			});

			assert.match(taskArtifact, /Inline: orchestrator-marker/);
			assert.equal(existsSync(join(cwd, "orchestrator-ran")), true);
		} finally {
			if (originalOrchestratorMode === undefined) delete process.env.PI_ORCHESTRATOR_MODE;
			else process.env.PI_ORCHESTRATOR_MODE = originalOrchestratorMode;
		}
	});

	it("expands repeated placeholders without reprocessing command output", async () => {
		const { taskArtifact } = await launchAndReadTaskArtifact({
			agentFrontmatter: ["task-expansion: shell"],
			task: [
				"First: !`printf repeated-marker`",
				"Second: !`printf repeated-marker`",
				"```!",
				"printf '!`printf nested-marker`'",
				"```",
			].join("\n"),
		});

		assert.match(taskArtifact, /First: repeated-marker/);
		assert.match(taskArtifact, /Second: repeated-marker/);
		assert.match(taskArtifact, /!`printf nested-marker`/);
		assert.doesNotMatch(taskArtifact, /nested-marker(?!`)/);
	});
});
