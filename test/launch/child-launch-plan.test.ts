import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";
import { buildChildLaunchPlan } from "../../src/launch/child-launch-plan.ts";

/**
 * The child launch plan is the foundation seam for agent definition and launch
 * parameter resolution. Callers should not need to re-learn child capability,
 * model, cwd, and session path rules in separate modules.
 */
describe("child launch plan", () => {
	it("resolves model, runtime paths, and child capability facts in one place", async () => {
		const cwd = createTestDir();
		const parentSessionDir = join(cwd, "parent-sessions");

		const plan = await buildChildLaunchPlan({
			params: {
				name: "code-review",
				task: "review the diff",
				title: "Code review",
				agent: "reviewer",
				model: "provider/override:high",
				cwd: "launch-cwd",
			},
			agentDefs: {
				model: "provider/default",
				thinking: "low",
				tools: "read,bash",
				skills: "none",
				extensions: "none",
				denyTools: "bash",
				spawning: false,
				cwd: "agent-cwd",
				cwdBase: cwd,
			},
			parentCwd: cwd,
			parentSessionDir,
			parentModelRef: "provider/parent",
			parentThinking: "medium",
			modelRegistry: {
				getAvailable: () => [
					{
						provider: "provider",
						id: "override",
						thinkingLevelMap: { high: "high" },
					},
				],
			},
		});

		assert.equal(plan.effectiveModel, "provider/override");
		assert.equal(plan.effectiveThinking, "high");
		assert.equal(plan.effectiveModelRef, "provider/override:high");
		assert.equal(plan.runtimePaths.effectiveCwd, join(cwd, "launch-cwd"));
		assert.equal(plan.runtimePaths.targetCwdForSession, join(cwd, "launch-cwd"));
		assert.ok(plan.subagentSessionFile.startsWith(`${parentSessionDir}/`));

		assert.equal(plan.capability.tools, "read,bash");
		assert.equal(plan.capability.skills, "none");
		assert.equal(plan.capability.injectSkills, undefined);
		assert.deepEqual(plan.capability.extensions, []);
		assert.deepEqual([...plan.capability.denySet].sort(), [
			"bash",
			"subagent",
			"subagent_resume",
		]);
		assert.deepEqual(plan.capability.skillLaunchPlan.launchArgs, ["--no-skills"]);
	});

	it("reuses an unfiltered configured npm package from the child Pi root", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const packageRoot = join(agentDir, "npm", "node_modules", "pi-fancy-footer");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				npmCommand: ["bun"],
				packages: ["npm:pi-fancy-footer"],
			}),
		);
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "pi-fancy-footer",
				version: "1.4.0",
				pi: { extensions: ["src/index.ts"] },
			}),
		);

		const plan = await buildChildLaunchPlan({
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "npm:pi-fancy-footer",
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
			mode: "background",
		});

		assert.deepEqual(plan.capability.extensions, [packageRoot]);
	});

	it("reuses an exactly configured Git package from the child Pi root", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const packageRoot = join(agentDir, "git", "github.com", "example", "footer-extension");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["git:github.com/example/footer-extension"] }),
		);
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "footer-extension",
				version: "1.0.0",
				pi: { extensions: ["src/index.ts"] },
			}),
		);

		const plan = await buildChildLaunchPlan({
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "git:github.com/example/footer-extension",
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
			mode: "background",
		});

		assert.deepEqual(plan.capability.extensions, [packageRoot]);
	});

	it("keeps Git on temporary resolution when the requested ref differs", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const packageRoot = join(agentDir, "git", "github.com", "example", "footer-extension");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["git:github.com/example/footer-extension@v2"] }),
		);
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "footer-extension", version: "2.0.0" }),
		);

		const plan = await buildChildLaunchPlan({
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "git:github.com/example/footer-extension@v1",
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
			mode: "background",
		});

		assert.deepEqual(plan.capability.extensions, [
			"git:github.com/example/footer-extension@v1",
		]);
	});

	it("keeps temporary resolution when a configured npm package is not installed", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:missing-footer"] }),
		);

		const plan = await buildChildLaunchPlan({
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "npm:missing-footer",
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
			mode: "background",
		});

		assert.deepEqual(plan.capability.extensions, ["npm:missing-footer"]);
	});

	it("does not reuse project packages for an untrusted background child", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const projectPackageRoot = join(cwd, ".pi", "npm", "node_modules", "project-footer");
		mkdirSync(projectPackageRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:project-footer"] }),
		);
		writeFileSync(
			join(projectPackageRoot, "package.json"),
			JSON.stringify({ name: "project-footer", version: "1.0.0" }),
		);

		const base = {
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "npm:project-footer",
				trustProject: true,
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
		};

		const background = await buildChildLaunchPlan({ ...base, mode: "background" });
		assert.deepEqual(background.capability.extensions, ["npm:project-footer"]);

		const interactive = await buildChildLaunchPlan({ ...base, mode: "interactive" });
		assert.deepEqual(interactive.capability.extensions, [projectPackageRoot]);
	});

	it("honors final approval flags when resolving project packages", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const projectPackageRoot = join(cwd, ".pi", "npm", "node_modules", "project-footer");
		mkdirSync(projectPackageRoot, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}");
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ packages: ["npm:project-footer"] }),
		);
		writeFileSync(
			join(projectPackageRoot, "package.json"),
			JSON.stringify({ name: "project-footer", version: "1.0.0" }),
		);

		const plan = await buildChildLaunchPlan({
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "npm:project-footer",
				flags: "--approve",
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
			mode: "background",
		});

		assert.deepEqual(plan.capability.extensions, [projectPackageRoot]);
	});

	it("keeps explicitly versioned npm sources on Pi's temporary resolver", async () => {
		const cwd = createTestDir();
		const agentDir = join(cwd, "agent-root");
		const packageRoot = join(agentDir, "npm", "node_modules", "pi-fancy-footer");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-fancy-footer"] }),
		);
		writeFileSync(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "pi-fancy-footer", version: "1.4.0" }),
		);

		const plan = await buildChildLaunchPlan({
			params: {
				name: "footer-check",
				task: "report the footer version",
				title: "Footer check",
				agent: "reviewer",
			},
			agentDefs: {
				extensions: "npm:pi-fancy-footer@1.3.2",
				env: `PI_CODING_AGENT_DIR=${agentDir}`,
			},
			parentCwd: cwd,
			parentSessionDir: join(cwd, "parent-sessions"),
			mode: "background",
		});

		assert.deepEqual(plan.capability.extensions, ["npm:pi-fancy-footer@1.3.2"]);
	});

	it("enforces allowed models after resolving bare model ids", async () => {
		const cwd = createTestDir();
		const parentSessionDir = join(cwd, "parent-sessions");

		const plan = await buildChildLaunchPlan({
			params: {
				name: "code-review",
				task: "review the diff",
				title: "Code review",
				agent: "reviewer",
				model: "glm-5.1:high",
			},
			agentDefs: {
				model: "zai-messages/glm-5-turbo:off",
				allowedModels: "zai-messages/glm-5.1:high",
			},
			parentCwd: cwd,
			parentSessionDir,
			parentModelRef: "zai-messages/glm-5-turbo",
			parentThinking: "medium",
			modelRegistry: {
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5.1" },
					{ provider: "zai-messages", id: "glm-5-turbo" },
				],
			},
		});

		assert.equal(plan.effectiveModelRef, "zai-messages/glm-5.1:high");

		await assert.rejects(
			() => buildChildLaunchPlan({
				params: {
					name: "code-review",
					task: "review the diff",
					title: "Code review",
					agent: "reviewer",
					model: "glm-5.1",
				},
				agentDefs: {
					allowedModels: "openai-ws/gpt-5.5:low",
				},
				parentCwd: cwd,
				parentSessionDir,
				parentModelRef: "zai-messages/glm-5-turbo",
				parentThinking: "medium",
				modelRegistry: {
					getAvailable: () => [
						{ provider: "zai-messages", id: "glm-5.1" },
						{ provider: "zai-messages", id: "glm-5-turbo" },
					],
				},
			}),
			/Model 'zai-messages\/glm-5\.1:medium' is not allowed for agent 'reviewer'/,
		);
	});

	it("resolves bare agent default models before allowed model checks", async () => {
		const cwd = createTestDir();
		const parentSessionDir = join(cwd, "parent-sessions");

		const plan = await buildChildLaunchPlan({
			params: {
				name: "code-review",
				task: "review the diff",
				title: "Code review",
				agent: "reviewer",
			},
			agentDefs: {
				model: "glm-5.1:high",
				allowedModels: "openai-ws/gpt-5.5:low",
			},
			parentCwd: cwd,
			parentSessionDir,
			parentModelRef: "zai-messages/glm-5-turbo",
			parentThinking: "medium",
			modelRegistry: {
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5.1" },
					{ provider: "zai-messages", id: "glm-5-turbo" },
				],
			},
		});

		assert.equal(plan.effectiveModelRef, "zai-messages/glm-5.1:high");
	});

	it("passes bare agent default models through untouched without allowed-models", async () => {
		const cwd = createTestDir();
		const parentSessionDir = join(cwd, "parent-sessions");

		const plan = await buildChildLaunchPlan({
			params: {
				name: "code-review",
				task: "review the diff",
				title: "Code review",
				agent: "reviewer",
			},
			agentDefs: {
				model: "some-bare-model",
			},
			parentCwd: cwd,
			parentSessionDir,
			modelRegistry: {
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5.1" },
				],
			},
		});

		assert.equal(plan.effectiveModel, "some-bare-model");
	});

	it("treats allowed model refs without thinking as model-wide entries", async () => {
		const cwd = createTestDir();
		const parentSessionDir = join(cwd, "parent-sessions");
		const base = {
			params: {
				name: "code-review",
				task: "review the diff",
				title: "Code review",
				agent: "reviewer",
				model: "zai-messages/glm-5.1:high",
			},
			parentCwd: cwd,
			parentSessionDir,
		};

		await assert.doesNotReject(() => buildChildLaunchPlan({
			...base,
			agentDefs: { model: "zai-messages/glm-5-turbo:off", allowedModels: "zai-messages/glm-5.1" },
		}));

		await assert.rejects(
			() => buildChildLaunchPlan({
				...base,
				agentDefs: { model: "zai-messages/glm-5-turbo:off", allowedModels: "zai-messages/glm-5.1:low" },
			}),
			/Model 'zai-messages\/glm-5\.1:high' is not allowed for agent 'reviewer'/,
		);
	});

	it("allows the inherited parent model when no agent default is set", async () => {
		const cwd = createTestDir();
		const parentSessionDir = join(cwd, "parent-sessions");

		const plan = await buildChildLaunchPlan({
			params: {
				name: "code-review",
				task: "review the diff",
				title: "Code review",
				agent: "reviewer",
			},
			agentDefs: { allowedModels: "nahcrof/glm-5.1:off" },
			parentCwd: cwd,
			parentSessionDir,
			parentModelRef: "zai-messages/glm-5-turbo",
			parentThinking: "off",
			modelRegistry: {
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5-turbo" },
					{ provider: "nahcrof", id: "glm-5.1" },
				],
			},
		});

		assert.equal(plan.effectiveModelRef, "zai-messages/glm-5-turbo:off");
	});
});
