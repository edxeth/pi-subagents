import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assert, createTestDir } from "../support/index.ts";
import {
	BUILTIN_VERIFIER_CRITERIA_NAMES,
	DEFAULT_VERIFIER_CANDIDATES,
	VerifierCriteriaError,
	VERIFIER_CANDIDATES_ENV_VAR,
	getPackagedCriteriaDir,
	resolveVerifierCandidateCount,
	resolveVerifierCriteria,
	resolveVerifiedFanOutLaunch,
} from "../../src/vf/criteria.ts";
import { ensureVerifierRuntime } from "../../src/vf/verifier/venv.ts";
import { previewVerifierCriteria } from "../../src/vf/verifier/bridge.ts";

describe("verifier criteria resolution (ticket 10)", () => {
	const dir = createTestDir();
	let python: string | undefined;
	const savedVenvRoot = process.env.PI_SUBAGENT_LLM_VERIFIER_VENV;

	before(async () => {
		// One private venv for the real-library preview checks below.
		process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = join(dir, "venv");
		python = ensureVerifierRuntime().python;
	});

	after(() => {
		if (savedVenvRoot === undefined) delete process.env.PI_SUBAGENT_LLM_VERIFIER_VENV;
		else process.env.PI_SUBAGENT_LLM_VERIFIER_VENV = savedVenvRoot;
	});

	it("resolves each built-in name to a real packaged rubric at an absolute path", () => {
	for (const name of BUILTIN_VERIFIER_CRITERIA_NAMES) {
		const resolved = resolveVerifierCriteria(name, "/tmp");
		assert.equal(resolved.kind, "builtin");
		assert.equal(resolved.name, name);
		assert.equal(resolved.path, join(getPackagedCriteriaDir(), `${name}.md`));
		assert.ok(isAbsolute(resolved.path), `${name} must resolve to an absolute path`);
		assert.ok(existsSync(resolved.path), `${resolved.path} must exist`);
		assert.ok(statSync(resolved.path).isFile(), `${resolved.path} must be a file`);
		assert.equal(resolved.default, false);
	}
	});

	it("resolves a path value against the launch cwd and keeps absolute paths as-is", () => {
	writeFileSync(join(dir, "rubric.md"), "# Rubric\n\n## Criteria\n\n### A {#a}\n\nBody.\n");
	mkdirSync(join(dir, "nested"), { recursive: true });
	writeFileSync(join(dir, "nested", "abs.md"), "# Rubric\n\n## Criteria\n\n### A {#a}\n\nBody.\n");

	const relative = resolveVerifierCriteria("rubric.md", dir);
	assert.equal(relative.kind, "path");
	assert.equal(relative.path, join(dir, "rubric.md"));
	assert.equal(relative.default, false);

	const absolute = resolveVerifierCriteria(join(dir, "nested", "abs.md"), "/somewhere/else");
	assert.equal(absolute.path, join(dir, "nested", "abs.md"));
	});

	it("fails closed on an unresolvable criteria file before any spend", () => {
	assert.throws(() => resolveVerifierCriteria("missing.md", dir), (error: Error) => {
		assert.ok(error instanceof VerifierCriteriaError);
		assert.ok(error.message.includes(join(dir, "missing.md")), `message names the tried path: ${error.message}`);
		assert.ok(error.message.includes("generic"), `message lists built-in names: ${error.message}`);
		return true;
	});
	// A directory is not a criteria file.
	assert.throws(() => resolveVerifierCriteria("nested", dir), /is not a file/);
	// An empty file would only explode inside the paid verifier call.
	writeFileSync(join(dir, "empty.md"), "");
	assert.throws(() => resolveVerifierCriteria("empty.md", dir), /empty/);
	// A near-miss built-in name is treated as a path, and the error says so.
	assert.throws(() => resolveVerifierCriteria("code_change", dir), /generic/);
	});

	it("defaults to the packaged generic rubric when no value is set", () => {
	const resolved = resolveVerifierCriteria(undefined, dir);
	assert.equal(resolved.kind, "builtin");
	assert.equal(resolved.name, "generic");
	assert.equal(resolved.default, true);
	});

	it("resolves the candidate count as explicit > env > default, validating the env value", () => {
	const env: NodeJS.ProcessEnv = {};
	assert.equal(resolveVerifierCandidateCount(undefined, env), DEFAULT_VERIFIER_CANDIDATES);
	assert.equal(resolveVerifierCandidateCount(7, env), 7);
	env[VERIFIER_CANDIDATES_ENV_VAR] = "5";
	assert.equal(resolveVerifierCandidateCount(undefined, env), 5);
	assert.equal(resolveVerifierCandidateCount(7, env), 7);
	for (const bad of ["1", "0", "-2", "2.5", "three"]) {
		env[VERIFIER_CANDIDATES_ENV_VAR] = bad;
		assert.throws(
			() => resolveVerifierCandidateCount(undefined, env),
			/PI_SUBAGENT_LLM_VERIFIER_CANDIDATES must be an integer >= 2/,
		);
	}
	});

	it("combines count, model override, and criteria into one pre-flight seam", () => {
	const resolved = resolveVerifiedFanOutLaunch(
		{
			llmAsVerifierCandidates: 4,
			llmAsVerifierModel: "deepseek/deepseek-v4-flash:high",
			llmAsVerifierCriteria: "research",
		},
		dir,
		{},
	);
	assert.deepEqual(resolved, {
		candidates: 4,
		modelOverride: "deepseek/deepseek-v4-flash:high",
		criteria: resolveVerifierCriteria("research", dir),
	});

	const defaulted = resolveVerifiedFanOutLaunch({}, dir, {});
	assert.equal(defaulted.candidates, DEFAULT_VERIFIER_CANDIDATES);
	assert.equal(defaulted.modelOverride, null);
	assert.equal(defaulted.criteria.name, "generic");

	assert.throws(() => resolveVerifiedFanOutLaunch({ llmAsVerifierCriteria: "missing.md" }, dir, {}), /missing\.md/);
	assert.throws(
			() => resolveVerifiedFanOutLaunch({ llmAsVerifierCandidates: 1 }, dir, {}),
			/must be an integer >= 2/,
		);
	});

	it("packaged rubrics pass the real library criteria preview (no API key)", async () => {
	assert.ok(python, "venv must be provisioned before previewing");
	for (const name of BUILTIN_VERIFIER_CRITERIA_NAMES) {
		const { path } = resolveVerifierCriteria(name, dir);
		const preview = await previewVerifierCriteria(path, {
			python,
			cwd: dir,
			baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" },
		});
		assert.strictEqual(preview.kind, "preview");
		assert.match(preview.groundTruthNote, /Do NOT trust the agent's self-assessment or claims of success/);
		assert.ok(preview.criteria.length >= 2, `${name} must carry at least two narrow criteria`);
		assert.ok(
			preview.criteria.every((criterion) => criterion.id && criterion.description),
			`${name} criteria must all parse with ids and instructions`,
		);
	}
	});
});
