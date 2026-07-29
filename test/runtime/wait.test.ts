import {
	assert,
	afterEach,
	describe,
	it,
	getCompletedSubagentResultForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	waitForSubagentForTest,
	sleep,
} from "../support/index.ts";

describe("subagent wait behavior", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	function waitForResult(result: any) {
		const running = {
			id: `child-wait-${Math.random()}`,
			name: result.name,
			task: result.task,
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: result.sessionFile,
			completionPromise: Promise.resolve(result),
		};
		setRunningSubagentForTest(running);
		return waitForSubagentForTest({ id: running.id });
	}

	it("includes salvaged child output in provider error results", async () => {
		const waited = await waitForResult({
			name: "Failed child",
			task: "Finish work",
			summary: "Implemented the requested fix.",
			summarySource: "subagent",
			sessionFile: "/tmp/failed-child.jsonl",
			exitCode: 0,
			elapsed: 2,
			errorMessage: "Provider unavailable",
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /Last output before the failure \(may be incomplete/);
		assert.match(text, /Implemented the requested fix\./);
		assert.doesNotMatch(text, /did not produce a result/);
	});

	it("reports no result when a provider error has only watcher fallback output", async () => {
		const waited = await waitForResult({
			name: "Failed child",
			task: "Finish work",
			summary: "Background agent exited without output",
			summarySource: "runtime",
			sessionFile: "/tmp/failed-child.jsonl",
			exitCode: 1,
			elapsed: 2,
			errorMessage: "Provider unavailable",
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /The subagent did not produce a result\./);
		assert.doesNotMatch(text, /Last output before the failure/);
	});

	it("includes the child message in ping results", async () => {
		const waited = await waitForResult({
			name: "Ping child",
			task: "Investigate",
			summary: "",
			sessionFile: "/tmp/ping-child.jsonl",
			exitCode: 0,
			elapsed: 1,
			ping: { name: "Ping child", message: "Which API version should I use?" },
		});
		const text = (waited.content[0] as { text: string }).text;
		assert.match(text, /Message from the subagent:\nWhich API version should I use\?/);
	});

	it("returns cached result when wait follows steer delivery", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-wait-2",
			name: "Already delivered child",
			task: "Too late",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-2.jsonl",
		};

		routeDetachedSubagentCompletionForTest(
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

		const waited = await waitForSubagentForTest({ id: running.id });
		assert.equal(sent.length, 1);
		assert.equal((waited.details as any).id, running.id);
		assert.equal((waited.details as any).name, running.name);
		assert.equal((waited.details as any).status, "completed");
		assert.equal((waited.details as any).deliveryState, "awaited");
		assert.equal((waited.details as any).exitCode, 0);
	});

	it("returns pending on wait timeout and restores detached delivery", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		let resolveCompletion!: (result: any) => void;
		const completionPromise = new Promise<any>((resolve) => {
			resolveCompletion = resolve;
		});
		const running = {
			id: "child-wait-3",
			name: "Slow child",
			task: "Still running",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-3.jsonl",
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

		const waited = await waitForSubagentForTest({
			id: running.id,
			timeout: 0.01,
			onTimeout: "detach",
		});

		assert.equal((waited.details as any).status, "pending");
		assert.equal((waited.details as any).deliveryState, "detached");
		assert.equal(running.deliveryState, "detached");

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Late completion summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 3,
		});
		await sleep(0);

		assert.equal(sent.length, 1);
		assert.equal((sent[0].message.details as any).id, running.id);
		assert.equal((sent[0].message.details as any).deliveryState, "detached");
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"steer",
		);
	});

	it("returns timeout errors for wait and restores detached delivery", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		let resolveCompletion!: (result: any) => void;
		const completionPromise = new Promise<any>((resolve) => {
			resolveCompletion = resolve;
		});
		const running = {
			id: "child-wait-timeout-error",
			name: "Timeout child",
			task: "Miss the deadline",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-timeout-error.jsonl",
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

		const waited = await waitForSubagentForTest({
			id: running.id,
			timeout: 0.01,
		});
		assert.equal((waited.details as any).error, "timeout");
		assert.equal(running.deliveryState, "detached");
		assert.equal((running as any).resultOwner, undefined);

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Late timeout summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 7,
		});
		await sleep(0);

		assert.equal(sent.length, 1);
		assert.equal((sent[0].message.details as any).id, running.id);
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"steer",
		);
	});

	it("releases awaited children back to steer when wait is interrupted", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		let resolveCompletion!: (result: any) => void;
		const completionPromise = new Promise<any>((resolve) => {
			resolveCompletion = resolve;
		});
		const running = {
			id: "child-wait-interrupt-1",
			name: "Interrupted wait child",
			task: "Resume detached delivery",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-wait-interrupt-1.jsonl",
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

		const abort = new AbortController();
		const waitPromise = waitForSubagentForTest(
			{ id: running.id },
			abort.signal,
		);
		assert.equal(running.deliveryState, "awaited");

		abort.abort();
		const waited = await waitPromise;
		assert.equal((waited.details as any).error, "interrupted");
		assert.equal(running.deliveryState, "detached");
		assert.equal((running as any).resultOwner, undefined);

		resolveCompletion({
			name: running.name,
			task: running.task,
			summary: "Interrupted wait summary",
			sessionFile: running.sessionFile,
			exitCode: 0,
			elapsed: 8,
		});
		await sleep(0);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "steer");
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"steer",
		);
	});
});
