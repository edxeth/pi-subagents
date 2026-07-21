import {
	assert,
	describe,
	it,
	getPersistedSessionParityArgsForTest,
	resolveAvailableModelRefForTest,
	resolveResumeLaunchMetadataForInvocationForTest,
} from "../support/index.ts";

describe("resume model launch configuration", () => {
	it("resolves resume model override unless launch metadata opts out", async () => {
		const base = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "code-review",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "continue" as const,
			async: true,
			model: "provider/default",
			thinking: "low",
			modelRef: "provider/default:low",
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};

		const ignored = resolveResumeLaunchMetadataForInvocationForTest(
			{ ...base, allowModelOverride: false },
			"provider/requested:high",
		);
		assert.equal(ignored?.modelRef, "provider/default:low");
		assert.equal(ignored?.ignoredModelOverride, "provider/requested:high");

		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			base,
			"provider/requested:high",
		);
		assert.equal(overridden?.modelRef, "provider/requested:high");
		assert.equal(overridden?.modelSource, "resume-override");

		assert.deepEqual(await getPersistedSessionParityArgsForTest(overridden), [
			"--model",
			"provider/requested:high",
			"--no-approve",
		]);
	});

	it("rejects resume model overrides outside persisted allowed models", () => {
		const base = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "code-review",
			mode: "background" as const,
			sessionMode: "lineage-only" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "zai-messages/glm-5.1",
			modelRef: "zai-messages/glm-5.1:high",
			definitionModel: "zai-messages/glm-5.1:high",
			allowedModels: "nahcrof/glm-5.1:off",
			allowModelOverride: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};

		assert.throws(
			() => resolveResumeLaunchMetadataForInvocationForTest(
				base,
				"openai-ws/gpt-5.5:low",
				{
					getAvailable: () => [
						{ provider: "zai-messages", id: "glm-5.1" },
						{ provider: "openai-ws", id: "gpt-5.5" },
					],
				},
			),
			/Model 'openai-ws\/gpt-5\.5:low' is not allowed for agent 'code-review'/,
		);

		const defaultAllowed = resolveResumeLaunchMetadataForInvocationForTest(
			base,
			"zai-messages/glm-5.1:high",
			{
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5.1" },
				],
			},
		);
		assert.equal(defaultAllowed?.modelRef, "zai-messages/glm-5.1:high");

		const extraAllowed = resolveResumeLaunchMetadataForInvocationForTest(
			base,
			"nahcrof/glm-5.1:off",
			{
				getAvailable: () => [
					{ provider: "nahcrof", id: "glm-5.1" },
				],
			},
		);
		assert.equal(extraAllowed?.modelRef, "nahcrof/glm-5.1:off");
	});

	it("implicitly allows the persisted default model plus its thinking on resume", () => {
		const base = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "reviewer",
			mode: "background" as const,
			sessionMode: "fork" as const,
			parentClosePolicy: "terminate" as const,
			async: true,
			model: "openai-cpa/gpt-5.5",
			thinking: "xhigh",
			modelRef: "openai-cpa/gpt-5.5:xhigh",
			definitionModel: "openai-cpa/gpt-5.5",
			definitionThinking: "xhigh",
			allowedModels: "zai-messages/glm-5.2:xhigh",
			allowModelOverride: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp",
			cwd: "/tmp",
			boundarySystemPrompt: true,
		};

		const defaultAllowed = resolveResumeLaunchMetadataForInvocationForTest(
			base,
			"openai-cpa/gpt-5.5:xhigh",
			{ getAvailable: () => [{ provider: "openai-cpa", id: "gpt-5.5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }] },
		);
		assert.equal(defaultAllowed?.modelRef, "openai-cpa/gpt-5.5:xhigh");
	});

	it("accepts newly supported Pi thinking levels on resume", () => {
		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "reviewer",
				mode: "background",
				sessionMode: "lineage-only",
				parentClosePolicy: "terminate",
				async: true,
				model: "zai-messages/glm-5.2",
				modelRef: "zai-messages/glm-5.2:high",
				allowModelOverride: true,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5.2:max",
			{ getAvailable: () => [{ provider: "zai-messages", id: "glm-5.2", thinkingLevelMap: { max: "max" } }] },
		);

		assert.equal(overridden?.model, "zai-messages/glm-5.2");
		assert.equal(overridden?.thinking, "max");
		assert.equal(overridden?.modelRef, "zai-messages/glm-5.2:max");
	});

	it("clears stale thinking when resume override drops unsupported inherited thinking", async () => {
		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "scout",
				mode: "background",
				sessionMode: "fork",
				parentClosePolicy: "terminate",
				async: true,
				model: "zai-messages/glm-5.1",
				thinking: "high",
				modelRef: "zai-messages/glm-5.1",
				allowModelOverride: true,
				modelSource: "resume-override",
				requestedModelOverride: "zai-messages/glm-5.1",
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5-turbo",
			{
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5.1", thinkingLevelMap: { high: "high" } },
					{ provider: "zai-messages", id: "glm-5-turbo", thinkingLevelMap: { high: null } },
				],
			},
		);

		assert.equal(overridden?.model, "zai-messages/glm-5-turbo");
		assert.equal(overridden?.thinking, undefined);
		assert.equal(overridden?.modelRef, "zai-messages/glm-5-turbo");
		assert.deepEqual(await getPersistedSessionParityArgsForTest(overridden), [
			"--model",
			"zai-messages/glm-5-turbo",
			"--no-approve",
		]);
	});

	it("applies explicit resume thinking override when model string omits thinking", async () => {
		const overridden = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "scout",
				mode: "background",
				sessionMode: "fork",
				parentClosePolicy: "terminate",
				async: true,
				model: "openai-rift/gpt-5.4-mini",
				thinking: "high",
				modelRef: "openai-rift/gpt-5.4-mini:high",
				allowModelOverride: true,
				modelSource: "agent",
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5-turbo",
			{
				getAvailable: () => [
					{ provider: "zai-messages", id: "glm-5-turbo", thinkingLevelMap: { medium: "medium" } },
				],
			},
			"off",
		);

		assert.equal(overridden?.modelRef, "zai-messages/glm-5-turbo:off");
		assert.equal(overridden?.thinking, "off");
		assert.equal(overridden?.requestedThinkingOverride, "off");
		assert.deepEqual(await getPersistedSessionParityArgsForTest(overridden), [
			"--model",
			"zai-messages/glm-5-turbo:off",
			"--no-approve",
		]);
	});

	it("records ignored model and thinking overrides separately", () => {
		const metadata = resolveResumeLaunchMetadataForInvocationForTest(
			{
				version: 1,
				timestamp: "2026-05-08T00:00:00.000Z",
				name: "scout",
				mode: "background",
				sessionMode: "lineage-only",
				parentClosePolicy: "terminate",
				async: true,
				model: "zai-messages/glm-5.1",
				modelRef: "zai-messages/glm-5.1",
				allowModelOverride: false,
				denyTools: [],
				noContextFiles: false,
				noSession: false,
				agentConfigDir: "/tmp",
				cwd: "/tmp",
				boundarySystemPrompt: true,
			},
			"zai-messages/glm-5-turbo",
			undefined,
			"off",
		);

		assert.equal(metadata?.modelRef, "zai-messages/glm-5.1");
		assert.equal(metadata?.ignoredModelOverride, "zai-messages/glm-5-turbo");
		assert.equal(metadata?.ignoredThinkingOverride, "off");
	});

	it("rejects thinking-only resume overrides without a persisted model", () => {
		assert.throws(
			() => resolveResumeLaunchMetadataForInvocationForTest(
				{
					version: 1,
					timestamp: "2026-05-08T00:00:00.000Z",
					name: "legacy",
					mode: "background",
					sessionMode: "lineage-only",
					parentClosePolicy: "terminate",
					async: true,
					allowModelOverride: true,
					denyTools: [],
					noContextFiles: false,
					noSession: false,
					agentConfigDir: "/tmp",
					cwd: "/tmp",
					boundarySystemPrompt: true,
				},
				undefined,
				undefined,
				"off",
			),
			/Cannot apply thinking override without a persisted model/,
		);
	});

	it("validates model override names and drops unsupported inherited thinking", () => {
		assert.deepEqual(
			resolveAvailableModelRefForTest("glm-5.1", "low", false, "zai-messages/glm-5-turbo"),
			{ model: "zai-messages/glm-5.1", thinking: "low" },
		);

		assert.throws(
			() => resolveAvailableModelRefForTest("zai-messages/glm-5-turbo", "high", true),
			/does not support thinking level 'high'/,
		);
		assert.throws(
			() => resolveAvailableModelRefForTest("missing-model", undefined, false),
			/Unknown model override 'missing-model'/,
		);
	});
});
