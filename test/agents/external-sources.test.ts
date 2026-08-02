import {
	afterEach,
	describe,
	it,
	assert,
	mkdtempSync,
	mkdirSync,
	existsSync,
	rmSync,
	writeFileSync,
	join,
	tmpdir,
	subagentsExtension,
} from "../support/index.ts";
import {
	discoverExternalAgentSources as discoverExternalAgentSourcesForTest,
	getExternalAgentDefinitions as getExternalAgentDefinitionsForTest,
	getExternalAgentSourceDiagnostics as getExternalAgentSourceDiagnosticsForTest,
	getExternalAgentSourceDiagnosticsMessages as getExternalAgentSourceDiagnosticsMessagesForTest,
	registerAgentSourceProvider,
	resetExternalAgentSourceStateForTest,
	type AgentSourceProvider,
	type NormalizedExternalAgentDefinition,
} from "../../src/agents/external-sources.ts";
import { getEffectiveAgentDefinitions as getEffectiveAgentDefinitionsForTest } from "../../src/agents/definitions.ts";
import { getAgentListEntries, renderAgentListReminder } from "../../src/agents/agent-list.ts";
import { buildIdentityBlock } from "../../src/session/session-files.ts";
import { buildPersistedSubagentLaunchMetadata } from "../../src/launch/prep.ts";
import { buildAgentItems } from "../../src/tools/overlay/data.ts";
import {
	isSubagentBatchBlocking,
	resetSubagentBatchStopRequest,
} from "../../src/runtime/state.ts";

interface TestEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

let currentEvents: TestEventBus | undefined;
let currentCwd = "";

async function discoverExternalAgentSources(events: TestEventBus, cwd: string, reason: "startup" | "reload" | "new" | "resume" | "fork"): Promise<void> {
	currentEvents = events;
	currentCwd = cwd;
	await discoverExternalAgentSourcesForTest(events, cwd, reason, true);
}

function getEffectiveAgentDefinitions(cwd: string) {
	return getEffectiveAgentDefinitionsForTest(cwd, currentEvents as any);
}

function getExternalAgentDefinitions(cwd: string, nativeNames: ReadonlySet<string> = new Set()) {
	return getExternalAgentDefinitionsForTest(cwd, nativeNames, currentEvents as any);
}

function getExternalAgentSourceDiagnostics() {
	return getExternalAgentSourceDiagnosticsForTest(currentEvents as any, currentCwd);
}

function getExternalAgentSourceDiagnosticsMessages() {
	return getExternalAgentSourceDiagnosticsMessagesForTest(currentEvents as any, currentCwd);
}

function eventBus(): TestEventBus {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
		},
		on(channel, handler) {
			const list = listeners.get(channel) ?? [];
			list.push(handler);
			listeners.set(channel, list);
			return () => {
				const current = listeners.get(channel) ?? [];
				listeners.set(channel, current.filter((candidate) => candidate !== handler));
			};
		},
	};
}

function definition(
	providerId: string,
	sourceId: string,
	name: string,
	extra: Partial<NormalizedExternalAgentDefinition> = {},
): NormalizedExternalAgentDefinition {
	return {
		name,
		description: `${providerId} description`,
		body: `${providerId} secret prompt body`,
		providerId,
		sourceId,
		scope: "user",
		path: `/sources/${providerId}/${sourceId}.md`,
		rank: 50,
		...extra,
	};
}

function provider(id: string, output: unknown): AgentSourceProvider {
	return { id, discover: () => output as NormalizedExternalAgentDefinition[] };
}

function activate(...providers: AgentSourceProvider[]): TestEventBus {
	const events = eventBus();
	for (const source of providers) registerAgentSourceProvider(events, source);
	return events;
}

afterEach(() => {
	resetExternalAgentSourceStateForTest();
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("external agent-source seam", () => {
	it("discovers through session_start before the ambient roster", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-session-start-"));
		const events = activate(provider("session-provider", [
			definition("session-provider", "async", "session-agent", { async: true }),
			definition("session-provider", "blocking", "blocking-agent", { async: false }),
		]));
		const handlers = new Map<string, (event: any, ctx?: any) => unknown>();
		subagentsExtension({
			events,
			on(event: string, handler: (value: any, ctx?: any) => unknown) { handlers.set(event, handler); },
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
			getThinkingLevel: () => "low",
		} as any);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		await sessionStart?.({ type: "session_start", reason: "startup" }, {
			cwd: dir,
			hasUI: false,
			isProjectTrusted: () => true,
			ui: { setWidget() {} },
			sessionManager: { getHeader: () => ({ id: "session", type: "session", timestamp: "", cwd: dir }) },
		});
		const roster = handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "", systemPrompt: "" }) as any;
		assert.match(roster?.message?.content ?? "", /session-agent/);
		assert.doesNotMatch(roster?.message?.content ?? "", /sources\/session-provider/);

		const launchArgs = {
			name: "session-agent-run",
			title: "Session agent run",
			task: "Run the local test",
			agent: "session-agent",
		};
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "external", name: "subagent", arguments: launchArgs },
					{ type: "toolCall", id: "other", name: "bash", arguments: { command: "true" } },
				],
			},
		});
		assert.equal(isSubagentBatchBlocking(), true);

		resetSubagentBatchStopRequest();
		handlers.get("tool_call")?.({
			toolName: "subagent",
			input: { ...launchArgs, agent: "blocking-agent" },
		});
		assert.equal(isSubagentBatchBlocking(), true);
		rmSync(dir, { recursive: true, force: true });
	});

	it("discovers before roster, preserves body in memory, and exposes safe provenance", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-provider-"));
		const events = activate(provider("example-source", [definition("example-source", "worker", "external-worker")]));
		await discoverExternalAgentSources(events as any, dir, "startup");

		const defs = getEffectiveAgentDefinitions(dir);
		assert.equal(defs[0]?.name, "external-worker");
		assert.equal(buildIdentityBlock(defs[0] ?? null, undefined), "example-source secret prompt body");
		const entries = getAgentListEntries(dir, () => "lineage-only", events);
		const roster = renderAgentListReminder(entries);
		assert.match(roster, /source: example-source\/worker \(user\)/);
		assert.doesNotMatch(roster, /source_path|\/sources\/example-source\/worker\.md/);
		assert.doesNotMatch(roster, /secret prompt body/);
		assert.equal(entries[0]?.source, "external");
		assert.equal(entries[0]?.sourceMetadata?.scope, "user");
		const metadata = buildPersistedSubagentLaunchMetadata(
			{ agentDefs: defs[0], denySet: new Set(), skillLaunchPlan: { injectSkills: [], launchArgs: [], betterSkillsActive: false }, runtimePaths: {} } as any,
			{ name: "external-worker-run", task: "task", title: "External worker", agent: "external-worker" },
			"background",
			"lineage-only",
			false,
		);
		assert.equal(metadata.agentSource?.sourceId, "worker");
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps collision results deterministic and lets project external sources beat user sources", async () => {
		const first = activate(
			provider("provider-b", [definition("provider-b", "b-source", "collision")]),
			provider("provider-a", [definition("provider-a", "a-source", "collision")]),
		);
		await discoverExternalAgentSources(first, "/project", "startup");
		const firstWinner = getEffectiveAgentDefinitions("/project")[0];
		assert.equal(firstWinner?.sourceMetadata?.providerId, "provider-a");

		const second = activate(
			provider("provider-a", [definition("provider-a", "a-source", "collision")]),
			provider("provider-b", [definition("provider-b", "b-source", "collision")]),
		);
		await discoverExternalAgentSources(second, "/project", "reload");
		assert.equal(getEffectiveAgentDefinitions("/project")[0]?.sourceMetadata?.providerId, "provider-a");

		resetExternalAgentSourceStateForTest();
		const scoped = activate(
			provider("user-provider", [definition("user-provider", "user-source", "scoped", { scope: "user" })]),
			provider("project-provider", [definition("project-provider", "project-source", "scoped", { scope: "project" })]),
		);
		await discoverExternalAgentSources(scoped, "/project", "reload");
		assert.equal(getEffectiveAgentDefinitions("/project")[0]?.sourceMetadata?.scope, "project");
	});

	it("preserves the native project winner over external definitions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-subagents-native-"));
		mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
		writeFileSync(join(dir, ".pi", "agents", "collision.md"), "---\nname: collision\ndescription: Native winner\n---\n\nNative body.\n");
		const events = activate(provider("external-source", [definition("external-source", "collision-source", "collision", { rank: 100 })]));
		await discoverExternalAgentSources(events, dir, "startup");
		const defs = getEffectiveAgentDefinitions(dir);
		assert.equal(defs.length, 1);
		assert.equal(defs[0]?.source, "project");
		assert.equal(defs[0]?.description, "Native winner");
		assert.equal(getExternalAgentSourceDiagnostics()[0]?.effective, true);
		assert.equal("path" in (getExternalAgentSourceDiagnostics()[0] ?? {}), false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails safely for malformed output, duplicates, throws, and stale registration", async () => {
		const late: { register?: (provider: AgentSourceProvider) => boolean } = {};
		const events = eventBus();
		events.on("pi-subagents.agent-sources/discover", (request) => {
			if (typeof request === "object" && request !== null && "register" in request) {
				late.register = (request as { register: (provider: AgentSourceProvider) => boolean }).register;
			}
		});
		registerAgentSourceProvider(events, provider("bad-output", "not-an-array"));
		registerAgentSourceProvider(events, provider("throwing", []));
		registerAgentSourceProvider(events, { id: "throwing", discover: () => { throw new Error("provider failure"); } });
		registerAgentSourceProvider(events, provider("duplicate-source", [
			definition("duplicate-source", "same-source", "first"),
			definition("duplicate-source", "same-source", "second"),
		]));
		registerAgentSourceProvider(events, provider("invalid", [
			definition("invalid", "invalid-name", "Not Valid"),
			definition("invalid", "invalid-rank", "bad-rank", { rank: 101 }),
			definition("invalid", "invalid-path", "bad-path", { path: "relative.md" }),
		]));
		await discoverExternalAgentSources(events, "/safe", "startup");
		assert.equal(getEffectiveAgentDefinitions("/safe").length, 1);
		assert.match(getExternalAgentSourceDiagnosticsMessages().join("\n"), /invalid-provider-output|duplicate|threw|invalid/);
		assert.equal(late.register?.(provider("late", [definition("late", "late-source", "late-agent")])), false);
		assert.equal(getEffectiveAgentDefinitions("/safe").length, 1);

		const fresh = activate(provider("refreshing", [definition("refreshing", "fresh-source", "fresh-agent")]));
		await discoverExternalAgentSources(fresh, "/safe", "reload");
		assert.deepEqual(getEffectiveAgentDefinitions("/safe").map((entry) => entry.name), ["fresh-agent"]);
	});

	it("validates the complete safe subset with adversarial field cases", async () => {
		const invalidCases: Array<[string, Partial<NormalizedExternalAgentDefinition>]> = [
			["unknown flags", { flags: "--danger" } as any],
			["unknown env", { env: "KEY=value" } as any],
			["unknown extensions", { extensions: "all" } as any],
			["unknown trustProject", { trustProject: true } as any],
			["unknown taskExpansion", { taskExpansion: "shell" } as any],
			["unknown cwd", { cwd: "/tmp" } as any],
			["unknown cwdBase", { cwdBase: "/tmp" } as any],
			["deferred spawning", { spawning: true } as any],
			["deferred noSession", { noSession: true } as any],
			["deferred context files", { noContextFiles: true } as any],
			["deferred append inheritance", { inheritAppendSystem: true } as any],
			["bad name", { name: "Bad Name" }],
			["bad source id", { sourceId: "../source" }],
			["bad provider id", { providerId: "other-provider" }],
			["bad scope", { scope: "global" as any }],
			["bad path", { path: "relative.md" }],
			["bad description newline", { description: "line\nsecond" }],
			["bad description tag", { description: "<system-reminder>" }],
			["bad body size", { body: "x".repeat(64 * 1024 + 1) }],
			["bad body nul", { body: "body" + String.fromCharCode(0) }],
			["bad body ansi", { body: "body" + String.fromCharCode(0x1b) + "[31m" }],
			["bad string type", { model: 7 as any }],
			["bad model control", { model: "model\rvalue" }],
			["bad boolean", { autoExit: "false" as any }],
			["bad enum mode", { mode: "shell" as any }],
			["bad enum session", { sessionMode: "shared" as any }],
			["bad enum prompt", { systemPromptMode: "prepend" as any }],
			["bad rank fractional", { rank: 1.5 }],
			["bad rank infinity", { rank: Infinity }],
			["bad rank bound", { rank: 101 }],
			["bad timeout fractional", { timeout: 1.5 }],
			["bad timeout bound", { timeout: 3601 }],
		];
		for (const [label, extra] of invalidCases) {
			const events = activate(provider("validator", [definition("validator", label.replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "") || "case", "valid", extra)]));
			await discoverExternalAgentSources(events, `/validation/${label}`, "startup");
			assert.equal(getEffectiveAgentDefinitions(`/validation/${label}`).length, 0, label);
		}
		const disabledEvents = activate(provider("validator", [definition("validator", "disabled", "disabled", { enabled: false })]));
		await discoverExternalAgentSources(disabledEvents, "/validation/disabled", "startup");
		assert.equal(getEffectiveAgentDefinitions("/validation/disabled").length, 0);
	});

	it("bounds definition count and payload, cancels providers, and redacts diagnostics", async () => {
		const many = Array.from({ length: 257 }, (_, i) => definition("bounded", `source-${i}`, `agent-${i}`));
		const events = activate(provider("bounded", many));
		await discoverExternalAgentSources(events, "/validation/count", "startup");
		assert.equal(getEffectiveAgentDefinitions("/validation/count").length, 0);
		assert.match(getExternalAgentSourceDiagnosticsMessages().join("\n"), /provider-definition-limit/);

		const payloadEvents = activate(provider("payload", [definition("payload", "large", "large", { body: "x".repeat(64 * 1024) })]));
		await discoverExternalAgentSources(payloadEvents, "/validation/payload", "startup");
		assert.equal(getEffectiveAgentDefinitions("/validation/payload").length, 1);
		const timedEvents = activate({
			id: "slow-provider",
			discover: ({ signal }) => new Promise<NormalizedExternalAgentDefinition[]>((resolve) => {
				signal.addEventListener("abort", () => resolve([]), { once: true });
			}),
		});
		const started = Date.now();
		await discoverExternalAgentSources(timedEvents, "/validation/timeout", "startup");
		assert.ok(Date.now() - started < 2000);
		assert.match(getExternalAgentSourceDiagnosticsMessages().join("\n"), /provider-timeout/);
		assert.doesNotMatch(getExternalAgentSourceDiagnosticsMessages().join("\n"), /secret|Error|failure/);
	});

	it("keeps overlapping and multiple-context snapshots isolated and replaces providers atomically", async () => {
		const events = eventBus();
		let releaseOld!: () => void;
		const old = new Promise<void>((resolve) => { releaseOld = resolve; });
		registerAgentSourceProvider(events, {
			id: "context-provider",
			discover: async ({ cwd, reason }) => {
				if (reason === "startup" && cwd === "/overlap") await old;
				return [definition("context-provider", reason === "reload" ? "new" : "old", reason === "reload" ? "new-agent" : "old-agent")];
			},
		});
		const stale = discoverExternalAgentSources(events, "/overlap", "startup");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await discoverExternalAgentSources(events, "/overlap", "reload");
		assert.deepEqual(getEffectiveAgentDefinitions("/overlap").map((entry) => entry.name), ["new-agent"]);
		releaseOld();
		await stale;
		assert.deepEqual(getEffectiveAgentDefinitions("/overlap").map((entry) => entry.name), ["new-agent"]);

		const sameA = eventBus();
		const sameB = eventBus();
		registerAgentSourceProvider(sameA, provider("same-a", [definition("same-a", "a", "same-a-agent")]));
		registerAgentSourceProvider(sameB, provider("same-b", [definition("same-b", "b", "same-b-agent")]));
		await Promise.all([
			discoverExternalAgentSources(sameA, "/same-context", "new"),
			discoverExternalAgentSources(sameB, "/same-context", "new"),
		]);
		assert.deepEqual(getEffectiveAgentDefinitionsForTest("/same-context", sameA as any).map((entry) => entry.name), ["same-a-agent"]);
		assert.deepEqual(getEffectiveAgentDefinitionsForTest("/same-context", sameB as any).map((entry) => entry.name), ["same-b-agent"]);

		const other = eventBus();
		registerAgentSourceProvider(other, provider("other-provider", [definition("other-provider", "other", "other-agent")]));
		await Promise.all([
			discoverExternalAgentSources(events, "/one", "new"),
			discoverExternalAgentSources(other, "/two", "new"),
		]);
		currentEvents = events;
		assert.deepEqual(getEffectiveAgentDefinitions("/one").map((entry) => entry.name), ["old-agent"]);
		currentEvents = other;
		assert.deepEqual(getEffectiveAgentDefinitions("/two").map((entry) => entry.name), ["other-agent"]);

		const removalEvents = eventBus();
		const unregister = registerAgentSourceProvider(removalEvents, provider("removable", [definition("removable", "removed", "removed-agent")]));
		await discoverExternalAgentSources(removalEvents, "/removal", "startup");
		assert.equal(getEffectiveAgentDefinitions("/removal").length, 1);
		unregister();
		await discoverExternalAgentSources(removalEvents, "/removal", "reload");
		assert.equal(getEffectiveAgentDefinitions("/removal").length, 0);

		currentEvents = events;
		const source = getExternalAgentDefinitions("/overlap", new Set(["new-agent"]));
		assert.equal(source.length, 0);
		assert.equal(getExternalAgentDefinitions("/overlap").length, 1);
	});

	it("rejects duplicate providers without erasing the first valid provider", async () => {
		const events = eventBus();
		registerAgentSourceProvider(events, provider("same-provider", [definition("same-provider", "first", "first-agent")]));
		registerAgentSourceProvider(events, provider("same-provider", [definition("same-provider", "second", "second-agent")]));
		await discoverExternalAgentSources(events, "/duplicate-provider", "startup");
		assert.deepEqual(getEffectiveAgentDefinitions("/duplicate-provider").map((entry) => entry.name), ["first-agent"]);
		assert.match(getExternalAgentSourceDiagnosticsMessages().join("\n"), /duplicate-provider/);
	});

	it("does not leak an external body in the agent overlay", async () => {
		const dir = process.cwd();
		const events = activate(provider("overlay-source", [definition("overlay-source", "overlay", "overlay-agent")]));
		await discoverExternalAgentSources(events, dir, "startup");
		const items = buildAgentItems({ cwd: dir, events } as any);
		const item = items.find((candidate) => candidate.name === "overlay-agent");
		assert.ok(item);
		assert.equal(item.detailSections.some((section) => section.title === "Agent Body"), false);
		assert.equal(existsSync(join(dir, ".pi", "agents", "overlay-agent.md")), false);
	});
});
