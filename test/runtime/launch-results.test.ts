import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	subagentsExtension,
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	markSubagentBatchBlockingForTest,
	getAgentListSignatureForTest,
	renderAgentListReminderForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	waitForSubagentForTest,
	createTestDir,
} from "../support/index.ts";

describe("subagent launch result delivery", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("marks async detached launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-terminate.jsonl",
		};

		const result = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		assert.equal((result.details as any).status, "started");
		assert.equal(result.terminate, true);
	});

	it("does not terminate async launch results when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const running = {
			id: "child-no-terminate-opt-out",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-terminate-opt-out.jsonl",
		};

		const result = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		assert.equal((result.details as any).status, "started");
		assert.equal((result.details as any).async, true);
		assert.equal(result.terminate, undefined);
	});

	it("does not terminate awaited launch results even after an async launch requested a coordinator-only turn", async () => {
		const asyncRunning = {
			id: "child-async-first",
			name: "Async child",
			task: "Do async work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-async-first.jsonl",
		};

		const asyncResult = (await getLaunchedSubagentResultForTest(
			asyncRunning as any,
		)) as any;
		assert.equal(asyncResult.terminate, true);

		const awaitedRunning = {
			id: "child-awaited-second",
			name: "Awaited child",
			task: "Finish before returning",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-awaited-second.jsonl",
			completionPromise: Promise.resolve({
				name: "Awaited child",
				task: "Finish before returning",
				summary: "done",
				sessionFile: "/tmp/child-awaited-second.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(awaitedRunning as any);
		const awaitedResult = (await getLaunchedSubagentResultForTest(
			awaitedRunning as any,
		)) as any;
		assert.equal((awaitedResult.details as any).deliveryState, "awaited");
		assert.equal(awaitedResult.terminate, undefined);
	});

	it("does not defer same-turn detached async completion when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-no-defer-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-defer-opt-out.jsonl",
		};

		setRunningSubagentForTest(running as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running as any,
			{
				name: running.name,
				task: running.task,
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, undefined);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "steer");
	});

	it("defers same-turn detached async completion delivery until the next user turn", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-deferred-steer",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-deferred-steer.jsonl",
		};

		setRunningSubagentForTest(running as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running as any,
			{
				name: running.name,
				task: running.task,
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, true);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "nextTurn");
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"steer",
		);
	});

	it("awaits async children when the current subagent batch has a sync child", async () => {
		markSubagentBatchBlockingForTest();
		const asyncRunning = {
			id: "child-mixed-async-awaited",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
			completionPromise: Promise.resolve({
				name: "Async child",
				task: "Start work",
				summary: "Async done",
				sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			asyncRunning as any,
		)) as any;
		assert.equal((asyncResult.details as any).status, "completed");
		assert.equal((asyncResult.details as any).deliveryState, "awaited");
		assert.equal((asyncResult.details as any).async, true);
		assert.equal(asyncResult.terminate, undefined);
		assert.equal(
			getCompletedSubagentResultForTest(asyncRunning.id)?.deliveredTo,
			"wait",
		);
	});

	it("does not mark mixed async and sync launch results as terminating when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const asyncRunning = {
			id: "child-mixed-async-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-opt-out.jsonl",
		};
		const syncRunning = {
			id: "child-mixed-sync-opt-out",
			name: "Sync child",
			task: "Gate work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
			completionPromise: Promise.resolve({
				name: "Sync child",
				task: "Gate work",
				summary: "Done",
				sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning as any);
		setRunningSubagentForTest(syncRunning as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			asyncRunning as any,
		)) as any;
		const syncResult = (await getLaunchedSubagentResultForTest(
			syncRunning as any,
		)) as any;
		assert.equal(asyncResult.terminate, undefined);
		assert.equal((syncResult.details as any).status, "completed");
		assert.equal(syncResult.terminate, undefined);
	});

	it("does not mark sync launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-sync-no-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-sync-no-terminate.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-sync-no-terminate.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running as any);
		const result = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		assert.equal((result.details as any).status, "completed");
		assert.equal(result.terminate, undefined);
	});

	it("keeps parent tools available after waiting for detached children", async () => {
		const running = {
			id: "child-guard",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-guard.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-guard.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running);
		const waited = await waitForSubagentForTest({ id: "Child" });
		assert.equal((waited.details as any).status, "completed");
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"wait",
		);
	});

	it("injects one hidden startup catalog for top-level actionable sessions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const handlers = new Map<string, any>();
		subagentsExtension({
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
		} as any);

		handlers.get("session_start")(
			{ type: "session_start", reason: "startup" },
			{
				cwd: dir,
				hasUI: false,
				ui: { setWidget() {} },
				sessionManager: {
					getHeader: () => ({
						id: "root",
						type: "session",
						timestamp: "",
						cwd: dir,
					}),
				},
			},
		);

		const result = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "sys",
		});
		const message = result?.message;
		assert.ok(message);
		assert.equal(message.customType, "subagent_roster");
		assert.equal(message.display, false);
		assert.equal((message.details as any).entries[0].name, "reviewer");
		assert.equal(
			(message.details as any).signature,
			getAgentListSignatureForTest((message.details as any).entries),
		);
		assert.match(message.content, /^<system-reminder>\nYou can launch separate helper agents/);
		assert.match(
			message.content,
			/`reviewer`: Review changes for regressions[\s\S]*?tool_return: later_message/m,
		);
		assert.match(message.content, /\n<\/subagent-roster>\n<subagent-rules>\n/);
		assert.match(
			message.content,
			/tool_return=later_message means the tool call starts the helper and returns before the work is done; do not invent its findings/,
		);
		assert.match(
			message.content,
			/context=fresh_chat_needs_full_brief means write a self-contained task with objective, files, constraints, and expected output/,
		);
		assert.match(
			message.content,
			/context=copy_of_this_chat means the helper starts from this conversation/,
		);
		assert.match(message.content, /\n<\/subagent-rules>\n<\/system-reminder>$/);
		assert.equal(
			renderAgentListReminderForTest((message.details as any).entries),
			message.content,
		);
		assert.equal(
			handlers.get("before_agent_start")({
				type: "before_agent_start",
				prompt: "again",
				systemPrompt: "sys",
			}),
			undefined,
		);
	});

	it("queues reload catalog changes for the next turn instead of interrupting immediately", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\n---\n\nReviewer body.`,
		);

		const handlers = new Map<string, any>();
		const ctx = {
			cwd: dir,
			hasUI: false,
			ui: { setWidget() {} },
			sessionManager: {
				getHeader: () => ({
					id: "root",
					type: "session",
					timestamp: "",
					cwd: dir,
				}),
			},
		};

		subagentsExtension({
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
		} as any);

		handlers.get("session_start")(
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const startup = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "start",
			systemPrompt: "sys",
		});
		assert.ok(startup?.message);
		assert.equal((startup.message.details as any).supersedes, undefined);

		writeFileSync(
			join(agentsDir, "researcher.md"),
			`---\nname: researcher\ndescription: Investigate open-ended questions\nmode: background\n---\n\nResearcher body.`,
		);

		handlers.get("session_start")(
			{ type: "session_start", reason: "reload" },
			ctx,
		);
		const reloaded = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "sys",
		});
		assert.ok(reloaded?.message);
		assert.equal((reloaded.message.details as any).supersedes, true);
		assert.match(
			reloaded.message.content,
			/`researcher`: Investigate open-ended questions[\s\S]*?tool_return: later_message[\s\S]*?runs_as: hidden_process[\s\S]*?context: fresh_chat_needs_full_brief[\s\S]*?completion: exits_automatically/,
		);

		handlers.get("session_start")(
			{ type: "session_start", reason: "reload" },
			ctx,
		);
		assert.equal(
			handlers.get("before_agent_start")({
				type: "before_agent_start",
				prompt: "continue again",
				systemPrompt: "sys",
			}),
			undefined,
		);
	});

});
