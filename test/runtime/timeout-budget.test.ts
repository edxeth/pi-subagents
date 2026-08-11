import {
	checkSubagentTimeout,
	checkSubagentTimeoutWrapUp,
	findDueTimeoutWrapUp,
	findExpiredTimeoutBudget,
	formatTimeoutOutcome,
	formatTimeoutSeconds,
	observeSubagentProgress,
} from "../../src/runtime/timeout-budget.ts";
import { resolveSubagentTimeoutState } from "../../src/launch/policy.ts";
import type { RunningSubagent } from "../../src/types.ts";
import { assert, describe, it } from "../support/index.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
	return {
		id: "budget",
		name: "budget-child",
		task: "work",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		startTime: 1_000_000,
		sessionFile: "/tmp/does-not-exist.jsonl",
		...overrides,
	};
}

describe("timeout budget math", () => {
	it("leaves a child with no configured budget unbounded", () => {
		const running = makeRunning();
		assert.equal(checkSubagentTimeout(running, running.startTime + 86_400_000), null);
	});

	it("expires the wall-clock budget only once it is fully spent", () => {
		const budget = { timeoutSeconds: 30 };
		assert.equal(findExpiredTimeoutBudget(budget, 0, 0, 29_999), null);
		assert.deepEqual(findExpiredTimeoutBudget(budget, 0, 0, 30_000), { kind: "timeout", seconds: 30 });
	});

	it("expires the idle budget from the last progress, not from launch", () => {
		const budget = { idleTimeoutSeconds: 10 };
		// Running for 60s but active 3s ago: the idle budget is not spent.
		assert.equal(findExpiredTimeoutBudget(budget, 0, 57_000, 60_000), null);
		assert.deepEqual(findExpiredTimeoutBudget(budget, 0, 50_000, 60_000), {
			kind: "idle-timeout",
			seconds: 10,
		});
	});

	it("reports the wall clock when both budgets expire in the same tick", () => {
		const expired = findExpiredTimeoutBudget({ timeoutSeconds: 30, idleTimeoutSeconds: 10 }, 0, 0, 60_000);
		assert.deepEqual(expired, { kind: "timeout", seconds: 30 });
	});

	it("reserves the configured remainder before either hard limit", () => {
		assert.equal(findDueTimeoutWrapUp({ timeoutSeconds: 100 }, 80, 0, 0, 79_999), null);
		assert.deepEqual(findDueTimeoutWrapUp({ timeoutSeconds: 100 }, 80, 0, 0, 80_000), {
			kind: "timeout",
			seconds: 100,
			threshold: 80,
		});
		assert.deepEqual(findDueTimeoutWrapUp({ timeoutSeconds: 200, idleTimeoutSeconds: 20 }, 80, 0, 70_000, 86_000), {
			kind: "idle-timeout",
			seconds: 20,
			threshold: 80,
		});
	});

	it("does not let wrap-up output reset the idle hard deadline", () => {
		const running = makeRunning({
			timeoutBudget: { idleTimeoutSeconds: 10 },
			timeoutWarnThreshold: 80,
			lastProgressAt: 1_000_000,
			timeoutWrapUp: { kind: "idle-timeout", seconds: 10, threshold: 80 },
			timeoutWrapUpMode: true,
			timeoutWrapUpDeadlineAt: 1_010_000,
		});
		observeSubagentProgress(running, 100, 1_000_000);
		observeSubagentProgress(running, 200, 1_009_000);
		assert.deepEqual(checkSubagentTimeout(running, 1_010_000), {
			kind: "idle-timeout",
			seconds: 10,
		});
	});

	it("requests only one wrap-up phase for a run", () => {
		const running = makeRunning({
			timeoutBudget: { timeoutSeconds: 10 },
			timeoutWarnThreshold: 80,
		});
		assert.deepEqual(checkSubagentTimeoutWrapUp(running, running.startTime + 8_000), {
			kind: "timeout",
			seconds: 10,
			threshold: 80,
		});
		running.timeoutWrapUp = { kind: "timeout", seconds: 10, threshold: 80 };
		assert.equal(checkSubagentTimeoutWrapUp(running, running.startTime + 9_000), null);
	});

	it("takes a baseline on the first observation instead of crediting the launch header", () => {
		const running = makeRunning({ timeoutBudget: { idleTimeoutSeconds: 10 } });

		// The file already holds the launch header. Counting that as progress
		// would hand the child a free poll interval before its clock starts.
		observeSubagentProgress(running, 100, running.startTime + 1_000);
		assert.equal(running.bytes, 100);
		assert.equal(running.lastProgressAt, undefined);

		// So the idle budget is measured from launch, not from the first tick.
		assert.equal(checkSubagentTimeout(running, running.startTime + 9_999), null);
		assert.deepEqual(checkSubagentTimeout(running, running.startTime + 10_000), {
			kind: "idle-timeout",
			seconds: 10,
		});
	});

	it("restarts the idle clock when the session file grows", () => {
		const running = makeRunning({ timeoutBudget: { idleTimeoutSeconds: 10 } });
		observeSubagentProgress(running, 100, running.startTime);

		// A tick with no growth leaves the clock where it was.
		observeSubagentProgress(running, 100, running.startTime + 5_000);
		assert.equal(running.lastProgressAt, undefined);

		// Growth moves it forward, so the budget is no longer close to spent.
		observeSubagentProgress(running, 240, running.startTime + 9_000);
		assert.equal(running.lastProgressAt, running.startTime + 9_000);
		assert.equal(running.bytes, 240);
		assert.equal(checkSubagentTimeout(running, running.startTime + 15_000), null);
		assert.deepEqual(checkSubagentTimeout(running, running.startTime + 19_000), {
			kind: "idle-timeout",
			seconds: 10,
		});
	});

	it("owns the byte count so a caller cannot break the comparison", () => {
		const running = makeRunning({ timeoutBudget: { idleTimeoutSeconds: 10 } });
		observeSubagentProgress(running, 100, running.startTime);
		observeSubagentProgress(running, 180, running.startTime + 2_000);
		// Growth is measured against the value this function recorded, so no
		// caller ordering can make a growing session look idle.
		assert.equal(running.bytes, 180);
		assert.equal(running.lastProgressAt, running.startTime + 2_000);
	});

	it("stops reporting an expiry once a kill is already underway", () => {
		const running = makeRunning({ timeoutBudget: { timeoutSeconds: 5 } });
		assert.deepEqual(checkSubagentTimeout(running, running.startTime + 5_000), { kind: "timeout", seconds: 5 });
		running.timeoutExpiry = { kind: "timeout", seconds: 5 };
		assert.equal(checkSubagentTimeout(running, running.startTime + 9_000), null);
	});

	it("formats budgets in the unit they were written in", () => {
		assert.equal(formatTimeoutSeconds(45), "45s");
		assert.equal(formatTimeoutSeconds(90), "90s");
		assert.equal(formatTimeoutSeconds(120), "2m");
		assert.equal(formatTimeoutSeconds(3600), "1h");
	});
});

describe("timeout launch state", () => {
	it("carries nothing for an agent with no budget", () => {
		assert.deepEqual(resolveSubagentTimeoutState({ onTimeout: "block-resume" }), {});
	});

	it("carries only the budgets the agent set", () => {
		assert.deepEqual(resolveSubagentTimeoutState({ idleTimeout: 120 }), {
			timeoutBudget: { idleTimeoutSeconds: 120 },
		});
	});

	it("carries the resume block only when the agent opted into it", () => {
		assert.deepEqual(resolveSubagentTimeoutState({ timeout: 60 }), {
			timeoutBudget: { timeoutSeconds: 60 },
		});
		assert.deepEqual(resolveSubagentTimeoutState({ timeout: 60, onTimeout: "block-resume" }), {
			timeoutBudget: { timeoutSeconds: 60 },
			timeoutBlocksResume: true,
		});
	});

	it("carries a valid wrap-up threshold only when a budget exists", () => {
		assert.deepEqual(resolveSubagentTimeoutState({ timeoutWarnThreshold: "80%" }), {});
		assert.deepEqual(resolveSubagentTimeoutState({ timeout: 60, timeoutWarnThreshold: "80.9%" }), {
			timeoutBudget: { timeoutSeconds: 60 },
			timeoutWarnThreshold: 80,
		});
		assert.deepEqual(resolveSubagentTimeoutState({ timeout: 60, timeoutWarnThreshold: "bogus" }), {
			timeoutBudget: { timeoutSeconds: 60 },
		});
	});
});

describe("timeout outcome text", () => {
	const base = { name: "scout", elapsed: 900, summary: "Mapped the auth flow." } as const;

	it("names the spent wall-clock budget and keeps the partial work", () => {
		const text = formatTimeoutOutcome(
			{ ...base, timedOut: "timeout", timedOutAfter: 900 },
			true,
			(elapsed) => `${elapsed}s`,
		);
		assert.match(text, /the system stopped it after 900s/);
		assert.match(text, /limit of 15m for the whole run/);
		assert.match(text, /Mapped the auth flow\./);
		assert.match(text, /smaller task/);
	});

	it("says plainly that a silent child produced nothing", () => {
		const text = formatTimeoutOutcome(
			{ ...base, timedOut: "idle-timeout", timedOutAfter: 180 },
			false,
			(elapsed) => `${elapsed}s`,
		);
		assert.match(text, /limit of 3m without output/);
		assert.match(text, /It produced no output before it stopped/);
		assert.doesNotMatch(text, /Mapped the auth flow/);
	});

	it("tells the parent resume is refused under block-resume", () => {
		const text = formatTimeoutOutcome(
			{ ...base, timedOut: "timeout", timedOutAfter: 900, timeoutBlocksResume: true },
			true,
			(elapsed) => `${elapsed}s`,
		);
		assert.match(text, /does not allow a resume after a limit stops it/);
		assert.doesNotMatch(text, /A resume gets the same limit/);
	});
});
