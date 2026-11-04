import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { __pollForExitTest__, pollForExit } from "../../src/mux/poll.ts";
import {
	assert,
	createTestDir,
	describe,
	existsSync,
	it,
	ORIGINAL_ENV,
	rmSync,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

function configureFakeCmux(dir: string): void {
	writeExecutable(
		dir,
		"cmux",
		`#!/bin/sh
if [ "$1" = "read-screen" ]; then printf '__SUBAGENT_DONE_0__\n'; fi
`,
	);
	process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "cmux";
	process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";
}

describe("pollForExit", () => {
	it("does not fail when the PID marker is removed between existence check and read", async () => {
		const dir = createTestDir();
		const doneSentinelFile = join(dir, "done.txt");
		const processIdFile = `${doneSentinelFile}.pid`;
		configureFakeCmux(dir);
		writeFileSync(processIdFile, `${process.pid}\n`);

		const originalExistsSync = fs.existsSync;
		let removed = false;
		fs.existsSync = (path: Parameters<typeof fs.existsSync>[0]) => {
			const exists = originalExistsSync(path);
			if (!removed && exists && path === processIdFile) {
				removed = true;
				rmSync(processIdFile, { force: true });
			}
			return exists;
		};
		syncBuiltinESMExports();

		try {
			const result = await pollForExit("surface:pid-removal-race", new AbortController().signal, {
				interval: 10,
				doneSentinelFile,
			});
			assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		} finally {
			fs.existsSync = originalExistsSync;
			syncBuiltinESMExports();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not treat a normal launcher unlink after PID read as abrupt death", async () => {
		const dir = createTestDir();
		const doneSentinelFile = join(dir, "done.txt");
		const processIdFile = `${doneSentinelFile}.pid`;
		const pid = 42_424_242;
		configureFakeCmux(dir);
		writeFileSync(processIdFile, `${pid}\n`);

		const originalKill = process.kill;
		process.kill = (candidatePid: Parameters<typeof process.kill>[0], signal?: Parameters<typeof process.kill>[1]) => {
			if (candidatePid === pid && signal === 0) {
				rmSync(processIdFile, { force: true });
				throw Object.assign(new Error("No such process"), { code: "ESRCH" });
			}
			return originalKill(candidatePid, signal);
		};

		try {
			const result = await pollForExit("surface:pid-exit-race", new AbortController().signal, {
				interval: 10,
				doneSentinelFile,
			});
			assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		} finally {
			process.kill = originalKill;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a child process that died without publishing a completion signal", async () => {
		const dir = createTestDir();
		const doneSentinelFile = join(dir, "done.txt");
		writeExecutable(
			dir,
			"cmux",
			`#!/bin/sh
if [ "$1" = "read-screen" ]; then printf 'clean pane output\\n'; fi
`,
		);
		process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
		process.env.PI_SUBAGENT_MUX = "cmux";
		process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";

		const child = spawn(process.execPath, ["-e", "process.exit(23)"]);
		await once(child, "exit");
		writeFileSync(`${doneSentinelFile}.pid`, `${child.pid}\n`);
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 250);
		try {
			const result = await pollForExit("surface:dead-child", controller.signal, {
				interval: 10,
				doneSentinelFile,
			});
			assert.deepEqual(result, {
				reason: "error",
				exitCode: 1,
				errorMessage: "Interactive child process exited without a completion signal.",
			});
		} finally {
			clearTimeout(abortTimer);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps supervising a live process marker", async () => {
		const dir = createTestDir();
		const doneSentinelFile = join(dir, "done.txt");
		configureFakeCmux(dir);
		writeFileSync(`${doneSentinelFile}.pid`, `${process.pid}\n`);

		try {
			const result = await pollForExit("surface:live-child", new AbortController().signal, {
				interval: 10,
				doneSentinelFile,
			});
			assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	for (const probe of [
		{ name: "EPERM", error: () => Object.assign(new Error("permission denied"), { code: "EPERM" }) },
		{ name: "an unknown error", error: () => new Error("liveness probe unavailable") },
	]) {
		it(`keeps supervising when the process probe returns ${probe.name}`, async () => {
			const dir = createTestDir();
			const doneSentinelFile = join(dir, "done.txt");
			const pid = 42_424_243;
			configureFakeCmux(dir);
			writeFileSync(`${doneSentinelFile}.pid`, `${pid}\n`);

			const originalKill = process.kill;
			process.kill = (candidatePid: Parameters<typeof process.kill>[0], signal?: Parameters<typeof process.kill>[1]) => {
				if (candidatePid === pid && signal === 0) throw probe.error();
				return originalKill(candidatePid, signal);
			};

			try {
				const result = await pollForExit(`surface:probe-${probe.name}`, new AbortController().signal, {
					interval: 10,
					doneSentinelFile,
				});
				assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
			} finally {
				process.kill = originalKill;
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	it("keeps the session exit sidecar ahead of sentinel and PID signals", async () => {
		const dir = createTestDir();
		const sessionFile = join(dir, "child.jsonl");
		const doneSentinelFile = join(dir, "done.txt");
		writeFileSync(sessionFile, "");
		writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
		writeFileSync(doneSentinelFile, "__SUBAGENT_DONE_7__\n");
		writeFileSync(`${doneSentinelFile}.pid`, "42424244\n");

		try {
			const result = await pollForExit("surface:sidecar-priority", new AbortController().signal, {
				interval: 10,
				sessionFile,
				doneSentinelFile,
			});
			assert.deepEqual(result, { reason: "done", exitCode: 0 });
			assert.equal(existsSync(`${sessionFile}.exit`), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the done sentinel ahead of a dead PID marker", async () => {
		const dir = createTestDir();
		const doneSentinelFile = join(dir, "done.txt");
		writeFileSync(doneSentinelFile, "__SUBAGENT_DONE_7__\n");
		writeFileSync(`${doneSentinelFile}.pid`, "42424245\n");

		try {
			const result = await pollForExit("surface:sentinel-priority", new AbortController().signal, {
				interval: 10,
				doneSentinelFile,
			});
			assert.deepEqual(result, { reason: "sentinel", exitCode: 7 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	describe("unreadable surface", () => {
		function configureUnreadableCmux(dir: string): void {
			writeExecutable(
				dir,
				"cmux",
				`#!/bin/sh
if [ "$1" = "read-screen" ]; then echo 'surface unavailable' >&2; exit 1; fi
`,
			);
			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH ?? ""}`;
			process.env.PI_SUBAGENT_MUX = "cmux";
			process.env.CMUX_SOCKET_PATH = "fake-cmux-socket";
		}

		it("keeps supervising a live launcher and returns its later done sentinel", async () => {
			const dir = createTestDir();
			const doneSentinelFile = join(dir, "done.txt");
			configureUnreadableCmux(dir);
			writeFileSync(`${doneSentinelFile}.pid`, `${process.pid}\n`);
			let ticks = 0;

			try {
				const result = await pollForExit("surface:unreadable-live", new AbortController().signal, {
					interval: 10,
					doneSentinelFile,
					onTick: () => {
						ticks += 1;
						if (ticks === 3) writeFileSync(doneSentinelFile, "__SUBAGENT_DONE_0__\n");
					},
				});
				assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
				assert.equal(ticks, 3);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("reports the launcher's death once it stops answering", async () => {
			const dir = createTestDir();
			const doneSentinelFile = join(dir, "done.txt");
			const pid = 42_424_246;
			configureUnreadableCmux(dir);
			writeFileSync(`${doneSentinelFile}.pid`, `${pid}\n`);
			let alive = true;

			const originalKill = process.kill;
			process.kill = (candidatePid: Parameters<typeof process.kill>[0], signal?: Parameters<typeof process.kill>[1]) => {
				if (candidatePid === pid && signal === 0) {
					if (alive) return true;
					throw Object.assign(new Error("No such process"), { code: "ESRCH" });
				}
				return originalKill(candidatePid, signal);
			};

			try {
				const result = await pollForExit("surface:unreadable-then-dead", new AbortController().signal, {
					interval: 10,
					doneSentinelFile,
					onTick: () => {
						alive = false;
					},
				});
				assert.deepEqual(result, {
					reason: "error",
					exitCode: 1,
					errorMessage: "Interactive child process exited without a completion signal.",
				});
			} finally {
				process.kill = originalKill;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("still fails without a launcher record", async () => {
			const dir = createTestDir();
			const doneSentinelFile = join(dir, "done.txt");
			configureUnreadableCmux(dir);

			try {
				await assert.rejects(
					pollForExit("surface:unreadable-unsupervised", new AbortController().signal, {
						interval: 10,
						doneSentinelFile,
					}),
					/Failed to read subagent surface while polling for exit/,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});

describe("interpretExitSidecar", () => {
	const { interpretExitSidecar } = __pollForExitTest__;

	it("carries the context-pressure completion reason to the parent", () => {
		// This is the only channel a --no-session child has; dropping it here
		// silently removes the parent's explanation and the resume block.
		assert.deepEqual(interpretExitSidecar({ type: "done", completionReason: "context-pressure" }), {
			reason: "done",
			exitCode: 0,
			completionReason: "context-pressure",
		});
	});

	it("does not invent a completion reason", () => {
		const decoded = interpretExitSidecar({ type: "done", outputTokens: 4 });
		assert.equal("completionReason" in decoded, false);
		assert.equal(interpretExitSidecar({ type: "done", completionReason: "bogus" }).completionReason, undefined);
	});

	it("decodes ping payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "ping",
				name: "Worker",
				message: "need help",
			}),
			{
				reason: "ping",
				exitCode: 0,
				ping: { name: "Worker", message: "need help" },
			},
		);
	});

	it("decodes done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done" }), {
			reason: "done",
			exitCode: 0,
		});
	});

	it("decodes error payloads with non-zero exit code and errorMessage", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "error",
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
				stopReason: "error",
			}),
			{
				reason: "error",
				exitCode: 1,
				errorMessage: "Anthropic 529 Overloaded after 3 retries",
			},
		);
	});

	it("falls back when error payload has no errorMessage", () => {
		const result = interpretExitSidecar({ type: "error" });
		assert.equal(result.reason, "error");
		assert.equal(result.exitCode, 1);
		assert.match(result.errorMessage ?? "", /no errorMessage/);
	});

	it("treats unknown payload shapes as done", () => {
		assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
	});

	it("threads outputTokens through done payloads", () => {
		assert.deepEqual(interpretExitSidecar({ type: "done", outputTokens: 42 }), {
			reason: "done",
			exitCode: 0,
			outputTokens: 42,
		});
	});

	it("threads outputTokens through error payloads", () => {
		const result = interpretExitSidecar({
			type: "error",
			errorMessage: "timeout",
			outputTokens: 17,
		});
		assert.equal(result.outputTokens, 17);
	});

	it("threads final context usage through done payloads", () => {
		assert.deepEqual(
			interpretExitSidecar({
				type: "done",
				contextTokens: 145_000,
				contextWindow: 200_000,
			}),
			{
				reason: "done",
				exitCode: 0,
				contextTokens: 145_000,
				contextWindow: 200_000,
			},
		);
	});
});
