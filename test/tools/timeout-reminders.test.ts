import {
	formatTimeoutWarning,
	getTimeoutWarnDelayMs,
	installSubagentTimeoutReminders,
	parseTimeoutSeconds,
	parseTimeoutWarnThreshold,
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
} from "../../src/tools/timeout-reminders.ts";
import { afterEach, assert, describe, it, sleep } from "../support/index.ts";

const TIMEOUT_ENV = [
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
] as const;

function clearTimeoutEnv(): void {
	for (const name of TIMEOUT_ENV) delete process.env[name];
}

interface FakePi {
	sent: string[];
	handlers: Map<string, Array<() => void>>;
	sendUserMessage(message: string, options?: unknown): void;
	on(event: string, handler: () => void): void;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Array<() => void>>();
	return {
		sent: [],
		handlers,
		sendUserMessage(message: string) {
			this.sent.push(message);
		},
		on(event: string, handler: () => void) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
}

describe("timeout warn threshold parsing", () => {
	it("is off unless the agent opted in", () => {
		assert.equal(parseTimeoutWarnThreshold(undefined), null);
		assert.equal(parseTimeoutWarnThreshold(""), null);
		assert.equal(parseTimeoutWarnThreshold("   "), null);
		assert.equal(parseTimeoutWarnThreshold("false"), null);
		assert.equal(parseTimeoutWarnThreshold("off"), null);
	});

	it("takes 80% for the bare true sentinel", () => {
		assert.equal(parseTimeoutWarnThreshold("true"), 80);
		assert.equal(parseTimeoutWarnThreshold("TRUE"), 80);
	});

	it("accepts whole percentages from 1 to 99, with or without the sign", () => {
		assert.equal(parseTimeoutWarnThreshold("1"), 1);
		assert.equal(parseTimeoutWarnThreshold("50%"), 50);
		assert.equal(parseTimeoutWarnThreshold("99%"), 99);
	});

	it("rounds decimals down", () => {
		assert.equal(parseTimeoutWarnThreshold("80.9%"), 80);
		assert.equal(parseTimeoutWarnThreshold("1.99"), 1);
	});

	it("turns anything else off rather than guessing", () => {
		for (const bad of ["0", "0.4%", "100", "100%", "-20%", "eighty", "80 percent", "8 0"]) {
			assert.equal(parseTimeoutWarnThreshold(bad), null, `expected ${bad} to disable the warning`);
		}
	});
});

describe("timeout budget env parsing", () => {
	it("reads only whole positive seconds", () => {
		assert.equal(parseTimeoutSeconds("30"), 30);
		assert.equal(parseTimeoutSeconds(" 30 "), 30);
		assert.equal(parseTimeoutSeconds("0"), null);
		assert.equal(parseTimeoutSeconds("-1"), null);
		assert.equal(parseTimeoutSeconds("30s"), null);
		assert.equal(parseTimeoutSeconds(""), null);
		assert.equal(parseTimeoutSeconds(undefined), null);
	});
});

describe("timeout warning schedule", () => {
	it("waits for the configured share of the budget", () => {
		assert.equal(getTimeoutWarnDelayMs(600, 80, 0), 480_000);
		assert.equal(getTimeoutWarnDelayMs(600, 80, 200_000), 280_000);
	});

	it("warns at once when the budget is already past its warning point", () => {
		assert.equal(getTimeoutWarnDelayMs(600, 80, 500_000), 0);
	});
});

describe("timeout warning text", () => {
	it("states time spent and time left for the wall clock", () => {
		const text = formatTimeoutWarning("timeout", 900, 720);
		assert.match(text, /Time limit: you have been running for 720s, and your limit is 900s/);
		assert.match(text, /About 180s remain/);
		assert.match(text, /Report your result now, even if it is incomplete/);
		// The child never saw the agent file, so the message must explain itself.
		assert.match(text, /the system stops you/);
	});

	it("states time spent and time left for the idle budget", () => {
		const text = formatTimeoutWarning("idle-timeout", 300, 240);
		assert.match(text, /Idle limit: you have produced no output for 240s, and your limit is 300s without output/);
		assert.match(text, /Output means a message from you or a tool result/);
		assert.match(text, /About 60s remain/);
	});

	it("never promises negative time on a late timer", () => {
		assert.match(formatTimeoutWarning("timeout", 60, 75), /About 0s remain/);
	});
});

describe("timeout reminder installation", () => {
	afterEach(clearTimeoutEnv);

	it("stays inert when the agent set no warn threshold", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT] = "1";
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);
		await sleep(300);
		assert.deepEqual(pi.sent, []);
		assert.equal(pi.handlers.size, 0);
	});

	it("stays inert when a threshold is set but no budget is", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "80%";
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);
		await sleep(300);
		assert.deepEqual(pi.sent, []);
	});

	it("warns once against the parent's clock, not the child's own start", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "50%";
		process.env[PI_SUBAGENT_TIMEOUT] = "2";
		// The parent started the budget 900ms ago, so half of it is 100ms away.
		process.env[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(Date.now() - 900);
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);

		await sleep(400);
		assert.equal(pi.sent.length, 1);
		assert.match(pi.sent[0], /your limit is 2s/);

		await sleep(600);
		assert.equal(pi.sent.length, 1, "the wall-clock warning fires once per run");
	});

	it("restarts the idle warning whenever the child produces something", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "50%";
		process.env[PI_SUBAGENT_IDLE_TIMEOUT] = "1";
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);

		// Activity before the halfway point pushes the warning back.
		await sleep(300);
		for (const handler of pi.handlers.get("turn_end") ?? []) handler();
		await sleep(300);
		assert.deepEqual(pi.sent, [], "a child that keeps producing is not warned");

		await sleep(400);
		assert.equal(pi.sent.length, 1);
		assert.match(pi.sent[0], /Idle limit:/);
	});
});
