import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { basename } from "node:path";
import {
	isPidAlive,
	isTerminalState,
	readManifest,
	runFilePaths,
	updateManifest,
	type SupervisorManifest,
} from "./manifest.ts";

/**
 * Detached supervisor entrypoint: one process owns one run end-to-end.
 * Usage: `<runtime> main.ts <runDir> <leaseId>`.
 *
 * The supervisor claims the run by lease, kills any body process a dead
 * predecessor left behind, executes the request, and writes the terminal
 * state + result atomically. It exits after one run; it never loops.
 *
 * Exit codes: 0 = run reached a terminal state (completed/failed/cancelled),
 * 2 = usage/manifest/protocol error, 5 = lease lost (another supervisor owns
 * the run).
 */

const TICK_MS = 250;
const HEARTBEAT_MS = 5000;
const KILL_GRACE_MS = 5000;

function log(message: string): void {
	process.stdout.write(`[vf-supervisor ${new Date().toISOString()}] ${message}\n`);
}

function fail(message: string, code = 2): never {
	process.stderr.write(`[vf-supervisor] ${message}\n`);
	process.exit(code);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Already gone.
	}
}

async function killProcessGroup(pgid: number, graceMs = KILL_GRACE_MS): Promise<void> {
	if (pgid <= 0) return;
	signalGroup(pgid, "SIGTERM");
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && groupAlive(pgid)) await sleep(100);
	if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
	// No post-SIGKILL wait: a pid that survives SIGKILL is a zombie someone
	// else must reap (not our child) or an kernel-level stuck process; either
	// way polling longer just stalls the supervisor.
}

// ---------------------------------------------------------------------------
// Manifest + lease bootstrap
// ---------------------------------------------------------------------------

const [runDir, leaseId] = process.argv.slice(2);
if (!runDir || !leaseId) {
	fail(`usage: ${basename(process.argv[1] ?? "main.ts")} <runDir> <leaseId>`);
}

let manifest: SupervisorManifest;
try {
	manifest = readManifest(runDir);
} catch (error) {
	fail(`cannot read manifest: ${(error as Error).message}`);
}

// A finished run is a no-op: its result is already durable.
if (isTerminalState(manifest.state)) {
	log(`run ${manifest.runId} already ${manifest.state}; nothing to own`);
	process.exit(0);
}
if (manifest.state !== "running") {
	fail(`unexpected state "${manifest.state}" for a live supervisor`);
}
if (manifest.leaseId !== leaseId) {
	fail(`lease mismatch: manifest expects lease ${manifest.leaseId}, got ${leaseId}`, 5);
}
if (manifest.lease && manifest.lease.leaseId !== leaseId) {
	fail(`lease mismatch: manifest lease ${manifest.lease.leaseId} is not mine`, 5);
}
if (manifest.lease && manifest.lease.pid !== process.pid && isPidAlive(manifest.lease.pid)) {
	fail(`another supervisor (pid ${manifest.lease.pid}) still owns this run`, 5);
}

const paths = runFilePaths(runDir);
const runtimeLabel = basename(process.execPath).replace(/\.exe$/, "");

if (manifest.body && manifest.body.pgid > 0 && groupAlive(manifest.body.pgid)) {
	// The predecessor died mid-body: the orphaned body must not keep running
	// alongside a fresh one.
	log(`killing stale body pid ${manifest.body.pid} (pgid ${manifest.body.pgid})`);
	await killProcessGroup(manifest.body.pgid);
}

updateManifest(runDir, (current) => {
	if (current.leaseId !== leaseId) fail("lease lost before claim", 5);
	current.lease = {
		pid: process.pid,
		leaseId,
		runtime: runtimeLabel,
		startedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
	};
	current.body = null;
});
log(`claimed run ${manifest.runId} (pid ${process.pid}, runtime ${runtimeLabel})`);

// ---------------------------------------------------------------------------
// Body execution
// ---------------------------------------------------------------------------

type BodyOutcome =
	| { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; spawnError?: string }
	| { kind: "cancelled" }
	| { kind: "timeout"; timeoutMs: number };

const request = manifest.request;
let cancelled = false;
let timedOut = false;
let stdoutBytes = 0;
let stderrBytes = 0;
let bodyPgid = 0;
let lastHeartbeat = Date.now();

const outcome = await new Promise<BodyOutcome>((resolveOutcome) => {
	let settled = false;
	const settle = (value: BodyOutcome) => {
		if (settled) return;
		settled = true;
		resolveOutcome(value);
	};

	if (request.kind !== "process") {
		fail(`unsupported request kind "${(request as { kind: string }).kind}"`);
	}

	const stdoutStream = createWriteStream(paths.stdout, { flags: "a" });
	const stderrStream = createWriteStream(paths.stderr, { flags: "a" });
	const child = spawn(request.command, request.args ?? [], {
		cwd: request.cwd,
		detached: true, // own process group: the whole body is signalable
		env: { ...process.env, ...(request.env ?? {}) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	bodyPgid = child.pid ?? 0;
	if (!bodyPgid) {
		fail("body spawn returned no pid");
	}
	updateManifest(runDir, (current) => {
		if (current.lease?.pid === process.pid) {
			current.body = { pid: bodyPgid, pgid: bodyPgid, startedAt: new Date().toISOString() };
		}
	});
	log(`spawned body pid ${bodyPgid}: ${request.command} ${(request.args ?? []).join(" ")}`);

	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		stdoutStream.write(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		stderrStream.write(chunk);
	});
	const closeStreams = () => {
		stdoutStream.end();
		stderrStream.end();
	};
	child.on("error", (error) => {
		log(`body spawn error: ${error.message}`);
		closeStreams();
		settle({ kind: "exit", code: null, signal: null, spawnError: error.message });
	});
	child.on("exit", (code, signal) => {
		closeStreams();
		settle({ kind: "exit", code, signal });
	});

	const abortBody = async (reason: "cancelled" | "timeout") => {
		if (bodyPgid > 0) await killProcessGroup(bodyPgid);
		settle(reason === "cancelled" ? { kind: "cancelled" } : { kind: "timeout", timeoutMs: 0 });
	};

	const timeoutMs = request.timeoutMs ?? 0;
	const timeoutAt = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

	const timer = setInterval(() => {
		void (async () => {
			let current: SupervisorManifest;
			try {
				current = readManifest(runDir);
			} catch {
				return; // transient read race with an atomic rename; retry next tick
			}
			if (isTerminalState(current.state)) {
				log(`state already ${current.state}; exiting`);
				clearInterval(timer);
				await killProcessGroup(bodyPgid);
				process.exit(0);
			}
			if (current.leaseId !== leaseId || (current.lease && current.lease.pid !== process.pid)) {
				clearInterval(timer);
				// Takeover happened: kill the body we spawned so it cannot
				// keep running under nobody's ownership.
				await killProcessGroup(bodyPgid);
				fail("lease lost: another supervisor took over this run", 5);
			}
			if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
				lastHeartbeat = Date.now();
				updateManifest(runDir, (m) => {
					if (m.lease?.pid === process.pid) m.lease.heartbeatAt = new Date().toISOString();
				});
			}
			if (!cancelled && existsSync(paths.cancelSentinel)) {
				cancelled = true;
				log("cancel sentinel observed");
				clearInterval(timer);
				await abortBody("cancelled");
			}
			if (!cancelled && !timedOut && Date.now() >= timeoutAt) {
				timedOut = true;
				log(`body timed out after ${timeoutMs}ms; killing`);
				clearInterval(timer);
				await abortBody("timeout");
			}
		})();
	}, TICK_MS);

	const onSignal = (signal: NodeJS.Signals) => {
		if (settled) return;
		log(`${signal} received; cancelling run`);
		cancelled = true;
		clearInterval(timer);
		void abortBody("cancelled");
	};
	process.on("SIGTERM", () => onSignal("SIGTERM"));
	process.on("SIGINT", () => onSignal("SIGINT"));
});

// ---------------------------------------------------------------------------
// Terminal write
// ---------------------------------------------------------------------------

const finishedAt = new Date().toISOString();
const result = {
	ok:
		outcome.kind === "exit" &&
		!cancelled &&
		!timedOut &&
		outcome.code === 0 &&
		outcome.spawnError === undefined,
	...(outcome.kind === "exit" && outcome.code !== null ? { exitCode: outcome.code } : {}),
	// Cancel/timeout win over the body's exit-by-signal: the settle race
	// between abortBody and the exit handler is not authoritative.
	error: cancelled
		? "cancelled"
		: timedOut
			? `body timed out after ${request.timeoutMs ?? 0}ms`
			: outcomeErrorMessage(outcome),
	stdoutBytes,
	stderrBytes,
	finishedAt,
};

updateManifest(runDir, (current) => {
	if (current.leaseId !== leaseId) fail("lease lost before terminal write", 5);
	if (isTerminalState(current.state)) return;
	current.body = null;
	current.result = result;
	current.state = cancelled ? "cancelled" : result.ok ? "completed" : "failed";
});
log(`run ${manifest.runId} finished: outcome=${outcome.kind} ok=${result.ok}`);
process.exit(0);

function outcomeErrorMessage(outcome: BodyOutcome): string | undefined {
	if (outcome.kind === "cancelled") return "cancelled";
	if (outcome.kind === "timeout") return `body timed out after ${request.timeoutMs ?? 0}ms`;
	if (outcome.spawnError) return `body spawn failed: ${outcome.spawnError}`;
	if (outcome.code !== null && outcome.code !== 0) return `body exited with code ${outcome.code}`;
	if (outcome.signal) return `body killed by ${outcome.signal}`;
	return undefined;
}
