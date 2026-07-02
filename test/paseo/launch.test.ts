import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	writeFileSync,
} from "../support/index.ts";
import { launchPaseoSubagent } from "../../src/paseo/launch.ts";
import {
	setPaseoClientFactoryForTest,
	type PaseoClient,
	type PaseoCreateAgentOptions,
} from "../../src/paseo/client.ts";

function writeAgent(cwd: string, name: string, lines: string[]): void {
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "agents", `${name}.md`), lines.join("\n"));
}

function launchContext(cwd: string) {
	const parentSession = join(cwd, "parent.jsonl");
	writeFileSync(parentSession, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
	return {
		cwd,
		sessionManager: {
			getSessionFile: () => parentSession,
			getSessionId: () => "parent-session",
			getLeafId: () => null,
		},
	};
}

function fakeClient(calls: { create: PaseoCreateAgentOptions[]; send?: Array<{ agentId: string; text: string; messageId?: string }> }): PaseoClient {
	return {
		async createAgent(options) {
			calls.create.push(options);
			return {
				id: "child-agent-1",
				cwd: options.config.cwd,
				workspaceId: options.workspaceId,
				status: "running",
			};
		},
		async sendAgentMessage(agentId, text, options) {
			calls.send?.push({ agentId, text, messageId: options?.messageId });
		},
		async fetchAgent(agentId) {
			return {
				agent: {
					id: agentId,
					cwd: "/workspace",
					workspaceId: "workspace-1",
					status: "running",
				},
			};
		},
		async waitForFinish() {
			throw new Error("not used");
		},
		async fetchAgentTimeline() {
			throw new Error("not used");
		},
		async cancelAgent() {},
		async close() {},
	};
}

describe("Paseo subagent launch", () => {
	afterEach(() => {
		setPaseoClientFactoryForTest(null);
	});

	it("creates a labeled Paseo Pi agent from supported frontmatter", async () => {
		const cwd = createTestDir();
		writeAgent(cwd, "paseo-worker", [
			"---",
			"name: paseo-worker",
			"model: provider/model",
			"thinking: high",
			"auto-exit: true",
			"system-prompt: append",
			"env: |",
			"  PASEO_CHILD=1",
			"---",
			"You are the Paseo worker identity.",
		]);
		const calls = { create: [] as PaseoCreateAgentOptions[], send: [] as Array<{ agentId: string; text: string; messageId?: string }> };
		setPaseoClientFactoryForTest(async () => fakeClient(calls));

		const running = await launchPaseoSubagent(
			{
				name: "paseo-worker",
				title: "Paseo worker",
				task: "Inspect the backend plan.",
				agent: "paseo-worker",
				systemPrompt: "Focus on backend constraints.",
			},
			launchContext(cwd),
			{ getContextWindow: () => 128000 },
			{
				kind: "paseo",
				preference: "unset",
				strictPaseo: true,
				fallbackLocalOnUnavailable: false,
				parentAgentId: "parent-agent-1",
				reason: "test",
			},
		);

		assert.equal(running.backend, "paseo");
		assert.equal(running.paseoAgentId, "child-agent-1");
		assert.equal(running.paseoWorkspaceId, "workspace-1");
		assert.equal(running.noSession, true);
		assert.equal(running.mode, "background");
		assert.equal(calls.create.length, 1);

		const created = calls.create[0]!;
		assert.equal(created.workspaceId, "workspace-1");
		assert.equal(created.config.provider, "pi");
		assert.equal(created.config.cwd, cwd);
		assert.equal(created.config.title, "Paseo worker");
		assert.equal(created.config.model, "provider/model");
		assert.equal(created.config.thinkingOptionId, "high");
		assert.match(String(created.config.systemPrompt), /Paseo worker identity/);
		assert.match(String(created.config.systemPrompt), /backend constraints/);
		assert.equal(created.initialPrompt, undefined);
		assert.equal(calls.send.length, 1);
		assert.equal(calls.send[0]?.agentId, "child-agent-1");
		assert.match(calls.send[0]?.messageId ?? "", /^pi-subagents-[a-f0-9]{8}-initial$/);
		assert.match(calls.send[0]?.text ?? "", /Paseo-managed pi-subagents child/);
		assert.match(calls.send[0]?.text ?? "", /Inspect the backend plan/);
		assert.equal(created.env?.PASEO_CHILD, "1");
		assert.equal(created.env?.PI_SUBAGENT_BACKEND, "paseo");
		assert.equal(created.env?.PI_SUBAGENT_NAME, "paseo-worker");
		assert.equal(created.env?.PI_SUBAGENT_AGENT, "paseo-worker");
		assert.equal(created.env?.PI_SUBAGENT_PARENT_PASEO_AGENT_ID, "parent-agent-1");
		assert.equal(created.env?.PI_DENY_TOOLS, undefined);
		assert.equal(created.labels?.["paseo.parent-agent-id"], "parent-agent-1");
		assert.equal(created.labels?.["pi-subagents.name"], "paseo-worker");
		assert.equal(created.labels?.["pi-subagents.agent"], "paseo-worker");
	});

	for (const [frontmatter, expected] of [
		["session-mode: fork", /session-mode: fork/],
		["tools: read", /tools/],
		["deny-tools: bash", /deny-tools/],
		["skills: none", /skills: none/],
		["extensions: none", /extensions/],
		["system-prompt: replace", /system-prompt: replace/],
	] as const) {
		it(`rejects unsupported Paseo parity feature ${frontmatter}`, async () => {
			const cwd = createTestDir();
			writeAgent(cwd, "strict-worker", [
				"---",
				"name: strict-worker",
				frontmatter,
				"---",
				"Strict worker.",
			]);
			setPaseoClientFactoryForTest(async () => fakeClient({ create: [] }));

			await assert.rejects(
				() =>
					launchPaseoSubagent(
						{
							name: "strict-worker",
							title: "Strict worker",
							task: "Do work.",
							agent: "strict-worker",
						},
						launchContext(cwd),
						{ getContextWindow: () => undefined },
						{
							kind: "paseo",
							preference: "unset",
							strictPaseo: true,
							fallbackLocalOnUnavailable: false,
							parentAgentId: "parent-agent-1",
							reason: "test",
						},
					),
				expected,
			);
		});
	}
});
