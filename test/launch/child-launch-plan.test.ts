import {
	assert,
	createTestDir,
	describe,
	it,
	join,
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
});
