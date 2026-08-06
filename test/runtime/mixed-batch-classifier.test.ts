import type { AgentDefaults } from "../../src/agents/definitions.ts";
import { classifyAssistantMessageForMixedBatch } from "../../src/runtime/batch-classifier.ts";
import { isSubagentBatchBlocking, resetSubagentBatchStopRequest } from "../../src/runtime/state.ts";
import { assert, beforeEach, describe, it } from "../support/index.ts";

type ToolCallLike = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
};

type AssistantMessageLike = {
	role: "assistant";
	content: ({ type: "text"; text: string } | ToolCallLike)[];
};

function asyncAgentDefs(name = "scout"): AgentDefaults {
	return { name, async: true } as AgentDefaults;
}

function blockingAgentDefs(name = "blocker"): AgentDefaults {
	return { name, async: false } as AgentDefaults;
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallLike {
	return {
		type: "toolCall",
		id: `id-${name}-${Math.random()}`,
		name,
		arguments: args,
	};
}

function message(...calls: ToolCallLike[]): AssistantMessageLike {
	return { role: "assistant", content: calls };
}

function loaderForAgent(defs: AgentDefaults | null) {
	return (_agent: string | undefined): AgentDefaults | null => defs;
}

beforeEach(() => {
	resetSubagentBatchStopRequest();
	delete process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN;
});

describe("classifyAssistantMessageForMixedBatch", () => {
	it("does not mark a pure async subagent batch as blocking", () => {
		const msg = message(call("subagent", { agent: "scout" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("marks a mixed async subagent + bash batch as blocking", () => {
		const msg = message(call("subagent", { agent: "scout" }), call("bash", { command: "ls" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), true);
	});

	it("does not mark a pure non-subagent batch as blocking", () => {
		const msg = message(call("bash", { command: "ls" }), call("read", { path: "x" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(null));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("does not mark a blocking subagent + bash batch (already sync via frontmatter)", () => {
		const msg = message(call("subagent", { agent: "blocker" }), call("bash", { command: "ls" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(blockingAgentDefs()));

		// Existing batch barrier already covers this; we should not double-mark.
		// markSubagentBatchBlocking is idempotent so even if we did, no harm.
		// The contract we test: classifier itself does not flip the flag here.
		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("marks an async subagent_resume + bash batch as blocking", () => {
		const msg = message(call("subagent_resume", { sessionFile: "/tmp/x.jsonl" }), call("bash", { command: "ls" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(null));

		assert.equal(isSubagentBatchBlocking(), true);
	});

	it("does not mark a subagent_resume(async:false) + bash batch as blocking", () => {
		// Defensive coverage: if an async:false flag is ever added to the
		// subagent_resume schema, the classifier should respect it. Today
		// the registered schema at src/tools/resume-tool.ts does not expose
		// async, so the persisted launch-metadata branch via
		// resume-service.ts is the only practical way to get a sync resume.
		// This test documents the classifier-level contract regardless.
		const msg = message(
			call("subagent_resume", {
				sessionFile: "/tmp/x.jsonl",
				async: false,
			}),
			call("bash", { command: "ls" }),
		);

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(null));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("does not mark a multi-async-subagent-only batch as blocking", () => {
		const msg = message(call("subagent", { agent: "scout" }), call("subagent", { agent: "scout" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("marks a multi-async-subagent + bash batch as blocking", () => {
		const msg = message(
			call("subagent", { agent: "scout" }),
			call("subagent", { agent: "scout" }),
			call("bash", { command: "ls" }),
		);

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), true);
	});

	it("does not mark when PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1", () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const msg = message(call("subagent", { agent: "scout" }), call("bash", { command: "ls" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("ignores tool calls inside non-assistant messages", () => {
		const msg = {
			role: "user",
			content: [call("subagent", { agent: "scout" }), call("bash", { command: "ls" })],
		};

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("ignores assistant messages with no tool calls", () => {
		const msg: AssistantMessageLike = {
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
		};

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("does not mark when the only subagent call has an unknown agent (no defs)", () => {
		const msg = message(call("subagent", { agent: "missing" }), call("bash", { command: "ls" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(null));

		// Unknown agent: existing tool_call validation will surface the error.
		// Classifier conservatively does not treat it as a launch.
		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("marks the batch regardless of tool order (bash before subagent)", () => {
		const msg = message(call("bash", { command: "ls" }), call("subagent", { agent: "scout" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), true);
	});

	it("does not mark a subagent + set_tab_title batch as blocking", () => {
		// set_tab_title is a pi-subagents-internal cosmetic tool. It does no
		// real work and pairing it with a subagent launch should not force
		// the parent to await — the original race condition does not apply
		// because there is no side-effecting sibling competing for the
		// parent's attention.
		const msg = message(call("subagent", { agent: "scout" }), call("set_tab_title", { title: "Sticky test" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("does not mark a subagent + subagent_kill batch as blocking", () => {
		// subagent_kill is a pi-subagents-internal control tool. Same logic:
		// no side-effecting sibling work, no race to prevent.
		const msg = message(call("subagent", { agent: "scout" }), call("subagent_kill", { id: "child-1" }));

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("marks a children-array async multi-launch + bash batch as blocking", () => {
		// The subagent tool supports a `children: [...]` array for batched
		// multi-launch (see getRequestedChildren in subagent-tools.ts). The
		// classifier must inspect children, not just top-level params.agent,
		// or async multi-launches would race the parent in mixed batches.
		const msg = message(
			call("subagent", {
				children: [
					{ name: "c1", title: "C1", task: "t", agent: "scout" },
					{ name: "c2", title: "C2", task: "t", agent: "scout" },
				],
			}),
			call("bash", { command: "ls" }),
		);

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), true);
	});

	it("does not mark a children-array async-only batch (no other tools)", () => {
		const msg = message(
			call("subagent", {
				children: [
					{ name: "c1", title: "C1", task: "t", agent: "scout" },
					{ name: "c2", title: "C2", task: "t", agent: "scout" },
				],
			}),
		);

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));

		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("does not mark a children-array all-blocking + bash batch (already sync)", () => {
		const msg = message(
			call("subagent", {
				children: [
					{ name: "c1", title: "C1", task: "t", agent: "blocker" },
					{ name: "c2", title: "C2", task: "t", agent: "blocker" },
				],
			}),
			call("bash", { command: "ls" }),
		);

		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(blockingAgentDefs()));

		// Each child resolves to blocking via frontmatter; the existing barrier
		// already covers that. The mixed-async barrier should not fire.
		assert.equal(isSubagentBatchBlocking(), false);
	});

	it("marks when a children-array contains AT LEAST ONE async child + bash", () => {
		// One async child is enough to create the race in a mixed batch.
		const loader = (agent: string | undefined): AgentDefaults | null => {
			if (agent === "async-scout") return asyncAgentDefs("async-scout");
			if (agent === "blocker") return blockingAgentDefs("blocker");
			return null;
		};
		const msg = message(
			call("subagent", {
				children: [
					{ name: "c1", title: "C1", task: "t", agent: "blocker" },
					{ name: "c2", title: "C2", task: "t", agent: "async-scout" },
				],
			}),
			call("bash", { command: "ls" }),
		);

		classifyAssistantMessageForMixedBatch(msg as never, loader);

		assert.equal(isSubagentBatchBlocking(), true);
	});

	it("preserves async agent identity in launch params even when the barrier fires", async () => {
		// Mixed-batch barrier flips the await decision, NOT the agent identity
		// or persisted launch metadata. enforceAgentFrontmatter resolves
		// async/blocking from frontmatter only; the barrier is a separate flag
		// (currentSubagentBatchHasBlocking) checked by shouldAwaitSubagentLaunch
		// at result-shape time. So launch metadata still records async: true,
		// and a later subagent_resume reads async: true from that metadata and
		// resumes async (subject to its own batch composition at resume time).
		const { enforceAgentFrontmatterForTest } = await import("../support/index.ts");

		// Mixed batch fires the barrier.
		const msg = message(call("subagent", { agent: "scout" }), call("bash", { command: "ls" }));
		classifyAssistantMessageForMixedBatch(msg as never, loaderForAgent(asyncAgentDefs()));
		assert.equal(isSubagentBatchBlocking(), true);

		// enforceAgentFrontmatter still resolves async: true for an async agent.
		const params = {
			name: "child-1",
			task: "do work",
			title: "Run",
			agent: "scout",
		};
		const effective = enforceAgentFrontmatterForTest(params as never, asyncAgentDefs());

		// The agent identity (what gets persisted in launch metadata via
		// `params.async ?? !(params.blocking ?? false)`) is async, regardless
		// of the barrier. The barrier only affects whether the parent awaits
		// at this specific tool-result moment.
		assert.equal(effective.async, true);
		assert.equal(effective.blocking, false);
	});
});
