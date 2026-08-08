import {
	ASSISTANT_MSG,
	afterEach,
	assert,
	createForkSessionFileForTest,
	createTestDir,
	describe,
	existsSync,
	findLastAssistantMessage,
	getCompletedSubagentResultForTest,
	getEntries,
	getLaunchedSubagentResultForTest,
	getStartedSubagentDetailsForTest,
	getTerminalAssistantSummaryAfterLaunchForTest,
	getTerminalAssistantSummaryForTest,
	isMissingOptionalDependencyForTest,
	it,
	join,
	MODEL_CHANGE,
	markSubagentBatchBlockingForTest,
	renderSubagentWidgetForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	SESSION_HEADER,
	seedSubagentSessionFileForTest,
	setRunningSubagentForTest,
	USER_MSG,
	waitForSubagentForTest,
	writeFileSync,
} from "../support/index.ts";

describe("fork session launch behavior", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("forks only the active parent branch", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		const header = {
			...SESSION_HEADER,
			cwd: dir,
			timestamp: "2026-05-08T00:00:00.000Z",
		};
		const root = {
			type: "message",
			id: "root-user",
			parentId: null,
			timestamp: "2026-05-08T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "root" }] },
		};
		const main = {
			type: "message",
			id: "main-assistant",
			parentId: "root-user",
			timestamp: "2026-05-08T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "main" }] },
		};
		const abandoned = {
			type: "message",
			id: "abandoned-assistant",
			parentId: "root-user",
			timestamp: "2026-05-08T00:00:03.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "abandoned" }],
			},
		};
		writeFileSync(parent, `${[header, root, main, abandoned].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		seedSubagentSessionFileForTest("fork", parent, child, dir, {
			activeLeafId: "main-assistant",
		});

		assert.equal(existsSync(child), true);
		const entries = getEntries(child) as any[];
		assert.deepEqual(
			entries.filter((entry) => entry.type === "message").map((entry) => entry.id),
			["root-user", "main-assistant"],
		);
		assert.equal(JSON.stringify(entries).includes("abandoned"), false);
	});

	it("does not treat fork seed assistant messages as child completion output", () => {
		const oldSummary = "old Discord announcement";
		const newSummary = "new research answer";
		const seededEntries = [
			{ type: "session" },
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: oldSummary }],
				},
			},
			{
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "actual delegated child task" }],
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: newSummary }],
				},
			},
		] as any[];

		assert.equal(getTerminalAssistantSummaryAfterLaunchForTest(seededEntries, 2), newSummary);
		assert.equal(findLastAssistantMessage(seededEntries.slice(2)), newSummary);
		assert.equal(getTerminalAssistantSummaryAfterLaunchForTest(seededEntries, seededEntries.length), null);
		assert.equal(getTerminalAssistantSummaryForTest(seededEntries.slice(0, 2)), oldSummary);
	});

	it("keeps the inherited fork branch fully walkable when entries are dropped", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		const header = {
			...SESSION_HEADER,
			cwd: dir,
			timestamp: "2026-08-07T20:00:00.000Z",
		};
		const entries = [
			header,
			{
				type: "message",
				id: "user-001",
				parentId: null,
				timestamp: "2026-08-07T20:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "root" }] },
			},
			{
				type: "message",
				id: "asst-001",
				parentId: "user-001",
				timestamp: "2026-08-07T20:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "subagent_131", name: "subagent", arguments: { agent: "x" } }],
				},
			},
			{
				type: "message",
				id: "asst-002",
				parentId: "asst-001",
				timestamp: "2026-08-07T20:00:03.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "subagent_kill_70", name: "subagent_kill", arguments: { id: "x" } }],
				},
			},
			{
				type: "message",
				id: "tool-001",
				parentId: "asst-002",
				timestamp: "2026-08-07T20:00:04.000Z",
				message: { role: "toolResult", toolCallId: "subagent_kill_70", content: [{ type: "text", text: "ok" }] },
			},
			{
				type: "message",
				id: "asst-003",
				parentId: "tool-001",
				timestamp: "2026-08-07T20:00:05.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "spawning the reviewer now" }],
				},
			},
			{
				type: "message",
				id: "asst-004",
				parentId: "asst-003",
				timestamp: "2026-08-07T20:00:06.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "final answer" },
						{ type: "toolCall", id: "subagent_137", name: "subagent", arguments: { agent: "reviewer" } },
					],
				},
			},
			{
				type: "message",
				id: "asst-005",
				parentId: "asst-004",
				timestamp: "2026-08-07T20:00:07.000Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "delegated child task" }],
				},
			},
			{
				type: "custom_message",
				id: "roster-001",
				parentId: "asst-005",
				timestamp: "2026-08-07T20:00:08.000Z",
				customType: "subagent_roster",
				content: "Sub-agents: bob, alice",
			},
			{
				type: "message",
				id: "asst-006",
				parentId: "roster-001",
				timestamp: "2026-08-07T20:00:09.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "spawning opus" }] },
			},
		];
		writeFileSync(parent, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		seedSubagentSessionFileForTest("fork", parent, child, dir, {
			activeLeafId: "asst-006",
		});

		const seeded = getEntries(child) as any[];
		const messages = seeded.filter((entry) => entry.type === "message");
		assert.deepEqual(
			messages.map((entry) => entry.id),
			["user-001", "asst-001", "asst-002", "tool-001", "asst-003", "asst-004", "asst-005", "asst-006"],
		);
		// Roster entries are dropped from the inherited context, and orphaned
		// tool calls are preserved verbatim: pi-ai's transformMessages synthesizes
		// a "No result provided" toolResult for them at the provider boundary.
		assert.equal(JSON.stringify(seeded).includes("subagent_131"), true);
		assert.equal(JSON.stringify(seeded).includes("subagent_137"), true);
		assert.equal(JSON.stringify(seeded).includes("subagent_kill_70"), true);
		assert.equal(JSON.stringify(seeded).includes("roster-001"), false);

		// The full parentId chain must be walkable from the last seeded entry:
		// dropping an entry must re-link its successor, or the child's inherited
		// context silently truncates at the stale link.
		const byId = new Map(messages.map((entry: any) => [entry.id, entry]));
		const visited: string[] = [];
		let cursor: any = messages[messages.length - 1];
		while (cursor) {
			visited.push(cursor.id);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		assert.deepEqual(
			visited,
			["asst-006", "asst-005", "asst-004", "asst-003", "tool-001", "asst-002", "asst-001", "user-001"],
		);
	});

	it("creates forked child session files directly", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		const triggerUser = {
			type: "message",
			id: "user-trigger",
			parentId: "asst-001",
			message: {
				role: "user",
				content: [{ type: "text", text: "Use subagent to fork this session" }],
			},
		};
		writeFileSync(
			parent,
			`${[SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG, triggerUser]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		createForkSessionFileForTest(parent, child);
		const entries = getEntries(child) as any[];

		assert.equal(entries[0].type, "session");
		assert.equal(entries[0].parentSession, parent);
		assert.equal(entries.at(-1)?.id, "asst-001");
		assert.ok(!JSON.stringify(entries).includes("Use subagent to fork this session"));
	});

	it("returns detached launch metadata and defers same-batch completion once", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-123",
			name: "Detached child",
			task: "Do the work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-session.jsonl",
		};

		const launched = (await getLaunchedSubagentResultForTest(running)) as any;
		assert.match(launched.content[0].text, /child-123/);
		assert.match(launched.content[0].text, /resume or stop/);

		const started = getStartedSubagentDetailsForTest(running);
		assert.equal(started.status, "started");
		assert.equal(started.mode, "background");
		assert.equal(started.deliveryState, "detached");
		assert.equal(started.parentClosePolicy, "terminate");

		const cached = routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running,
			{
				name: running.name,
				task: running.task,
				summary: "Detached completion summary",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "nextTurn");
		assert.equal((sent[0].message.details as any).id, running.id);
		assert.equal((sent[0].message.details as any).deliveryState, "detached");
		assert.equal((sent[0].message.details as any).parentClosePolicy, "terminate");
		assert.equal((sent[0].message.details as any).status, "completed");

		assert.equal(cached.deliveredTo, "steer");
		assert.equal(cached.deliveryState, "detached");
		assert.equal(cached.parentClosePolicy, "terminate");
		assert.equal(cached.status, "completed");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "steer");
	});

	it("recognizes optional dependency resolution failures from node and bun-style errors", () => {
		assert.equal(
			isMissingOptionalDependencyForTest(
				Object.assign(new Error("Cannot find module '@earendil-works/pi-tui' from '/tmp/ext.ts'"), {
					code: "MODULE_NOT_FOUND",
				}),
				"@earendil-works/pi-tui",
			),
			true,
		);
		assert.equal(
			isMissingOptionalDependencyForTest(
				{
					message: "Cannot find module '@earendil-works/pi-tui' from '/tmp/ext.ts'",
				},
				"@earendil-works/pi-tui",
			),
			true,
		);
		assert.equal(
			isMissingOptionalDependencyForTest(
				{ message: "Cannot find package 'typebox' imported from /tmp/ext.ts" },
				"typebox",
			),
			true,
		);
	});

	it("returns an awaited result immediately when launched as blocking", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		let resolveCompletion!: (result: any) => void;
		const completionPromise = new Promise<any>((resolve) => {
			resolveCompletion = resolve;
		});
		const running = {
			id: "child-blocking-1",
			name: "Blocking child",
			task: "Finish before returning",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-blocking-1.jsonl",
			completionPromise,
		};

		setRunningSubagentForTest(running);
		completionPromise.then((result) => {
			routeDetachedSubagentCompletionForTest(
				{
					sendMessage(message: any, options: any) {
						sent.push({ message, options });
					},
				},
				running,
				result,
			);
		});

		const launchedPromise = getLaunchedSubagentResultForTest(running);
		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Blocking completion summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 2,
		});

		const launched = await launchedPromise;
		assert.equal((launched.details as any).status, "completed");
		assert.equal((launched.details as any).deliveryState, "awaited");
		assert.equal((launched.details as any).summary, "Blocking completion summary");
		assert.match(launched.content[0].text, /Blocking completion summary/);
		assert.equal(sent.length, 0);
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
	});

	it("awaits async siblings when a blocking child gates the batch", async () => {
		let resolveAsyncA!: (result: any) => void;
		let resolveAsyncB!: (result: any) => void;
		let resolveBlocking!: (result: any) => void;
		const asyncAPromise = new Promise<any>((resolve) => {
			resolveAsyncA = resolve;
		});
		const asyncBPromise = new Promise<any>((resolve) => {
			resolveAsyncB = resolve;
		});
		const blockingPromise = new Promise<any>((resolve) => {
			resolveBlocking = resolve;
		});

		const asyncA = {
			id: "child-mix-async-a",
			name: "Async A",
			task: "Keep running",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mix-async-a.jsonl",
			completionPromise: asyncAPromise,
		};
		const asyncB = {
			id: "child-mix-async-b",
			name: "Async B",
			task: "Keep running",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mix-async-b.jsonl",
			completionPromise: asyncBPromise,
		};
		const blocking = {
			id: "child-mix-blocking",
			name: "Blocking gate",
			task: "Gate the parent",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mix-blocking.jsonl",
			completionPromise: blockingPromise,
		};

		markSubagentBatchBlockingForTest();
		for (const running of [asyncA, asyncB, blocking]) {
			setRunningSubagentForTest(running);
		}
		const launchedPromises = [asyncA, blocking, asyncB].map((running) => getLaunchedSubagentResultForTest(running));

		resolveAsyncA({
			name: asyncA.name,
			task: asyncA.task,
			summary: "Async A summary",
			sessionFile: asyncA.sessionFile,
			exitCode: 0,
			elapsed: 2,
		});
		resolveBlocking({
			name: blocking.name,
			task: blocking.task,
			summary: "Blocking gate summary",
			sessionFile: blocking.sessionFile,
			exitCode: 0,
			elapsed: 3,
		});
		resolveAsyncB({
			name: asyncB.name,
			task: asyncB.task,
			summary: "Async B summary",
			sessionFile: asyncB.sessionFile,
			exitCode: 0,
			elapsed: 5,
		});

		const launched = await Promise.all(launchedPromises);
		assert.deepEqual(
			launched.map((result) => (result.details as any).name),
			["Async A", "Blocking gate", "Async B"],
		);
		for (const result of launched) {
			assert.equal((result.details as any).status, "completed");
			assert.equal((result.details as any).deliveryState, "awaited");
			assert.equal((result as any).terminate, undefined);
		}
		assert.equal((launched[0].details as any).async, true);
		assert.equal((launched[2].details as any).async, true);
		for (const running of [asyncA, asyncB, blocking]) {
			assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
		}
	});

	it("renders agent badges while preserving detached and awaited styling slots", () => {
		const base = {
			mode: "background" as const,
			executionState: "running" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/widget-child.jsonl",
			activity: "Working",
		};

		setRunningSubagentForTest({
			...base,
			id: "child-widget-1",
			name: "Detached child",
			agent: "scout",
			task: "Keep running",
			deliveryState: "detached" as const,
		});
		setRunningSubagentForTest({
			...base,
			id: "child-widget-2",
			name: "Awaited child",
			agent: "researcher",
			task: "Wait here",
			deliveryState: "awaited" as const,
		});
		const widget = renderSubagentWidgetForTest().join("\n");
		assert.match(widget, /Detached child \[scout\]/);
		assert.match(widget, /Awaited child \[researcher\]/);
		assert.doesNotMatch(widget, /\[detached\]|\[awaited\]/);
	});

	it("waits for one running subagent and suppresses steer delivery", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		let resolveCompletion!: (result: any) => void;
		const completionPromise = new Promise<any>((resolve) => {
			resolveCompletion = resolve;
		});
		const running = {
			id: "child-wait-1",
			name: "Awaited child",
			task: "Wait for me",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-1.jsonl",
			completionPromise,
		};

		setRunningSubagentForTest(running);
		completionPromise.then((result) => {
			routeDetachedSubagentCompletionForTest(
				{
					sendMessage(message: any, options: any) {
						sent.push({ message, options });
					},
				},
				running,
				result,
			);
		});

		const waitPromise = waitForSubagentForTest({ id: running.name });
		assert.equal(running.deliveryState, "awaited");

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Waited completion summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 2,
		});

		const waited = await waitPromise;
		assert.equal((waited.details as any).id, running.id);
		assert.equal((waited.details as any).status, "completed");
		assert.equal((waited.details as any).deliveryState, "awaited");
		assert.equal((waited.details as any).exitCode, 0);
		assert.equal(sent.length, 0);
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveredTo, "wait");
		assert.equal(getCompletedSubagentResultForTest(running.id)?.deliveryState, "awaited");
	});

	it("returns a ping result instead of completion when an awaited child asks for help", async () => {
		const running = {
			id: "child-wait-ping",
			name: "Ping child",
			task: "Need help",
			mode: "interactive" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-ping.jsonl",
			completionPromise: Promise.resolve({
				name: "Ping child",
				task: "Need help",
				summary: "Need parent help",
				sessionFile: "/tmp/child-wait-ping.jsonl",
				exitCode: 0,
				elapsed: 1,
				ping: { name: "Ping child", message: "Please answer" },
			}),
		};

		setRunningSubagentForTest(running);
		const waited = await waitForSubagentForTest({ id: running.id });
		assert.equal((waited.details as any).id, running.id);
		assert.equal((waited.details as any).status, "pinged");
		assert.equal((waited.details as any).deliveryState, "awaited");
		assert.equal((waited.details as any).sessionFile, running.sessionFile);
		assert.equal((waited.details as any).message, "Please answer");
		assert.equal(getCompletedSubagentResultForTest(running.id), undefined);
	});

	it("returns cached result when a wait is repeated", async () => {
		const running = {
			id: "child-wait-repeat",
			name: "Repeated wait child",
			task: "Wait twice",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-repeat.jsonl",
			completionPromise: Promise.resolve({
				name: "Repeated wait child",
				task: "Wait twice",
				summary: "Done",
				sessionFile: "/tmp/child-wait-repeat.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running);
		const first = await waitForSubagentForTest({ id: running.name });
		const second = await waitForSubagentForTest({ id: running.name });
		assert.equal((first.details as any).status, "completed");
		assert.equal((second.details as any).status, "completed");
		assert.equal((second.details as any).id, running.id);
	});
});
