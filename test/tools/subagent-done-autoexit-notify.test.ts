import {
	assert,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	rmSync,
	sleep,
	subagentDoneExtension,
	writeFileSync,
} from "../support/index.ts";

// Regression suite for the auto-exit operator-takeover notification.
//
// Requirement: interrupting (Escape) or interacting (steer / follow-up / idle
// prompt) with an interactive auto-exit subagent must always surface the
// "Auto-exit disabled" status + toast so the operator learns auto-exit is off.
//
// These tests drive the real `subagentDoneExtension` export with the event
// sequences Pi actually emits (verified against pi-agent-core):
//   - streaming steer / follow-up drain INSIDE the same run (single agent_start)
//   - an idle prompt starts a FRESH run (runAgentLoopContinue -> new agent_start)
//   - Escape (agent.abort) fires NO input event; it is observed at agent_end.

interface Harness {
	handlers: Map<string, any>;
	commands: Map<string, any>;
	notifies: { msg: string; tone?: string }[];
	statusSets: { key: string; msg?: string }[];
	ctx: () => any;
	sessionFile: string;
	shutdowns: () => number;
	disabledNotifies: () => { msg: string; tone?: string }[];
	sidecarExists: () => boolean;
	restore: () => void;
}

function buildAutoExitHarness(opts: { interactive?: boolean } = {}): Harness {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const dir = createTestDir();
	const sessionFile = join(dir, "child.jsonl");
	writeFileSync(sessionFile, "");
	const originalSession = process.env.PI_SUBAGENT_SESSION;
	const originalAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
	const originalSurface = process.env.PI_SUBAGENT_SURFACE;
	process.env.PI_SUBAGENT_SESSION = sessionFile;
	process.env.PI_SUBAGENT_AUTO_EXIT = "1";
	if (opts.interactive) process.env.PI_SUBAGENT_SURFACE = "pane:test";
	else delete process.env.PI_SUBAGENT_SURFACE;

	const notifies: { msg: string; tone?: string }[] = [];
	const statusSets: { key: string; msg?: string }[] = [];
	let shutdowns = 0;

	subagentDoneExtension({
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools() {},
		registerTool(definition: { name: string }) {
			return definition;
		},
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		registerShortcut() {},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
	} as any);

	const ctx = () => ({
		shutdown() {
			shutdowns += 1;
		},
		ui: {
			setStatus(key: string, msg?: string) {
				statusSets.push({ key, msg });
			},
			notify(msg: string, tone?: string) {
				notifies.push({ msg, tone });
			},
			setWidget() {},
		},
		hasPendingMessages: () => false,
	});

	return {
		handlers,
		commands,
		notifies,
		statusSets,
		ctx,
		sessionFile,
		shutdowns: () => shutdowns,
		disabledNotifies: () => notifies.filter((n) => /disabled/i.test(n.msg)),
		sidecarExists: () => {
			try {
				readFileSync(`${sessionFile}.exit`, "utf8");
				return true;
			} catch {
				return false;
			}
		},
		restore: () => {
			if (originalSession == null) delete process.env.PI_SUBAGENT_SESSION;
			else process.env.PI_SUBAGENT_SESSION = originalSession;
			if (originalAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
			else process.env.PI_SUBAGENT_AUTO_EXIT = originalAutoExit;
			if (originalSurface == null) delete process.env.PI_SUBAGENT_SURFACE;
			else process.env.PI_SUBAGENT_SURFACE = originalSurface;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("auto-exit operator-takeover notification", () => {
	it("notifies once on an idle operator input that starts a new run", async () => {
		const h = buildAutoExitHarness({ interactive: true });
		try {
			// Escape disables auto-exit first (notifies once, session stays open).
			h.handlers.get("agent_start")?.({});
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx());
			// Idle operator input (no streamingBehavior) starts a fresh run via
			// runAgentLoopContinue. The takeover episode was already announced, so
			// this input must not emit the same warning again.
			h.handlers.get("input")?.({ source: "interactive" }, h.ctx());
			h.handlers.get("agent_start")?.({});
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, 1, "idle input after disable must not spam");
			assert.equal(h.sidecarExists(), false, "session stays open");
		} finally {
			h.restore();
		}
	});

	it("notifies once per disabled episode, not for every repeated operator input", async () => {
		const h = buildAutoExitHarness({ interactive: true });
		try {
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, 1, "repeat input while already disabled must not spam");
			assert.equal(h.statusSets.filter((s) => s.msg === "Auto-exit disabled — close manually or /auto-exit to re-enable").length, 1);
		} finally {
			h.restore();
		}
	});

	it("notifies exactly once on a streaming steer processed in the same run", async () => {
		const h = buildAutoExitHarness({ interactive: true });
		try {
			h.handlers.get("agent_start")?.({});
			// Streaming steers/follow-ups drain inside the same run (no new
			// agent_start), so the input-time notify must not double up with any
			// agent_end branch.
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, 1, "steer notifies once, not twice");
			assert.equal(h.sidecarExists(), false);
		} finally {
			h.restore();
		}
	});

	it("does not notify on the one-shot /auto-exit re-arm consumption input", async () => {
		const h = buildAutoExitHarness({ interactive: true });
		try {
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx()); // disables + notifies
			await h.commands.get("auto-exit").handler({}, h.ctx()); // re-arm
			const before = h.disabledNotifies().length;
			// The input that consumes the re-arm is the granted "free" input; it must
			// NOT notify, and the next normal completion auto-exits.
			h.handlers.get("input")?.({ source: "interactive" }, h.ctx());
			h.handlers.get("agent_start")?.({});
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, before, "re-arm-consuming input must not notify");
			assert.equal(h.sidecarExists(), true, "re-arm lets the next completion auto-exit");
		} finally {
			h.restore();
		}
	});

	it("ignores the initial task and extension-source recovery nudges", async () => {
		const h = buildAutoExitHarness({ interactive: true });
		try {
			// Initial task: agentStarted is false and there is no streamingBehavior.
			h.handlers.get("input")?.({ source: "interactive" }, h.ctx());
			// Extension recovery nudge: source "extension" is not operator input.
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ source: "extension", streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, 0, "initial task and extension nudges must not notify or disable");
			assert.equal(h.sidecarExists(), true, "auto-exit proceeds normally");
		} finally {
			h.restore();
		}
	});

	it("never touches the UI for a non-interactive (background) child", async () => {
		const h = buildAutoExitHarness({ interactive: false });
		try {
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.notifies.length, 0, "background child never notifies");
			assert.equal(h.statusSets.length, 0, "background child never sets status");
			assert.equal(h.sidecarExists(), false, "operator input still disables auto-exit (stays open)");
		} finally {
			h.restore();
		}
	});

	it("auto-exits after /auto-exit re-arm is consumed by an already-queued steer", async () => {
		// Reproduces the exact frame: operator steers during a run (auto-exit
		// disabled), re-arms /auto-exit mid-stream, the queued steer drains as the
		// next user input, and the following normal completion must auto-exit.
		const h = buildAutoExitHarness({ interactive: true });
		try {
			h.handlers.get("agent_start")?.({});
			h.handlers.get("turn_start")?.({});
			// Operator steer disables auto-exit and notifies.
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, 1);
			// Operator re-arms /auto-exit mid-stream.
			await h.commands.get("auto-exit").handler({}, h.ctx());
			// The queued steer drains as the next input, consuming the one-shot
			// re-arm. Pi fires agent_start for the new run before the input, and the
			// model turn then begins with turn_start.
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("turn_start")?.({});
			// The new turn completes normally: the re-arm must now actually fire.
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.sidecarExists(), true, "re-armed auto-exit must engage after the consumed-steer completion");
			assert.equal(h.shutdowns(), 1, "re-armed auto-exit must shut the child down");
		} finally {
			h.restore();
		}
	});

	it("auto-exits after /auto-exit re-arm when the queued input never starts a tool turn", async () => {
		// The answer to a steer can complete with no tool calls, so no turn_start
		// fires for it. The in-flight steer was sent before the re-arm, so it must
		// not hold; the first clean completion after the re-arm auto-exits.
		const h = buildAutoExitHarness({ interactive: true });
		try {
			h.handlers.get("agent_start")?.({});
			h.handlers.get("turn_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			await h.commands.get("auto-exit").handler({}, h.ctx());
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			// No turn_start: the answer completes without tools.
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.sidecarExists(), true, "re-armed auto-exit engages on the first clean completion");
		} finally {
			h.restore();
		}
	});

	it("auto-exit re-arm works for every input path", async () => {
		// Matrix: steer, follow-up, idle prompt, and mixed sequences. Each path
		// must disable auto-exit on the input, then re-arm must restore it.
		const cases = [
			{ name: "steer then re-arm", inputs: [{ streamingBehavior: "steer" }] },
			{ name: "follow-up then re-arm", inputs: [{ streamingBehavior: "followUp" }] },
			{ name: "idle prompt then re-arm", inputs: [{ source: "interactive" }] },
			{ name: "steer then follow-up then re-arm", inputs: [{ streamingBehavior: "steer" }, { streamingBehavior: "followUp" }] },
		];

		for (const c of cases) {
			const h = buildAutoExitHarness({ interactive: true });
			try {
				h.handlers.get("agent_start")?.({});
				for (const input of c.inputs) {
					h.handlers.get("input")?.(input, h.ctx());
				}
				await sleep(0);
				assert.equal(h.disabledNotifies().length, 1, `${c.name}: input must disable auto-exit`);
				await h.commands.get("auto-exit").handler({}, h.ctx());
				h.handlers.get("agent_start")?.({});
				h.handlers.get("turn_start")?.({});
				h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
				await sleep(0);
				assert.equal(h.sidecarExists(), true, `${c.name}: re-arm must auto-exit`);
			} finally {
				h.restore();
			}
		}
	});

	it("auto-exit re-arm survives multiple queued inputs before completion", async () => {
		// Two steers queued before re-arm: both must be ignored once, re-arm survives.
		const h = buildAutoExitHarness({ interactive: true });
		try {
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			await sleep(0);
			assert.equal(h.disabledNotifies().length, 1);
			await h.commands.get("auto-exit").handler({}, h.ctx());
			h.handlers.get("agent_start")?.({});
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("input")?.({ streamingBehavior: "steer" }, h.ctx());
			h.handlers.get("turn_start")?.({});
			h.handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
			await sleep(0);
			assert.equal(h.sidecarExists(), true, "re-arm must survive multiple queued inputs");
		} finally {
			h.restore();
		}
	});
});
