import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { assert, createTestDir, join } from "../support/index.ts";
import type { MockVerifierConfig, RunBridgeOptions } from "../../src/vf/verifier/bridge.ts";
import {
	defaultVerifierCachePath,
	previewVerifierCriteria,
	runVerifierSelect,
	runVerifierProbe,
	verifierBridgeBaseEnv,
	VerifierBridgeError,
} from "../../src/vf/verifier/bridge.ts";
import {
	ensureVerifierRuntime,
	LLM_VERIFIER_VERSION,
	RUNNER_SCRIPT_PATH,
	VerifierRuntimeError,
} from "../../src/vf/verifier/venv.ts";

const CRITERIA = `# Test rubric

## Ground Truth Note

Do NOT trust the agent's self-assessment or claims of success.

## Criteria

### Correctness {#correctness}

Does the trace show the task actually completed?

### Verification {#verification}

Did the agent verify the result with a real command?
`;

const TRACES = [
	"[Command] echo done-marker-good\n[Output] done-marker-good\n✅ verified",
	"[Command] echo mid\n[Output] mid-marker",
	"[Command] false\n[Output] crashed",
];

function minimalEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		LANG: "C.UTF-8",
	};
}

/** A fake "interpreter": an executable script standing in for the venv python. */
function writeFake(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, `#!/usr/bin/env python3\n${body}`);
	chmodSync(path, 0o755);
	return path;
}

describe("managed verifier venv", () => {
	const savedRoot = process.env.PI_SUBAGENT_LLM_VERIFIER_VENV;
	const root = createTestDir();

	after(() => {
		if (savedRoot === undefined) delete process.env.PI_SUBAGENT_LLM_VERIFIER_VENV;
		else process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = savedRoot;
	});

	it("provisions a pinned, validated venv (uv preferred, python3-venv fallback) and reports repair steps on failure", () => {
		process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = join(root, "venv-a");
		const info = ensureVerifierRuntime();
		assert.strictEqual(info.version, LLM_VERIFIER_VERSION);
		assert.ok(info.provisioner === "uv" || info.provisioner === "python3-venv");
		assert.strictEqual(info.reused, false);
		assert.ok(existsSync(join(info.root, "marker.json")));
		const probe = spawnSync(info.python, ["-c", "import llm_verifier; print(llm_verifier.__version__)"], {
			env: minimalEnv(),
		});
		assert.strictEqual(probe.status, 0, probe.stderr?.toString());
		assert.strictEqual(probe.stdout.toString().trim(), LLM_VERIFIER_VERSION);
	});

	it("reuses the existing venv without reinstalling", () => {
		process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = join(root, "venv-a");
		const info = ensureVerifierRuntime();
		assert.strictEqual(info.reused, true);
	});

	it("re-provisions on version drift (stale marker)", () => {
		const driftRoot = join(root, "venv-drift");
		process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = driftRoot;
		mkdirSync(driftRoot, { recursive: true });
		writeFileSync(join(driftRoot, "marker.json"), JSON.stringify({ version: "0.0.0", provisioner: "uv", createdAt: "x" }));
		const info = ensureVerifierRuntime();
		assert.strictEqual(info.reused, false);
		assert.strictEqual(info.version, LLM_VERIFIER_VERSION);
	});

	it("reports exact repair steps when install fails", () => {
		const badRoot = join(root, "venv-bad");
		process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = badRoot;
		mkdirSync(badRoot, { recursive: true });
		// No interpreter on PATH: neither uv nor python3 can be found, so
		// provisioning must fail closed with actionable repair steps.
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		assert.throws(
			() => ensureVerifierRuntime(),
			(error: unknown) => {
				assert.ok(error instanceof VerifierRuntimeError);
				assert.ok(error.repairSteps.length >= 1);
				assert.match(error.message, /venv/);
				assert.match(error.repairSteps.join("\n"), /python3-venv|venv|uv/);
				return true;
			},
		);
		process.env.PATH = savedPath;
	});
});

describe("verifier bridge (NDJSON one-shot)", () => {
	const dir = createTestDir();
	let python: string;
	const criteriaPath = join(dir, "criteria.md");

	before(() => {
		writeFileSync(criteriaPath, CRITERIA);
		// Use the same managed-venv machinery, rooted in the test dir so the
		// suite never mutates the user's real venv root.
		const saved = process.env.PI_SUBAGENT_LLM_VERIFIER_VENV;
		process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = join(dir, "venvroot");
		try {
			python = ensureVerifierRuntime().python;
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_LLM_VERIFIER_VENV;
			else process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = saved;
		}
	});

	it("strips the library control vars from the inherited environment", () => {
		const env = verifierBridgeBaseEnv({
			PATH: "/usr/bin",
			OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
			OPENAI_API_KEY: "sk-or",
			DEEPSEEK_API_KEY: "sk-ds",
			VERTEX_API_KEY: "vtx",
			DEEPSEEK_EFFORT: "max",
			DEEPSEEK_MAX_TOKENS: "1",
		});
		assert.equal(env.PATH, "/usr/bin");
		for (const name of [
			"OPENAI_BASE_URL",
			"OPENAI_API_KEY",
			"DEEPSEEK_API_KEY",
			"VERTEX_API_KEY",
			"DEEPSEEK_EFFORT",
			"DEEPSEEK_MAX_TOKENS",
		]) {
			assert.equal(name in env, false, name);
		}
	});

	function options(extra: RunBridgeOptions = {}): RunBridgeOptions {
		return { python, cwd: dir, baseEnv: minimalEnv(), ...extra };
	}

	function mockConfig(extra: MockVerifierConfig = {}): MockVerifierConfig {
		return { goodMarker: "done-marker-good", midMarker: "mid-marker", ...extra };
	}

	function cachePath(name: string): string {
		return join(dir, `cache-${name}.json`);
	}

	it("maps a select result to winner index + ranking + usage and echoes the model", async () => {
		const response = await runVerifierSelect(
			{
				problem: "finish the task",
				candidates: TRACES,
				criteriaPath,
				model: "deepseek-v4-flash",
				thinking: "high",
				cachePath: cachePath("select"),
				mockVerifier: mockConfig({ logFile: join(dir, "calls-select.jsonl") }),
			},
			options(),
		);
		assert.strictEqual(response.ok, true);
		assert.strictEqual(response.model, "deepseek-v4-flash");
		assert.strictEqual(response.thinking, "high");
		assert.strictEqual(response.winnerIndex, 0);
		assert.strictEqual(response.ranking[0], 0);
		assert.strictEqual(response.ranking.length, 3);
		assert.deepStrictEqual(response.criteria, ["correctness", "verification"]);
		// SPEC cost formula: N + k(N-k) + C(k,2) = 3 + 2·1 + 1 = 6.
		assert.strictEqual(response.nComparisons, 6);
		assert.strictEqual(response.expectedComparisons, 6);
		assert.ok(response.usage.calls > 0);
		assert.ok(response.cache && response.cache.bytes > 0);
		// The trace with the failure marker must rank last.
		assert.strictEqual(response.ranking[response.ranking.length - 1], 2);
		assert.ok(response.scores[0] > response.scores[2]);
	});

	it("sends the configured model to every backend call and honors n_evaluations", async () => {
		const log = join(dir, "calls-model.jsonl");
		await runVerifierSelect(
			{
				problem: "p",
				candidates: TRACES.slice(0, 2),
				criteriaPath,
				model: "test-model-x",
				cachePath: cachePath("model-k4"),
				mockVerifier: mockConfig({ logFile: log }),
			},
			options(),
		);
		const callsK4 = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { model: string });
		// n=2: ring = 2 directed pairs; the pivot-round pair (0,1) is already
		// a ring cache key, so only the ring pair (1,0) spends calls — plus
		// its swapped reps. Cached directed pairs never re-call.
		assert.strictEqual(callsK4.length, 16);
		for (const call of callsK4) assert.strictEqual(call.model, "test-model-x");

		const log8 = join(dir, "calls-model-8.jsonl");
		await runVerifierSelect(
			{
				problem: "p",
				candidates: TRACES.slice(0, 2),
				criteriaPath,
				model: "test-model-x",
				benchmark: true,
				cachePath: cachePath("model-k8"),
				mockVerifier: mockConfig({ logFile: log8 }),
			},
			options(),
		);
		const callsK8 = readFileSync(log8, "utf8").trim().split("\n");
		assert.strictEqual(callsK8.length, 32);
	});

	it("reuses the score cache across runs (second run makes zero calls)", async () => {
		const log = join(dir, "calls-cache.jsonl");
		const shared = cachePath("shared");
		const request = {
			problem: "p",
			candidates: TRACES.slice(0, 2),
			criteriaPath,
			model: "deepseek-v4-flash",
			cachePath: shared,
			mockVerifier: mockConfig({ logFile: log }),
		} as const;
		const first = await runVerifierSelect({ ...request }, options());
		assert.ok(first.cache);
		const sizeAfterFirst = first.cache.bytes;
		const second = await runVerifierSelect({ ...request }, options());
		assert.strictEqual(second.cache?.bytes, sizeAfterFirst);
		// No new backend calls: the log still holds only the first run's lines.
		const calls = readFileSync(log, "utf8").trim().split("\n");
		assert.strictEqual(calls.length, 16);
		assert.deepStrictEqual(second.ranking, first.ranking);
	});

	it("fails closed with a typed error when no credentials are configured", async () => {
	await assert.rejects(
		runVerifierSelect(
			{
				problem: "p",
				candidates: TRACES,
				criteriaPath,
				model: "deepseek-v4-flash",
				cachePath: cachePath("nocreds"),
			},
			options(),
		),
		(error: unknown) => {
			assert.ok(error instanceof VerifierBridgeError);
			assert.strictEqual(error.kind, "credentials");
			assert.match(error.message, /DEEPSEEK_API_KEY/);
			return true;
		},
		);
	});

	it("probe fails with the same typed credentials error before any client is built", async () => {
		// Found live: the probe built the library client before the backend
		// check, so a missing key surfaced as a raw Python traceback
		// (verifier-failed) instead of the clean credentials failure.
		await assert.rejects(
			runVerifierProbe(
				{
					model: "deepseek-v4-flash",
					thinking: null,
					criteriaPath,
					env: {},
					mockVerifier: null,
				},
				options(),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "credentials");
				assert.match(error.message, /no verifier credentials/);
				assert.match(error.message, /DEEPSEEK_API_KEY/);
				return true;
			},
		);
	});

	it("propagates backend failures (on_error=raise) as verifier errors, never a winner", async () => {
		await assert.rejects(
			runVerifierSelect(
				{
					problem: "p",
					candidates: TRACES,
					criteriaPath,
					model: "deepseek-v4-flash",
					cachePath: cachePath("failing"),
					mockVerifier: mockConfig({ failCalls: true }),
				},
				options(),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "verifier-error");
				assert.match(error.message, /mock verifier backend failure/);
				return true;
			},
		);
	});

	it("aborts before any spend on a missing or malformed criteria file (typed criteria error)", async () => {
		for (const [name, content] of [
			["missing.md", null],
			["empty.md", "# nothing here\n"],
		] as const) {
			const path = join(dir, name);
			if (content !== null) writeFileSync(path, content);
			await assert.rejects(
				runVerifierSelect(
					{
						problem: "p",
						candidates: TRACES,
						criteriaPath: path,
						model: "deepseek-v4-flash",
						cachePath: cachePath(name),
						mockVerifier: mockConfig(),
					},
					options(),
				),
				(error: unknown) => {
					assert.ok(error instanceof VerifierBridgeError);
					assert.strictEqual(error.kind, "criteria");
					return true;
				},
			);
		}
	});

	it("rejects malformed requests before starting the interpreter", async () => {
		await assert.rejects(
			runVerifierSelect(
				{
					problem: "p",
					candidates: ["", "x"],
					criteriaPath,
					model: "m",
					mockVerifier: mockConfig(),
				},
				options({ python: "/nonexistent/interpreter" }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "malformed-request");
				return true;
			},
		);
		await assert.rejects(
			runVerifierSelect({ problem: "", candidates: ["a"], criteriaPath, model: "m" }, options()),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "malformed-request");
				return true;
			},
		);
	});

	it("halts without a winner on comparison-count or cache assertions", async () => {
		// A single candidate never writes a cache file and reports zero
		// comparisons against a nonzero expectation — the runner must halt
		// (exit 5) instead of fabricating a winner.
		await assert.rejects(
			runVerifierSelect(
				{
					problem: "p",
					candidates: ["only one trace"],
					criteriaPath,
					model: "deepseek-v4-flash",
					cachePath: cachePath("single"),
					mockVerifier: mockConfig(),
				},
				options(),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.ok(error.kind === "comparison-count" || error.kind === "cache");
				assert.match(error.message, /halting without a winner/);
				return true;
			},
		);
	});

	it("enforces the deadline with process-group kill", async () => {
		await assert.rejects(
			runVerifierSelect(
				{
					problem: "p",
					candidates: TRACES.slice(0, 2),
					criteriaPath,
					model: "deepseek-v4-flash",
					cachePath: cachePath("slow"),
					maxWorkers: 1,
					mockVerifier: mockConfig({ sleepSeconds: 30 }),
				},
				options({ timeoutMs: 2000 }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "timeout");
				return true;
			},
		);
	});

	it("supports cancellation via AbortSignal (process group killed)", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1500);
		await assert.rejects(
			runVerifierSelect(
				{
					problem: "p",
					candidates: TRACES.slice(0, 2),
					criteriaPath,
					model: "deepseek-v4-flash",
					cachePath: cachePath("cancel"),
					maxWorkers: 1,
					mockVerifier: mockConfig({ sleepSeconds: 30 }),
				},
				options({ signal: controller.signal }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "cancelled");
				return true;
			},
		);
	});

	it("surfaces protocol violations from a broken bridge as typed errors", async () => {
		const fakeDir = join(dir, "fakes");
		mkdirSync(fakeDir, { recursive: true });
		const garbage = join(fakeDir, "garbage.py");
		writeFake(fakeDir, "garbage.py", 'print("this is not json")\n');
		await assert.rejects(
			runVerifierSelect(
				{ problem: "p", candidates: ["a", "b"], criteriaPath, model: "m", mockVerifier: mockConfig() },
				options({ python: garbage }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "verifier-error");
				assert.match(error.message, /code 0/);
				assert.match(error.detail?.protocol as string, /not one JSON line/);
				return true;
			},
		);

		const multiLine = join(fakeDir, "multi.py");
		writeFake(fakeDir, "multi.py", 'print("{}")\nprint("{}")\n');
		await assert.rejects(
			runVerifierSelect(
				{ problem: "p", candidates: ["a", "b"], criteriaPath, model: "m", mockVerifier: mockConfig() },
				options({ python: multiLine }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "verifier-error");
				assert.match(error.detail?.protocol as string, /got 2/);
				return true;
			},
		);

		const haltResponse = join(fakeDir, "halt.py");
		writeFake(
			fakeDir,
			"halt.py",
			'import json,sys\nsys.stdout.write(json.dumps({"ok": False, "error": {"kind": "cache", "message": "halt: cache empty"}}) + "\\n")\nsys.exit(5)\n',
		);
		await assert.rejects(
			runVerifierSelect(
				{ problem: "p", candidates: ["a", "b"], criteriaPath, model: "m", mockVerifier: mockConfig() },
				options({ python: haltResponse }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "cache");
				assert.strictEqual(error.exitCode, 5);
				return true;
			},
		);

		await assert.rejects(
			runVerifierSelect(
				{ problem: "p", candidates: ["a", "b"], criteriaPath, model: "m", mockVerifier: mockConfig() },
				options({ python: join(fakeDir, "does-not-exist.py") }),
			),
			(error: unknown) => {
				assert.ok(error instanceof VerifierBridgeError);
				assert.strictEqual(error.kind, "spawn");
				return true;
			},
		);
	});

	it("previews a criteria file (parsed ids + ground-truth note) and fails typed on a bad one", async () => {
		const preview = await previewVerifierCriteria(criteriaPath, options());
		assert.strictEqual(preview.kind, "preview");
		assert.deepStrictEqual(preview.criteria.map((c) => c.id), ["correctness", "verification"]);
		assert.match(preview.groundTruthNote, /Do NOT trust/);
		await assert.rejects(previewVerifierCriteria(join(dir, "nope.md"), options()), (error: unknown) => {
			assert.ok(error instanceof VerifierBridgeError);
			assert.strictEqual(error.kind, "criteria");
			return true;
		});
	});

	it("defaults the score cache to <run-dir>/cache.json", () => {
		assert.strictEqual(defaultVerifierCachePath("/runs/r1"), join("/runs/r1", "cache.json"));
	});

	it("cache assertion halts on missing/empty/garbage caches (upstream issue #14 shape)", () => {
		// Drive the runner's cache validator directly through the real
		// interpreter: a silent cache-write failure must read as a halt,
		// never as a completed selection.
		const good = join(dir, "cache-good.json");
		writeFileSync(good, JSON.stringify({ "k|task|0,1|0": { score_A: 1, score_B: 0 } }));
		const empty = join(dir, "cache-empty.json");
		writeFileSync(empty, "");
		const garbage = join(dir, "cache-garbage.json");
		writeFileSync(garbage, "{not json");
		const runnerDir = RUNNER_SCRIPT_PATH.slice(0, RUNNER_SCRIPT_PATH.lastIndexOf("/"));
		const script = `import json,sys
sys.path.insert(0, ${JSON.stringify(runnerDir)})
import runner
cases = [${JSON.stringify(good)}, ${JSON.stringify(empty)}, ${JSON.stringify(garbage)}, ${JSON.stringify(join(dir, "cache-absent.json"))}]
print(json.dumps([runner.inspect_cache(path) for path in cases]))
`;
		const probe = spawnSync(python, ["-c", script], {
			encoding: "utf8",
			env: { ...minimalEnv(), PYTHONDONTWRITEBYTECODE: "1" },
		});
		assert.strictEqual(probe.status, 0, probe.stderr);
		const results = JSON.parse(probe.stdout.trim()) as Array<[boolean, string]>;
		assert.strictEqual(results[0][0], true);
		assert.match(results[0][1], /1 entries/);
		assert.strictEqual(results[1][0], false);
		assert.strictEqual(results[1][1], "empty");
		assert.strictEqual(results[2][0], false);
		assert.match(results[2][1], /unreadable/);
		assert.strictEqual(results[3][0], false);
		assert.strictEqual(results[3][1], "missing");
	});
});
