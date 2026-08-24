import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { ensureVerifierRuntime, RUNNER_SCRIPT_PATH, VerifierRuntimeError } from "./venv.ts";

/** The library's control vars: stripped from the inherited environment so
 * only the door composed by resolveVerifierModel (and the request's thinking
 * setting) reaches the runner — ambient shell state cannot change the backend,
 * reasoning effort, or token budget. */
const VERIFIER_INTERFACE_VARS = [
	"OPENAI_BASE_URL",
	"OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"VERTEX_API_KEY",
	"DEEPSEEK_EFFORT",
	"DEEPSEEK_MAX_TOKENS",
] as const;

export function verifierBridgeBaseEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env = { ...base };
	for (const name of VERIFIER_INTERFACE_VARS) delete env[name];
	return env;
}

/**
 * NDJSON one-shot bridge to the official `llm-verifier` library.
 *
 * One request line goes in on stdin; one response line comes back on stdout;
 * diagnostics land on stderr. The bridge never reimplements scoring math —
 * it validates the protocol, enforces the fail-closed selection parameters,
 * and maps every failure mode (malformed request, missing credentials,
 * criteria problems, backend errors, comparison-count/cache halts, timeout,
 * cancellation) onto a typed error.
 */

/** Exit codes the runner contract defines (see runner.py). */
export const RUNNER_EXIT_CODES = {
	ok: 0,
	malformed: 2,
	credentials: 3,
	verifier: 4,
	halt: 5,
	criteria: 22,
	capability: 6,
} as const;

export type VerifierBridgeErrorKind =
	| "malformed-request"
	| "credentials"
	| "criteria"
	| "verifier-error"
	| "capability"
	| "degenerate-scores"
	| "comparison-count"
	| "cache"
	| "timeout"
	| "cancelled"
	| "spawn"
	| "protocol"
	| "runtime";

export class VerifierBridgeError extends Error {
	readonly kind: VerifierBridgeErrorKind;
	readonly exitCode: number | null;
	readonly detail: Record<string, unknown> | undefined;
	readonly stderrTail: string | undefined;

	constructor(
		kind: VerifierBridgeErrorKind,
		message: string,
		options: { exitCode?: number | null; detail?: Record<string, unknown>; stderrTail?: string } = {},
	) {
		super(message);
		this.name = "VerifierBridgeError";
		this.kind = kind;
		this.exitCode = options.exitCode ?? null;
		this.detail = options.detail;
		this.stderrTail = options.stderrTail;
	}
}

/** Configuration for the in-process mock verifier (test seam; never set by production paths). */
export interface MockVerifierConfig {
	/** Trace marker that should score best (letter A). */
	goodMarker?: string;
	/** Trace marker that should score middling (letter C). */
	midMarker?: string;
	/** Make every backend call raise (tests on_error="raise" propagation). */
	failCalls?: boolean;
	/** Simulate a slow backend (deadline tests). */
	sleepSeconds?: number;
	/** Append one JSON line per backend call (proves the model reached every call). */
	logFile?: string;
	/** Every letter distribution uniform: the backend cannot discriminate (scores 0.5/0.5). */
	flatScores?: boolean;
	/** Answer with text score letters but no logprob distributions (logprob-less proxy). */
	stripLogprobs?: boolean;
}

export interface VerifierSelectRequest {
	problem: string;
	candidates: string[];
	/** Absolute path to the criteria file. */
	criteriaPath: string;
	/** Plain library model id (provider prefix / :thinking already stripped). */
	model: string;
	/** Library reasoning effort ("off" | "low" | "high" | "max"). */
	thinking?: string | null;
	/** Repeated verifications per criterion. Default 4; 8 in benchmark mode. */
	nEvaluations?: number;
	/** Benchmark mode doubles n_evaluations to 8 when nEvaluations is unset. */
	benchmark?: boolean;
	pivots?: number;
	seed?: number;
	maxWorkers?: number | null;
	/** Score cache path; see defaultVerifierCachePath. */
	cachePath?: string | null;
	/** Verifier profile env block (credentials), merged over the process env. */
	env?: Record<string, string>;
	/** Test seam: run the tournament against the mock backend instead of a real one. */
	mockVerifier?: MockVerifierConfig | null;
}

export interface VerifierUsage {
	calls: number;
	input_tokens: number;
	cached_input_tokens: number;
	uncached_input_tokens: number;
	output_tokens: number;
	reasoning_tokens: number;
	cache_hit_rate: number;
}

export interface VerifierSelectResponse {
	ok: true;
	kind: "select";
	model: string;
	thinking: string | null;
	winnerIndex: number;
	ranking: number[];
	scores: number[];
	criteria: string[];
	nComparisons: number;
	expectedComparisons: number;
	usage: VerifierUsage;
	cache: { path: string; bytes: number } | null;
	elapsedMs: number;
}

export interface PreviewCriteriaResponse {
	ok: true;
	kind: "preview";
	criteriaPath: string;
	groundTruthNote: string;
	criteria: Array<{ id: string; name: string; description: string }>;
}

/** Preflight capability probe (ticket 06): one real scoring call that the
 * backend must answer with discriminating A-T score-token logprobs. */
export interface VerifierProbeRequest {
	/** Plain library model id (provider prefix / `:thinking` already stripped). */
	model: string;
	thinking?: string | null;
	/** Absolute path of the criteria file (validated, first criterion used). */
	criteriaPath: string;
	/** Verifier profile env block (credentials), merged over the process env. */
	env?: Record<string, string>;
	/** Test seam: run the probe against the mock backend instead of a real one. */
	mockVerifier?: MockVerifierConfig | null;
}

export interface VerifierProbeResponse {
	ok: true;
	kind: "probe";
	model: string;
	thinking: string | null;
	coverage: { scoreA: string[]; scoreB: string[] };
	canary: { goodScore: number; badScore: number; margin: number };
	usage: VerifierUsage;
	elapsedMs: number;
}

/** SPEC: the score cache lives at `<run-dir>/cache.json`. */
export function defaultVerifierCachePath(runDir: string): string {
	return join(runDir, "cache.json");
}

export interface RunBridgeOptions {
	/** Interpreter override (tests inject fakes); defaults to the managed venv python. */
	python?: string;
	/** Working directory for the bridge process (keep it away from ambient .env files). */
	cwd?: string;
	/** Wall-clock cap for the whole bridge process. Default 15 minutes. */
	timeoutMs?: number;
	/** Cancellation; aborting kills the bridge process group. */
	signal?: AbortSignal;
	/** Environment the bridge process sees; defaults to the current process env. */
	baseEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;

interface RawOutcome {
	response: unknown | null;
	parseError: string | null;
	exitCode: number | null;
	signalName: string | null;
	processError: string | null;
	stderrTail: string;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid == null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Already dead.
		}
	}
}

async function runRunnerProcess(request: object, options: RunBridgeOptions): Promise<RawOutcome> {
	let python: string;
	if (options.python) {
		python = options.python;
	} else {
		try {
			python = ensureVerifierRuntime().python;
		} catch (error) {
			if (error instanceof VerifierRuntimeError) {
				throw new VerifierBridgeError("runtime", error.message, { detail: { repairSteps: error.repairSteps } });
			}
			throw error;
		}
	}

	let child: ChildProcess;
	try {
		child = spawn(python, [RUNNER_SCRIPT_PATH], {
			stdio: ["pipe", "pipe", "pipe"],
			env: verifierBridgeBaseEnv(options.baseEnv ?? process.env),
			cwd: options.cwd,
			detached: true,
		});
	} catch (error) {
		throw new VerifierBridgeError("spawn", `failed to start the verifier bridge (${python}): ${(error as Error).message}`);
	}

	let stdout = "";
	let stderr = "";
	let stdoutCapped = false;
	const exitWaiters: Array<() => void> = [];
	let exited = false;
	let exitCode: number | null = null;
	let signalName: string | null = null;
	let killedReason: "timeout" | "cancelled" | null = null;
	let killTimer: NodeJS.Timeout | null = null;
	let processError: string | null = null;

	child.stdout?.on("data", (chunk: Buffer) => {
		if (stdout.length < STDOUT_CAP) stdout += chunk.toString("utf8");
		else stdoutCapped = true;
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL * 2);
	});
	child.on("error", (error) => {
		// Spawn failures (ENOENT) surface here rather than via throw, and
		// failed spawns never emit "exit" — resolve on "close" instead.
		processError = error.message;
	});
	child.on("close", (code, signal) => {
		exited = true;
		exitCode = code;
		signalName = signal;
		for (const notify of exitWaiters.splice(0)) notify();
	});

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => {
		killedReason = "timeout";
		killProcessGroup(child, "SIGTERM");
		killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 5000);
	}, timeoutMs);
	const onAbort = () => {
		if (killedReason) return;
		killedReason = "cancelled";
		killProcessGroup(child, "SIGTERM");
		killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 5000);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		child.stdin?.write(`${JSON.stringify(request)}\n`);
		child.stdin?.end();
	} catch {
		// Child died before we could write; the exit path reports it.
	}

	if (!exited) {
		await new Promise<void>((resolve) => {
			exitWaiters.push(resolve);
			if (exited) resolve();
		});
	}
	clearTimeout(timer);
	if (killTimer) clearTimeout(killTimer);
	options.signal?.removeEventListener("abort", onAbort);

	if (killedReason === "timeout") {
		throw new VerifierBridgeError("timeout", `verifier bridge exceeded its ${timeoutMs}ms deadline and was killed`, {
			stderrTail: stderr.slice(-STDERR_TAIL),
		});
	}
	if (killedReason === "cancelled") {
		throw new VerifierBridgeError("cancelled", "verifier bridge was cancelled; the process group was killed", {
			stderrTail: stderr.slice(-STDERR_TAIL),
		});
	}
	if (processError) {
		throw new VerifierBridgeError("spawn", `verifier bridge process failed to start (${python}): ${processError}`);
	}

	let response: unknown = null;
	let parseError: string | null = null;
	const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
	if (lines.length === 1 && !stdoutCapped) {
		try {
			response = JSON.parse(lines[0]);
		} catch (error) {
			parseError = `stdout was not one JSON line: ${(error as Error).message}`;
		}
	} else {
		parseError = stdoutCapped
			? "stdout exceeded the protocol cap"
			: `expected exactly one NDJSON response line, got ${lines.length}`;
	}
	return { response, parseError, exitCode, signalName, processError, stderrTail: stderr.slice(-STDERR_TAIL) };
}

function throwMappedError(outcome: RawOutcome, fallbackKind: VerifierBridgeErrorKind, context: string): never {
	const response = outcome.response as { ok?: boolean; error?: { kind?: string; message?: string } } | null;
	if (response && response.ok === false && response.error && typeof response.error.kind === "string") {
		const kind = response.error.kind as VerifierBridgeErrorKind;
		throw new VerifierBridgeError(kind, response.error.message ?? "(no message)", {
			exitCode: outcome.exitCode,
			stderrTail: outcome.stderrTail,
		});
	}
	const detail = outcome.parseError ? { protocol: outcome.parseError } : undefined;
	const suffix = outcome.stderrTail ? `\nstderr tail:\n${outcome.stderrTail}` : "";
	const signal = outcome.signalName ? ` (signal ${outcome.signalName})` : "";
	throw new VerifierBridgeError(fallbackKind, `${context}: bridge exited with code ${outcome.exitCode}${signal}${suffix}`, {
		exitCode: outcome.exitCode,
		detail,
		stderrTail: outcome.stderrTail,
	});
}

function codeToKind(code: number | null): VerifierBridgeErrorKind {
	switch (code) {
		case RUNNER_EXIT_CODES.malformed:
			return "malformed-request";
		case RUNNER_EXIT_CODES.credentials:
			return "credentials";
		case RUNNER_EXIT_CODES.criteria:
			return "criteria";
		case RUNNER_EXIT_CODES.halt:
		case RUNNER_EXIT_CODES.verifier:
		default:
			return "verifier-error";
		case RUNNER_EXIT_CODES.capability:
			return "capability";
	}
}

function assertSelectRequest(request: VerifierSelectRequest): void {
	const problems: string[] = [];
	if (!request.problem?.trim()) problems.push("problem must be a non-empty string");
	if (!Array.isArray(request.candidates) || request.candidates.length === 0) {
		problems.push("candidates must be a non-empty array");
	} else {
		request.candidates.forEach((trace, index) => {
			if (typeof trace !== "string" || !trace.trim()) problems.push(`candidates[${index}] must be a non-empty string`);
		});
	}
	if (!request.criteriaPath?.trim()) problems.push("criteriaPath must be a non-empty string");
	if (!request.model?.trim()) problems.push("model must be a non-empty string");
	if (problems.length > 0) {
		throw new VerifierBridgeError("malformed-request", `invalid select request: ${problems.join("; ")}`);
	}
}

function validateSelectResponse(response: unknown, candidateCount: number): VerifierSelectResponse {
	const r = response as Partial<VerifierSelectResponse> | null;
	const problems: string[] = [];
	if (!r || r.ok !== true || r.kind !== "select") problems.push("response is not an ok select result");
	if (
		typeof r?.winnerIndex !== "number" ||
		!Number.isInteger(r.winnerIndex) ||
		r.winnerIndex < 0 ||
		r.winnerIndex >= candidateCount
	) {
		problems.push("winnerIndex is not a valid candidate index");
	}
	if (!Array.isArray(r?.ranking) || r.ranking.length !== candidateCount || new Set(r.ranking).size !== candidateCount) {
		problems.push("ranking is not a permutation of the candidate indices");
	}
	if (!Array.isArray(r?.scores) || r.scores.length !== candidateCount || r.scores.some((s) => typeof s !== "number")) {
		problems.push("scores must be one number per candidate");
	}
	if (!Array.isArray(r?.criteria) || r.criteria.length === 0 || r.criteria.some((c) => typeof c !== "string" || !c)) {
		problems.push("criteria must be a non-empty string array");
	}
	if (typeof r?.nComparisons !== "number" || typeof r?.expectedComparisons !== "number") {
		problems.push("comparison counts missing");
	}
	if (typeof r?.model !== "string" || !r.model) problems.push("model echo missing");
	if (!r?.usage || typeof r.usage.calls !== "number") problems.push("usage block missing");
	if (problems.length > 0) {
		throw new VerifierBridgeError("protocol", `select response failed validation: ${problems.join("; ")}`);
	}
	return r as VerifierSelectResponse;
}

function buildSelectPayload(request: VerifierSelectRequest): Record<string, unknown> {
	const nEvaluations = request.nEvaluations ?? (request.benchmark ? 8 : 4);
	return {
		kind: "select",
		problem: request.problem,
		candidates: request.candidates,
		criteriaPath: request.criteriaPath,
		model: request.model,
		thinking: request.thinking ?? null,
		nEvaluations,
		pivots: request.pivots ?? 2,
		seed: request.seed ?? 0,
		maxWorkers: request.maxWorkers ?? null,
		cachePath: request.cachePath ?? null,
		env: request.env ?? {},
		mockVerifier: request.mockVerifier ?? null,
	};
}

export async function runVerifierSelect(
	request: VerifierSelectRequest,
	options: RunBridgeOptions = {},
): Promise<VerifierSelectResponse> {
	assertSelectRequest(request);
	const outcome = await runRunnerProcess(buildSelectPayload(request), options);
	if (outcome.response && (outcome.response as { ok?: boolean }).ok === true && outcome.exitCode === 0) {
		return validateSelectResponse(outcome.response, request.candidates.length);
	}
	throwMappedError(outcome, codeToKind(outcome.exitCode), "verifier select failed");
}

export async function previewVerifierCriteria(
	criteriaPath: string,
	options: RunBridgeOptions = {},
): Promise<PreviewCriteriaResponse> {
	if (!criteriaPath?.trim()) {
		throw new VerifierBridgeError("malformed-request", "criteriaPath must be a non-empty string");
	}
	const outcome = await runRunnerProcess({ kind: "preview", criteriaPath }, options);
	const response = outcome.response as Partial<PreviewCriteriaResponse> | null;
	if (response && response.ok === true && response.kind === "preview" && outcome.exitCode === 0) {
		if (!Array.isArray(response.criteria) || response.criteria.length === 0) {
			throw new VerifierBridgeError("protocol", "preview response carried no criteria");
		}
		return response as PreviewCriteriaResponse;
	}
	throwMappedError(outcome, codeToKind(outcome.exitCode), "criteria preview failed");
}

function assertProbeRequest(request: VerifierProbeRequest): void {
	const problems: string[] = [];
	if (!request.model?.trim()) problems.push("model must be a non-empty string");
	if (!request.criteriaPath?.trim()) problems.push("criteriaPath must be a non-empty string");
	if (problems.length > 0) {
		throw new VerifierBridgeError("malformed-request", `invalid probe request: ${problems.join("; ")}`);
	}
}

function validateProbeResponse(response: unknown): VerifierProbeResponse {
	const r = response as Partial<VerifierProbeResponse> | null;
	const problems: string[] = [];
	if (!r || r.ok !== true || r.kind !== "probe") problems.push("response is not an ok probe result");
	if (typeof r?.model !== "string" || !r.model) problems.push("model echo missing");
	const coverage = r?.coverage as Partial<VerifierProbeResponse["coverage"]> | undefined;
	if (
		!Array.isArray(coverage?.scoreA) ||
		coverage.scoreA.length === 0 ||
		!Array.isArray(coverage?.scoreB) ||
		coverage.scoreB.length === 0
	) {
		problems.push("coverage block missing");
	}
	const canary = r?.canary as Partial<VerifierProbeResponse["canary"]> | undefined;
	if (
		typeof canary?.goodScore !== "number" ||
		typeof canary?.badScore !== "number" ||
		typeof canary?.margin !== "number"
	) {
		problems.push("canary block missing");
	}
	if (!r?.usage || typeof r.usage.calls !== "number") problems.push("usage block missing");
	if (problems.length > 0) {
		throw new VerifierBridgeError("protocol", `probe response failed validation: ${problems.join("; ")}`);
	}
	return r as VerifierProbeResponse;
}

/**
 * Preflight capability probe (ticket 06): one real scoring call against the
 * configured backend. Fails closed (kind "capability") when the backend
 * exposes no usable A-T score-token logprobs or when the deterministic
 * good-vs-bad canary does not rank the good trace higher.
 */
export async function runVerifierProbe(
	request: VerifierProbeRequest,
	options: RunBridgeOptions = {},
): Promise<VerifierProbeResponse> {
	assertProbeRequest(request);
	const payload = {
		kind: "probe",
		model: request.model,
		thinking: request.thinking ?? null,
		criteriaPath: request.criteriaPath,
		env: request.env ?? {},
		mockVerifier: request.mockVerifier ?? null,
	};
	const outcome = await runRunnerProcess(payload, options);
	if (outcome.response && (outcome.response as { ok?: boolean }).ok === true && outcome.exitCode === 0) {
		return validateProbeResponse(outcome.response);
	}
	throwMappedError(outcome, codeToKind(outcome.exitCode), "verifier capability probe failed");
}
