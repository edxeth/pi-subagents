import {
	formatTimeoutWarning,
	installSubagentTimeoutReminders,
	parseTimeoutSeconds,
	parseTimeoutWarnThreshold,
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
	PI_SUBAGENT_TIMEOUT_WRAP_UP,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
} from "../../src/tools/timeout-reminders.ts";
import { afterEach, assert, describe, it, sleep } from "../support/index.ts";

const TIMEOUT_ENV = [
	PI_SUBAGENT_TIMEOUT,
	PI_SUBAGENT_IDLE_TIMEOUT,
	PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD,
	PI_SUBAGENT_TIMEOUT_STARTED_AT,
	PI_SUBAGENT_TIMEOUT_WRAP_UP,
] as const;

function clearTimeoutEnv(): void {
	for (const name of TIMEOUT_ENV) delete process.env[name];
}

interface FakePi {
	sent: string[];
	handlers: Map<string, Array<(...args: any[]) => unknown>>;
	sendUserMessage(message: string, options?: unknown): void;
	on(event: string, handler: (...args: any[]) => unknown): void;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
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

describe("timeout warning text", () => {
	it("states time spent and time left for the wall clock", () => {
		const text = formatTimeoutWarning("timeout", 900, 720);
		assert.match(text, /Time limit: you have been running for 720s, and your limit is 900s/);
		assert.match(text, /About 180s remain/);
		assert.match(text, /process restart.*does not reset/i);
		assert.match(text, /conversation inherited or forked.*consumed zero seconds/i);
		assert.match(text, /elapsed and remaining values.*authoritative/i);
		assert.match(text, /Report your result now, even if it is incomplete/);
		// The child never saw the agent file, so the message must explain itself.
		assert.match(text, /the system stops you/);
	});

	it("states time spent and time left for the idle budget", () => {
		const text = formatTimeoutWarning("idle-timeout", 300, 240);
		assert.match(text, /Idle limit: you have produced no output for 240s, and your limit is 300s without output/);
		assert.match(text, /Output means a message from you or a completed tool result/);
		assert.match(text, /long tool call counts as silence/i);
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

	it("injects an authoritative launch-time budget contract from the parent's clock", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "50%";
		process.env[PI_SUBAGENT_TIMEOUT] = "2";
		const startedAt = Date.now() - 900;
		process.env[PI_SUBAGENT_TIMEOUT_STARTED_AT] = String(startedAt);
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);

		const handler = pi.handlers.get("before_agent_start")?.[0];
		assert.ok(handler, "the child must know its clock before it starts work");
		const result = (await handler({ systemPrompt: "base" }, {})) as { systemPrompt?: string };
		assert.match(result.systemPrompt ?? "", new RegExp(new Date(startedAt).toISOString().slice(0, 19)));
		assert.match(result.systemPrompt ?? "", /process restart.*will not reset/i);
		assert.match(result.systemPrompt ?? "", /conversation inherited or forked.*consumed zero seconds/i);
		assert.match(result.systemPrompt ?? "", /parent runtime will interrupt.*50%/i);
		assert.deepEqual(pi.sent, []);
	});

	it("does not rely on a child timer to deliver the warning", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "50%";
		process.env[PI_SUBAGENT_IDLE_TIMEOUT] = "1";
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);

		await sleep(700);
		assert.deepEqual(pi.sent, [], "the parent-owned deadline must not be blocked by this event loop");
	});

	it("blocks new tools in a forced wrap-up continuation", async () => {
		clearTimeoutEnv();
		process.env[PI_SUBAGENT_TIMEOUT_WARN_THRESHOLD] = "50%";
		process.env[PI_SUBAGENT_TIMEOUT] = "1";
		process.env[PI_SUBAGENT_TIMEOUT_WRAP_UP] = "1";
		const pi = makeFakePi();
		installSubagentTimeoutReminders(pi as never);

		const handler = pi.handlers.get("tool_call")?.[0];
		assert.ok(handler, "wrap-up mode must install a tool gate");
		assert.deepEqual(await handler({}, {}), {
			block: true,
			reason: "Time-limit wrap-up mode only allows the final report; do not start or retry tools.",
		});
		await sleep(900);
		assert.deepEqual(pi.sent, [], "a restarted wrap-up must not queue another warning");
	});
});
