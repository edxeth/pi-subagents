import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { assert, createTestDir, join } from "../support/index.ts";
import {
	assertVerifierCredentials,
	LIBRARY_DEFAULT_VERIFIER_MODEL,
	normalizeVerifierModelRef,
	parseVerifierProfileSource,
	resolveVerifierModel,
	resolveVerifierProfile,
	VerifierCredentialError,
	VerifierProfileError,
} from "../../src/vf/verifier-profile.ts";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

function withProfileDirs(setup: {
	project?: string;
	global?: string;
}): { baseCwd: string; configDir: string } {
	const dir = createTestDir();
	const baseCwd = join(dir, "project");
	const configDir = join(dir, "config");
	mkdirSync(baseCwd, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	if (setup.project) {
		mkdirSync(join(baseCwd, ".pi", "agents", "verifiers"), { recursive: true });
		writeFileSync(join(baseCwd, ".pi", "agents", "verifiers", "default.md"), setup.project);
	}
	if (setup.global) {
		mkdirSync(join(configDir, "agents", "verifiers"), { recursive: true });
		writeFileSync(join(configDir, "agents", "verifiers", "default.md"), setup.global);
	}
	process.env.PI_CODING_AGENT_DIR = configDir;
	return { baseCwd, configDir };
}

describe("verifier profile resolution", () => {
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("ships a bundled default profile so the boolean alone works", () => {
		const { baseCwd } = withProfileDirs({});
		const profile = resolveVerifierProfile("default", baseCwd);
		assert.equal(profile.source, "bundled");
		assert.equal(profile.model, "deepseek-v4-flash");
		assert.deepEqual(profile.env, {});
	});

	it("resolves the project profile over the global one", () => {
		const { baseCwd } = withProfileDirs({
			project: "---\nmodel: proj-model\n---\n",
			global: "---\nmodel: global-model\n---\n",
		});
		const profile = resolveVerifierProfile("default", baseCwd);
		assert.equal(profile.source, "project");
		assert.equal(profile.model, "proj-model");
	});

	it("falls back to the global profile when no project profile exists", () => {
		const { baseCwd } = withProfileDirs({ global: "---\nmodel: global-model\n---\n" });
		const profile = resolveVerifierProfile("default", baseCwd);
		assert.equal(profile.source, "global");
		assert.equal(profile.model, "global-model");
	});

	it("fails closed for an unknown profile name with the searched paths", () => {
		const { baseCwd } = withProfileDirs({});
		assert.throws(() => resolveVerifierProfile("other", baseCwd), (error: Error) => {
			assert.ok(error instanceof VerifierProfileError);
			assert.match(error.message, /other\.md/);
			assert.match(error.message, /verifiers/);
			return true;
		});
	});
});

describe("verifier profile strictness (profile, not agent)", () => {
	it("accepts only model, thinking, and env", () => {
		assert.throws(
			() => parseVerifierProfileSource("t", "---\nmodel: m\ntools: read\n---\n", "project", "p.md"),
			/"tools".*must not have/s,
		);
		assert.throws(
			() => parseVerifierProfileSource("t", "---\nmodel: m\ncwd: /tmp\n---\n", "project", "p.md"),
			/"cwd".*must not have/s,
		);
		assert.throws(
			() => parseVerifierProfileSource("t", "---\nmodel: m\nsession-mode: standalone\n---\n", "project", "p.md"),
			/"session-mode".*must not have/s,
		);
	});

	it("requires a model and a frontmatter block", () => {
		assert.throws(() => parseVerifierProfileSource("t", "---\nthinking: high\n---\n", "project", "p.md"), /model/);
		assert.throws(() => parseVerifierProfileSource("t", "no frontmatter here\n", "project", "p.md"), /frontmatter/);
	});

	it("parses the env block and rejects malformed lines", () => {
		const profile = parseVerifierProfileSource(
			"t",
			"---\nmodel: m\nenv: |\n  DEEPSEEK_API_KEY=sk-x\n  # comment\n---\n",
			"project",
			"p.md",
		);
		assert.deepEqual(profile.env, { DEEPSEEK_API_KEY: "sk-x" });
		assert.throws(
			() => parseVerifierProfileSource("t", "---\nmodel: m\nenv: |\n  NOSEPARATOR\n---\n", "project", "p.md"),
			/invalid env block.*Missing '='/,
		);
	});

	it("validates thinking values from the field and the model suffix", () => {
		assert.throws(
			() => parseVerifierProfileSource("t", "---\nmodel: m\nthinking: medium\n---\n", "project", "p.md"),
			/thinking must be one of/,
		);
		assert.throws(() => parseVerifierProfileSource("t", "---\nmodel: m:turbo\n---\n", "project", "p.md"), /:thinking/);
		assert.throws(
			() =>
				parseVerifierProfileSource("t", "---\nmodel: m:high\nthinking: low\n---\n", "project", "p.md"),
			/sets thinking twice with different values/,
		);
		const agree = parseVerifierProfileSource("t", "---\nmodel: m:high\nthinking: high\n---\n", "project", "p.md");
		assert.equal(agree.thinking, "high");
	});
});

describe("verifier model ref normalization", () => {
	it("strips the provider prefix so select() gets the plain id", () => {
	const ref = normalizeVerifierModelRef("deepseek/deepseek-v4-flash");
		assert.equal(ref.modelId, "deepseek-v4-flash");
		assert.equal(ref.provider, "deepseek");
		assert.equal(ref.thinking, null);
	});

	it("translates a :thinking suffix to the library reasoning setting", () => {
		const ref = normalizeVerifierModelRef("zai/glm-5.3:max");
		assert.equal(ref.modelId, "glm-5.3");
		assert.equal(ref.thinking, "max");
		assert.equal(ref.normalizedRef, "zai/glm-5.3:max");
	});

	it("accepts a bare model id and rejects malformed refs", () => {
		assert.equal(normalizeVerifierModelRef("deepseek-v4-flash").modelId, "deepseek-v4-flash");
		assert.throws(() => normalizeVerifierModelRef("a/b/c"), /provider\/model or model/);
		assert.throws(() => normalizeVerifierModelRef("provider/"), /empty provider or model id/);
		assert.throws(() => normalizeVerifierModelRef(""), /empty/);
	});
});

describe("verifier model precedence and credentials", () => {
	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
	});

	it("uses the -model override over the default profile, inheriting its env", () => {
		const { baseCwd } = withProfileDirs({
			project: "---\nmodel: profile-model\nenv: |\n  DEEPSEEK_API_KEY=sk-profile\n---\n",
		});
		const resolved = resolveVerifierModel({
			override: "deepseek/deepseek-v4-flash:high",
			baseCwd,
			env: EMPTY_ENV,
		});
		assert.equal(resolved.model, "deepseek-v4-flash");
		assert.equal(resolved.thinking, "high");
		assert.equal(resolved.profile.source, "project");
		assert.deepEqual(resolved.env, { DEEPSEEK_API_KEY: "sk-profile" });
		assert.deepEqual(resolved.credential, { key: "DEEPSEEK_API_KEY", via: "profile-env" });
		assertVerifierCredentials(resolved, EMPTY_ENV);
	});

	it("uses the resolved default profile model when no override is set", () => {
		const { baseCwd } = withProfileDirs({ project: "---\nmodel: proj-model\n---\n" });
		const resolved = resolveVerifierModel({ baseCwd, env: { DEEPSEEK_API_KEY: "sk" } });
		assert.equal(resolved.model, "proj-model");
		assert.equal(resolved.thinking, null);
	});

	it("fails closed before candidate spend when the credential is missing", () => {
		const { baseCwd } = withProfileDirs({});
		const resolved = resolveVerifierModel({ baseCwd, env: EMPTY_ENV });
		assert.equal(resolved.model, "deepseek-v4-flash");
		assert.throws(() => assertVerifierCredentials(resolved, EMPTY_ENV), (error: Error) => {
			assert.ok(error instanceof VerifierCredentialError);
			assert.match(error.message, /DEEPSEEK_API_KEY/);
			assert.match(error.message, /never send a keyless request/);
			return true;
		});
	});

	it("accepts a process-env credential and the OPENAI_BASE_URL endpoint path", () => {
		const { baseCwd } = withProfileDirs({});
		const viaProcess = resolveVerifierModel({ baseCwd, env: { DEEPSEEK_API_KEY: "sk" } });
		assert.deepEqual(viaProcess.credential, { key: "DEEPSEEK_API_KEY", via: "process-env" });
		assertVerifierCredentials(viaProcess, { DEEPSEEK_API_KEY: "sk" });

		const viaEndpoint = resolveVerifierModel({
			override: "vllm/qwen-logprob",
			baseCwd,
			env: { OPENAI_BASE_URL: "http://localhost:8000/v1" },
		});
		assert.equal(viaEndpoint.model, "qwen-logprob");
		assert.deepEqual(viaEndpoint.credential, { key: null, via: "endpoint" });
		assertVerifierCredentials(viaEndpoint, { OPENAI_BASE_URL: "http://localhost:8000/v1" });
	});

	it("requires the Gemini credential for Gemini models", () => {
		const { baseCwd } = withProfileDirs({ project: "---\nmodel: gemini-2.5-flash\n---\n" });
		const resolved = resolveVerifierModel({ baseCwd, env: EMPTY_ENV });
		assert.deepEqual(resolved.credential, { key: "VERTEX_API_KEY", via: "not-required" });
		assert.throws(() => assertVerifierCredentials(resolved, EMPTY_ENV), /VERTEX_API_KEY/);
	});

	it("exports the library default model for the bridge fallback", () => {
		assert.equal(LIBRARY_DEFAULT_VERIFIER_MODEL, "gemini-2.5-flash");
	});
});
