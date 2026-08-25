import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assert, createTestDir } from "../support/index.ts";
import {
	atomicWriteFileSync,
	claimDelivery,
	isLeaseStale,
	isPidAlive,
	isTerminalState,
	readManifest,
	runFilePaths,
	writeManifest,
	type SupervisorManifest,
	type SupervisorRequest,
} from "../../src/vf/supervisor/manifest.ts";
import { attachRun, cancelRun, claimRunResult, startSupervisedRun, waitForRunResult } from "../../src/vf/supervisor/run-client.ts";
import { getSupervisorMainPath } from "../../src/vf/supervisor/spawn.ts";

const NODE = process.execPath;
const MAIN = getSupervisorMainPath();

function processRequest(script: string, extra: Partial<SupervisorRequest> = {}): SupervisorRequest {
	return {
		kind: "process",
		command: NODE,
		args: ["-e", script],
		...extra,
	};
}

function spawnSupervisor(
	args: string[],
): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(NODE, args, { encoding: "utf8", timeout: 60_000 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("supervisor manifest primitives", () => {
	it("writes and reads a manifest atomically", () => {
		const runDir = createTestDir();
		const manifest: SupervisorManifest = {
			version: 1,
			runId: "vf-test",
			createdAt: new Date().toISOString(),
			state: "running",
			leaseId: "lease1",
			lease: null,
			body: null,
			request: processRequest("process.exit(0)"),
			result: null,
		};
		writeManifest(runDir, manifest);
		const read = readManifest(runDir);
		assert.equal(read.runId, "vf-test");
		assert.deepEqual(read.request.args, ["-e", "process.exit(0)"]);
		assert.ok(existsSync(runFilePaths(runDir).manifest));
		assert.equal(isTerminalState(read.state), false);
	});

	it("rejects manifests with the wrong version and reports a missing one", () => {
		const runDir = createTestDir();
		mkdirSync(runDir, { recursive: true });
		writeFileSync(runFilePaths(runDir).manifest, '{"version": 99}');
		assert.throws(() => readManifest(runDir), /version 99/);
		rmSync(runFilePaths(runDir).manifest);
		assert.throws(() => readManifest(runDir), /No supervised-run manifest/);
	});

	it("atomic writes leave no temp files behind", () => {
		const dir = createTestDir();
		const path = join(dir, "f.json");
		atomicWriteFileSync(path, '{"a":1}');
		atomicWriteFileSync(path, '{"a":2}');
		assert.equal(readFileSync(path, "utf8"), '{"a":2}');
		assert.deepEqual(readdirSync(dir), ["f.json"]);
	});

	it("claims delivery exactly once; later claimants see the first claim", () => {
		const runDir = createTestDir();
		const result = { ok: true, stdoutBytes: 0, stderrBytes: 0, finishedAt: new Date().toISOString() };
		const first = claimDelivery(runDir, result);
		const second = claimDelivery(runDir, result);
		const third = claimDelivery(runDir, result);
		assert.equal(first.claimed, true);
		assert.equal(second.claimed, false);
		assert.equal(third.claimed, false);
		assert.equal(second.claim.claimedAt, first.claim.claimedAt);
		assert.equal(second.claim.pid, first.claim.pid);
	});

	it("treats a lease as stale only when the supervisor is dead AND the heartbeat is old", () => {
		const runDir = createTestDir();
		const base: SupervisorManifest = {
			version: 1,
			runId: "vf-x",
			createdAt: new Date().toISOString(),
			state: "running",
			leaseId: "l",
			lease: null,
			body: null,
			request: processRequest("1"),
			result: null,
		};
		assert.equal(isLeaseStale(base), true, "no lease at all is stale");
		const live: SupervisorManifest = {
			...base,
			lease: {
				pid: process.pid,
				leaseId: "l",
				runtime: "node",
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
			},
		};
		assert.equal(isLeaseStale(live), false, "this test process is alive");
		const deadPid = 3_999_999;
		const dead: SupervisorManifest = {
			...base,
			lease: { ...(live.lease as NonNullable<typeof live.lease>), pid: deadPid },
		};
		assert.equal(isLeaseStale(dead, Date.now() + 120_000), true, "dead pid + old heartbeat");
		assert.equal(isLeaseStale(dead, Date.now()), false, "dead pid but fresh heartbeat");
		assert.equal(isPidAlive(deadPid), false);
	});
});

describe("detached supervisor process (live)", () => {
	it("runs a body process to completion and records the result", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({
			baseDir,
			request: processRequest("console.log('hello from body'); process.exit(0)"),
		});
		const manifest = await waitForRunResult(started.runDir, { timeoutMs: 30_000 });
		assert.equal(manifest.state, "completed");
		assert.equal(manifest.result?.ok, true);
		assert.equal(manifest.result?.exitCode, 0);
		assert.equal(manifest.result?.error, undefined);
		assert.match(readFileSync(join(started.runDir, "stdout.log"), "utf8"), /hello from body/);
		assert.ok(existsSync(started.supervisorLogPath));
	});

	it("records a failing body as failed with its exit code", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({
			baseDir,
			request: processRequest("process.stderr.write('boom\\n'); process.exit(3)"),
		});
		const manifest = await waitForRunResult(started.runDir, { timeoutMs: 30_000 });
		assert.equal(manifest.state, "failed");
		assert.equal(manifest.result?.ok, false);
		assert.equal(manifest.result?.exitCode, 3);
		assert.match(manifest.result?.error ?? "", /exited with code 3/);
		assert.ok((manifest.result?.stderrBytes ?? 0) > 0);
	});

	it("keeps supervisor logs separate from body output", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({
			baseDir,
			request: processRequest("console.log('BODY-STDOUT'); process.exit(0)"),
		});
		await waitForRunResult(started.runDir, { timeoutMs: 30_000 });
		const supervisorLog = readFileSync(started.supervisorLogPath, "utf8");
		const bodyStdout = readFileSync(join(started.runDir, "stdout.log"), "utf8");
		assert.match(supervisorLog, /claimed run/);
		assert.match(supervisorLog, /finished: outcome=exit/);
		// Every supervisor log line is a supervisor line; body output is not
		// interleaved (the spawn echo quoting the command is still a
		// supervisor line).
		for (const line of supervisorLog.split("\n")) {
			if (line.trim()) assert.match(line, /^\[vf-supervisor /);
		}
		assert.match(bodyStdout, /BODY-STDOUT/);
	});

	it("delivers the result exactly once across claims and re-attach", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({ baseDir, request: processRequest("process.exit(0)") });
		await waitForRunResult(started.runDir, { timeoutMs: 30_000 });
		const first = claimRunResult(started.runDir);
		const second = claimRunResult(started.runDir);
		assert.equal(first.claimed, true);
		assert.ok(first.result?.ok);
		assert.equal(second.claimed, false);
		assert.equal(second.alreadyDeliveredBy?.pid, first.claim?.pid);
		assert.equal(second.result?.ok, true, "result stays readable for audit");
		const snapshot = attachRun(started.runDir);
		assert.equal(snapshot.delivered, true);
		assert.equal(snapshot.claim?.pid, first.claim?.pid);
		// The supervisor is one-shot: it must exit shortly after the
		// terminal write (the write can land a tick before process exit).
		for (let i = 0; i < 100 && attachRun(started.runDir).supervisorAlive; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(attachRun(started.runDir).supervisorAlive, false, "supervisor exits after one run");
	});

	it("cancels via sentinel + SIGTERM and marks the run cancelled", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({
			baseDir,
			request: processRequest("console.log('long body starting'); setInterval(()=>{},1000)"),
		});
		let sawBody = false;
		for (let i = 0; i < 150; i++) {
			if (readManifest(started.runDir).body?.pid) {
				sawBody = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(sawBody, "body should spawn");
		const { outcome } = await cancelRun(started.runDir, { timeoutMs: 30_000 });
		assert.equal(outcome, "cancelled");
		const manifest = readManifest(started.runDir);
		assert.equal(manifest.state, "cancelled");
		assert.equal(manifest.result?.ok, false);
		assert.equal(manifest.result?.error, "cancelled");
		assert.ok(existsSync(runFilePaths(started.runDir).cancelSentinel));
		const again = await cancelRun(started.runDir);
		assert.equal(again.outcome, "already-terminal");
	});

	it("enforces the body timeout by killing the process group", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({
			baseDir,
			request: {
				kind: "process",
				command: NODE,
				args: ["-e", "console.log('loop'); setInterval(()=>{},1000)"],
				timeoutMs: 1500,
			},
		});
		const manifest = await waitForRunResult(started.runDir, { timeoutMs: 30_000 });
		assert.equal(manifest.state, "failed");
		assert.match(manifest.result?.error ?? "", /timed out after 1500ms/);
	});

	it("rejects a wrong lease id and refuses to steal a live lease", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({
			baseDir,
			request: processRequest("setInterval(()=>{},1000)"), // long body keeps the real supervisor alive
		});
		const wrong = spawnSupervisor([MAIN, started.runDir, "wrong-lease"]);
		assert.equal(wrong.status, 5);
		assert.match(wrong.stderr, /lease mismatch/);

		// Wait for the real supervisor to claim, then try to steal its lease.
		let claimedPid = 0;
		for (let i = 0; i < 150; i++) {
			const lease = readManifest(started.runDir).lease;
			if (lease?.pid) {
				claimedPid = lease.pid;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(claimedPid > 0, "real supervisor should claim the lease");
		const refuse = spawnSupervisor([MAIN, started.runDir, started.leaseId]);
		assert.equal(refuse.status, 5);
		assert.match(refuse.stderr, /still owns this run/);
		// The real supervisor still owns the run: cancel through it.
		const { outcome } = await cancelRun(started.runDir, { timeoutMs: 30_000 });
		assert.equal(outcome, "cancelled");
		assert.equal(isPidAlive(claimedPid), false);
	});

	it("is a no-op when the run is already terminal", async () => {
		const baseDir = createTestDir();
		const started = startSupervisedRun({ baseDir, request: processRequest("process.exit(0)") });
		await waitForRunResult(started.runDir, { timeoutMs: 30_000 });
		const replay = spawnSupervisor([MAIN, started.runDir, started.leaseId]);
		assert.equal(replay.status, 0);
		assert.equal(readManifest(started.runDir).state, "completed");
	});
});

describe("supervisor survives parent exit and takeover", () => {
	it("completes the run after the spawning parent process is gone", async () => {
		const baseDir = createTestDir();
		// A short-lived parent: starts the run, hands off the run dir, exits.
		const runClientUrl = new URL("../../src/vf/supervisor/run-client.ts", import.meta.url).href;
		const parentScript = `
const { startSupervisedRun } = await import(${JSON.stringify(runClientUrl)});
const { writeFileSync } = await import("node:fs");
const started = startSupervisedRun({
  baseDir: ${JSON.stringify(baseDir)},
  request: { kind: "process", command: process.execPath, args: ["-e", "setTimeout(()=>{console.log('late finish');process.exit(0)},1500)"] },
});
writeFileSync(${JSON.stringify(join(baseDir, "parent-handoff.json"))}, JSON.stringify({ runDir: started.runDir }));
`;
		const parent = spawn(NODE, ["--input-type=module", "-e", parentScript], { stdio: "inherit" });
		const parentExit = new Promise<number>((resolve) => parent.on("exit", (code) => resolve(code ?? -1)));
		assert.equal(await parentExit, 0, "short-lived parent must exit cleanly");
		const handoff = JSON.parse(readFileSync(join(baseDir, "parent-handoff.json"), "utf8")) as {
			runDir: string;
		};
		// Parent gone; the detached supervisor must still finish the body.
		const manifest = await waitForRunResult(handoff.runDir, { timeoutMs: 30_000 });
		assert.equal(manifest.state, "completed");
		assert.equal(manifest.result?.ok, true);
		assert.match(readFileSync(join(handoff.runDir, "stdout.log"), "utf8"), /late finish/);
		// The replacement parent delivers exactly once.
		const claim = claimRunResult(handoff.runDir);
		assert.equal(claim.claimed, true);
	});

	it("kills an orphaned body left by a crashed supervisor on takeover", async () => {
		const baseDir = createTestDir();
		const runId = "vf-takeover-test";
		const runDir = join(baseDir, runId);
		mkdirSync(runDir, { recursive: true });
		// Simulate a crashed supervisor: stale dead lease + still-running orphan body.
		const orphan = spawn(NODE, ["-e", "console.log('orphan body'); setInterval(()=>{},1000)"], {
			stdio: "ignore",
			detached: true,
		});
		const orphanPid = orphan.pid ?? 0;
		// Keep the exit listener attached so this test process reaps the
		// orphan; an unreaped zombie would keep `kill(pid, 0)` succeeding.
		orphan.on("exit", () => {});
		writeManifest(runDir, {
			version: 1,
			runId,
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			state: "running",
			leaseId: "lease-takeover",
			lease: {
				pid: 3_999_999,
				leaseId: "lease-takeover",
				runtime: "node",
				startedAt: new Date(Date.now() - 60_000).toISOString(),
				heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
			},
			body: { pid: orphanPid, pgid: orphanPid, startedAt: new Date(Date.now() - 60_000).toISOString() },
			request: processRequest("console.log('fresh body'); process.exit(0)"),
			result: null,
		});
		const takeover = spawnSupervisor([MAIN, runDir, "lease-takeover"]);
		assert.equal(takeover.status, 0);
		assert.match(takeover.stdout, /killing stale body/);
		for (let i = 0; i < 150 && isPidAlive(orphanPid); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(isPidAlive(orphanPid), false, "orphaned body must be killed on takeover");
		const final = readManifest(runDir);
		assert.equal(final.state, "completed");
		assert.match(readFileSync(join(runDir, "stdout.log"), "utf8"), /fresh body/);
	});
});
