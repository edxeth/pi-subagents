import { afterEach, assert, describe, it, resetSubagentStateForTest } from "../support/index.ts";
import { getBaseSubagentEnvVars } from "../../src/launch/prep.ts";
import { parseSpawnEnv, resolveSpawnPolicy, type SpawnPolicyInput } from "../../src/spawn/policy.ts";
import type { AgentDefaults } from "../../src/agents/definitions.ts";
import type { PreparedSubagentLaunch } from "../../src/launch/prep.ts";

function resolvePolicy(overrides: Partial<SpawnPolicyInput> = {}) {
	return resolveSpawnPolicy({
		callerAgent: "caller",
		targetAgent: "target",
		callerBudget: null,
		callerSpawnable: true,
		targetSpawning: true,
		targetSpawnDepth: undefined,
		targetSpawnWidth: undefined,
		targetVisibleTo: ["all"],
		envDepthCeiling: null,
		envWidthCeiling: null,
		...overrides,
	});
}

function preparedEnv(agentDefs: AgentDefaults | null): Record<string, string> {
	return getBaseSubagentEnvVars(
		{
			agentDefs,
			denySet: new Set(),
			runtimePaths: {},
			sessionFile: "parent.jsonl",
			subagentSessionFile: "child.jsonl",
		} as PreparedSubagentLaunch,
		{ agent: "target", name: "child", task: "task", title: "Child task" },
		() => "lineage-only",
	);
}

describe("spawn policy", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("decrements the caller budget and stops nested spawning at zero", () => {
		const cases: Array<{ name: string; input: Partial<SpawnPolicyInput>; childBudget: number | null }> = [
			{
				name: "root to A",
				input: { callerAgent: null, targetAgent: "agent-a", targetSpawnDepth: 1 },
				childBudget: 1,
			},
			{ name: "A(1) to B", input: { callerBudget: 1, targetSpawnDepth: 1 }, childBudget: null },
			{ name: "A(2) to B(2)", input: { callerBudget: 2, targetSpawnDepth: 2 }, childBudget: 1 },
			{ name: "environment ceiling wins", input: { targetSpawnDepth: 5, envDepthCeiling: 2 }, childBudget: 2 },
			{ name: "caller budget wins", input: { callerBudget: 2, targetSpawnDepth: 5 }, childBudget: 1 },
		];
		for (const testCase of cases) {
			assert.equal(resolvePolicy(testCase.input).childBudget, testCase.childBudget, testCase.name);
		}

		const cycleEdge = resolvePolicy({
			callerAgent: "agent-a",
			callerBudget: 1,
			targetAgent: "agent-b",
			targetSpawnDepth: 1,
		});
		assert.equal(cycleEdge.allowed, true);
		assert.equal(cycleEdge.childBudget, null);
		const exhausted = resolvePolicy({ callerBudget: 0 });
		assert.equal(exhausted.allowed, false);
		assert.equal(exhausted.failingSide, "budget");
	});

	it("denies a target outside the caller spawnable list", () => {
		assert.equal(resolvePolicy({ callerSpawnable: ["agent-b"], targetAgent: "agent-b" }).allowed, true);
		const rejected = resolvePolicy({ callerSpawnable: ["agent-b"], targetAgent: "agent-c" });
		assert.equal(rejected.allowed, false);
		assert.equal(rejected.failingSide, "whitelist");
		assert.equal(resolvePolicy({ callerSpawnable: true, targetAgent: "agent-c" }).allowed, true);
	});

	it("applies target visibility from the caller side", () => {
		assert.equal(resolvePolicy({ callerAgent: null, targetVisibleTo: ["all"] }).allowed, true);
		const rootOnly = resolvePolicy({ callerAgent: "child", targetVisibleTo: ["root"] });
		assert.equal(rootOnly.allowed, false);
		assert.equal(rootOnly.failingSide, "visible-to");
		assert.equal(resolvePolicy({ callerAgent: null, targetVisibleTo: ["root"] }).allowed, true);
		assert.equal(resolvePolicy({ callerAgent: "agent-a", targetVisibleTo: ["agent-a"] }).allowed, true);
		assert.equal(resolvePolicy({ callerAgent: "agent-a", targetVisibleTo: ["root", "agent-a"] }).allowed, true);
		assert.equal(resolvePolicy({ callerAgent: "agent-b", targetVisibleTo: ["agent-a"] }).allowed, false);
	});

	it("clamps width and represents an unlimited width as null", () => {
		assert.equal(resolvePolicy({ targetSpawnWidth: 5, envWidthCeiling: 3 }).effectiveWidth, 3);
		assert.equal(resolvePolicy({ targetSpawnWidth: 3, envWidthCeiling: 5 }).effectiveWidth, 3);
		// Above the compiled ceiling it clamps to MAX_SPAWN_WIDTH (16).
		assert.equal(resolvePolicy({ targetSpawnWidth: 20 }).effectiveWidth, 16);
		assert.equal(resolvePolicy().effectiveWidth, 16);
	});

	it("turns a non-spawning target into a child with no spawn grant", () => {
		const result = resolvePolicy({ targetSpawning: false, targetSpawnDepth: 5 });
		assert.equal(result.allowed, true);
		assert.equal(result.childBudget, null);
		assert.deepEqual(result.spawnableAgents, []);
	});

	it("parses spawn environment values without throwing on garbage", () => {
		assert.deepEqual(
			parseSpawnEnv({
				PI_SUBAGENT_AGENT: "agent-a",
				PI_SUBAGENT_SPAWN_BUDGET: "2",
				PI_SUBAGENT_SPAWN_DEPTH: "4",
				PI_SUBAGENT_SPAWN_WIDTH: "3",
				PI_SUBAGENT_SPAWNABLE: "agent-b, agent-c",
			}),
			{
				callerAgent: "agent-a",
				callerBudget: 2,
				envDepthCeiling: 4,
				envWidthCeiling: 3,
				callerSpawnable: ["agent-b", "agent-c"],
			},
		);
		assert.deepEqual(parseSpawnEnv({ PI_SUBAGENT_SPAWNABLE: "" }).callerSpawnable, []);
		assert.equal(parseSpawnEnv({ PI_SUBAGENT_SPAWNABLE: "true" }).callerSpawnable, true);
		assert.equal(parseSpawnEnv({}).callerAgent, null);
		assert.equal(parseSpawnEnv({}).callerBudget, null);
		assert.equal(
			parseSpawnEnv({
				PI_SUBAGENT_SPAWN_BUDGET: "garbage",
				PI_SUBAGENT_SPAWN_DEPTH: "nope",
				PI_SUBAGENT_SPAWN_WIDTH: "1.5",
			}).callerBudget,
			0,
		);
		assert.equal(parseSpawnEnv({}).callerSpawnable, true);
	});

	it("writes computed budget and spawnable values over frontmatter env values", () => {
		process.env.PI_SUBAGENT_AGENT = "agent-a";
		process.env.PI_SUBAGENT_SPAWN_BUDGET = "0";
		process.env.PI_SUBAGENT_SPAWN_DEPTH = "4";
		process.env.PI_SUBAGENT_SPAWN_WIDTH = "3";
		process.env.PI_SUBAGENT_SPAWNABLE = "all";

		const env = preparedEnv({
			spawning: true,
			env: [
				"FOO=bar",
				"PI_SUBAGENT_SPAWN_BUDGET=99",
				"PI_SUBAGENT_SPAWNABLE=agent-c",
				"PI_SUBAGENT_SPAWN_DEPTH=99",
				"PI_SUBAGENT_SPAWN_WIDTH=99",
			].join("\n"),
		});

		assert.equal(env.FOO, "bar");
		assert.equal(env.PI_SUBAGENT_SPAWN_BUDGET, "0");
		assert.equal(env.PI_SUBAGENT_SPAWNABLE, "true");
		assert.equal(env.PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE, "3");
		assert.equal(env.PI_SUBAGENT_SPAWN_DEPTH, undefined);
		assert.equal(env.PI_SUBAGENT_SPAWN_WIDTH, undefined);
	});

	it("uses a child effective width over the inherited operator ceiling", () => {
		assert.equal(
			parseSpawnEnv({
				PI_SUBAGENT_AGENT: "agent-a",
				PI_SUBAGENT_SPAWN_WIDTH: "9",
				PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE: "3",
			}).envWidthCeiling,
			3,
		);
		assert.equal(
			parseSpawnEnv({
				PI_SUBAGENT_SPAWN_WIDTH: "9",
				PI_SUBAGENT_SPAWN_WIDTH_EFFECTIVE: "3",
			}).envWidthCeiling,
			9,
		);
	});

	it("always writes zero budget and an empty spawnable list for non-spawning targets", () => {
		delete process.env.PI_SUBAGENT_SPAWN_BUDGET;
		delete process.env.PI_SUBAGENT_SPAWNABLE;
		const env = preparedEnv({ spawning: false });
		assert.equal(env.PI_SUBAGENT_SPAWN_BUDGET, "0");
		assert.equal(env.PI_SUBAGENT_SPAWNABLE, "");
	});
});
