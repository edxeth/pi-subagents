import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { assert, createTestDir, join } from "../support/index.ts";
import {
	normalizeVerifierModelRef,
	parseVerifierProfileSource,
	resolveVerifierModel,
	resolveVerifierProfile,
	VerifierProfileError,
} from "../../src/vf/verifier-profile.ts";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

function withProfileDirs(setup: {
	project?: string;
	global?: string;
	modelsJson?: Record<string, unknown>;
	modelsStore?: Record<string, unknown>;
	auth?: Record<string, unknown>;
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
	if (setup.modelsJson) writeFileSync(join(configDir, "models.json"), JSON.stringify(setup.modelsJson));
	if (setup.modelsStore) writeFileSync(join(configDir, "models-store.json"), JSON.stringify(setup.modelsStore));
	if (setup.auth) writeFileSync(join(configDir, "auth.json"), JSON.stringify(setup.auth));
	process.env.PI_CODING_AGENT_DIR = configDir;
	return { baseCwd, configDir };
}

function writeProfile(
	roots: { baseCwd: string; configDir: string },
	scope: "project" | "global",
	name: string,
	content: string,
): void {
	const dir = scope === "project" ? join(roots.baseCwd, ".pi", "agents", "verifiers") : join(roots.configDir, "agents", "verifiers");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), content);
}

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
});

describe("verifier profile resolution", () => {
	it("resolves the project profile over the global one", () => {
		const roots = withProfileDirs({
			project: "---\nmodel: deepseek/proj-model\n---\n",
			global: "---\nmodel: deepseek/global-model\n---\n",
		});
		assert.equal(resolveVerifierProfile("default", roots.baseCwd).model, "proj-model");
	});

	it("fails closed for an unknown profile name with the searched paths", () => {
		const roots = withProfileDirs({});
		assert.throws(() => resolveVerifierProfile("nope", roots.baseCwd), (error: Error) => {
			assert.ok(error instanceof VerifierProfileError);
			assert.match(error.message, /"nope" was not found/);
			assert.match(error.message, /nope\.md/);
			return true;
		});
	});
});

describe("verifier profile strictness (profile, not agent)", () => {
	it("accepts only model, thinking, and env", () => {
		assert.throws(
			() => parseVerifierProfileSource("x", "---\nmodel: m\ntools: bash\n---\n", "project", "x.md"),
			/unknown field\(s\) tools/,
		);
		assert.throws(
			() => parseVerifierProfileSource("x", "---\nmodel: m\nspawning: \"true\"\n---\n", "project", "x.md"),
			/unknown field\(s\) spawning/,
		);
	});

	it("requires a model and parses env + thinking + provider refs", () => {
		assert.throws(() => parseVerifierProfileSource("x", "---\nthinking: low\n---\n", "project", "x.md"), /must set model/);
		const parsed = parseVerifierProfileSource(
			"x",
			"---\nmodel: deepseek/m:high\nthinking: low\nenv: |\n  OPENAI_BASE_URL=http://e/v1\n---\n",
			"project",
			"x.md",
		);
		assert.equal(parsed.model, "m");
		assert.equal(parsed.provider, "deepseek");
		assert.equal(parsed.thinking, "low"); // explicit thinking wins over the ref suffix
		assert.deepEqual(parsed.env, { OPENAI_BASE_URL: "http://e/v1" });
	});
});

describe("verifier model ref normalization", () => {
	it("keeps the shared grammar strict", () => {
		assert.equal(normalizeVerifierModelRef("deepseek/m").normalizedRef, "deepseek/m");
		assert.equal(normalizeVerifierModelRef("deepseek/m:high").modelId, "m");
		assert.throws(() => normalizeVerifierModelRef("a/b/c"), /must be provider\/model/);
		assert.throws(() => normalizeVerifierModelRef("nonsense/"), /empty provider or model id/);
	});
});

describe("verifier model selection (deterministic doors)", () => {
	it("omission with no default profile fails closed without file instructions", () => {
		const roots = withProfileDirs({});
		assert.throws(() => resolveVerifierModel({ baseCwd: roots.baseCwd, env: EMPTY_ENV }), (error: Error) => {
			assert.ok(error instanceof VerifierProfileError);
			assert.match(error.message, /verifier model is not configured/);
			assert.doesNotMatch(error.message, /create|\.md|verifiers\//);
			return true;
		});
		// Exported doors cannot rescue an unconfigured verifier.
		assert.throws(
			() => resolveVerifierModel({ baseCwd: roots.baseCwd, env: { DEEPSEEK_API_KEY: "sk" } }),
			/verifier model is not configured/,
		);
	});

	it("a malformed default profile propagates its real error, not 'not configured'", () => {
		const roots = withProfileDirs({ project: "---\nthinking: low\n---\n" }); // no model
		assert.throws(
			() => resolveVerifierModel({ baseCwd: roots.baseCwd, env: EMPTY_ENV }),
			/must set model/,
		);
	});

	it("a profile env block is the complete door and beats shell exports", () => {
		const roots = withProfileDirs({
			project: "---\nmodel: qwen3-32b\nenv: |\n  OPENAI_BASE_URL=http://lab:8000/v1\n  OPENAI_API_KEY=k\n---\n",
		});
		const resolved = resolveVerifierModel({
			baseCwd: roots.baseCwd,
			env: { OPENAI_BASE_URL: "https://shell.example/v1", OPENAI_API_KEY: "sk-shell", DEEPSEEK_API_KEY: "sk" },
		});
		assert.deepEqual(resolved.env, { OPENAI_BASE_URL: "http://lab:8000/v1", OPENAI_API_KEY: "k" });
	});

	it("a key without a URL is an incomplete door, and two families are ambiguous", () => {
		const keyOnly = withProfileDirs({
			project: "---\nmodel: qwen3-32b\nenv: |\n  OPENAI_API_KEY=k\n---\n",
		});
		assert.throws(() => resolveVerifierModel({ baseCwd: keyOnly.baseCwd, env: EMPTY_ENV }), /without OPENAI_BASE_URL/);

		const both = withProfileDirs({
			project: "---\nmodel: deepseek/m\nenv: |\n  OPENAI_BASE_URL=http://a/v1\n  DEEPSEEK_API_KEY=sk\n---\n",
		});
		assert.throws(() => resolveVerifierModel({ baseCwd: both.baseCwd, env: EMPTY_ENV }), /more than one backend door/);
	});

	it("a profile model without a provider never guesses one from the id", () => {
		const roots = withProfileDirs({ project: "---\nmodel: gemini-2.5-flash\n---\n" });
		assert.throws(
			() => resolveVerifierModel({ baseCwd: roots.baseCwd, env: { VERTEX_API_KEY: "vtx" } }),
			/names the model without a provider/,
		);
		// With the provider named, the same export opens the right door.
		const named = withProfileDirs({ project: "---\nmodel: gemini/gemini-2.5-flash\n---\n" });
		assert.deepEqual(
			resolveVerifierModel({ baseCwd: named.baseCwd, env: { VERTEX_API_KEY: "vtx", DEEPSEEK_API_KEY: "sk" } }).env,
			{ VERTEX_API_KEY: "vtx" },
		);
	});

	it("a direct ref binds to its provider and never inherits profile env", () => {
		const roots = withProfileDirs({
			project: "---\nmodel: qwen3-32b\nenv: |\n  OPENAI_BASE_URL=http://other/v1\n  OPENAI_API_KEY=k\n---\n",
			modelsStore: {
				deepseek: { models: [{ id: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", provider: "deepseek" }] },
			},
			auth: { deepseek: { key: "sk-auth" } },
		});
		const resolved = resolveVerifierModel({
			override: "deepseek/deepseek-v4-flash:high",
			baseCwd: roots.baseCwd,
			env: { OPENAI_BASE_URL: "https://unrelated.example/v1", OPENAI_API_KEY: "x" },
		});
		assert.equal(resolved.model, "deepseek-v4-flash");
		assert.equal(resolved.thinking, "high");
		assert.deepEqual(resolved.env, { OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_API_KEY: "sk-auth" });
		// An exported DEEPSEEK key beats the pi config KEY: same endpoint,
		// the user's key, through the generic door.
		assert.deepEqual(
			resolveVerifierModel({
				override: "deepseek/deepseek-v4-flash",
				baseCwd: roots.baseCwd,
				env: { DEEPSEEK_API_KEY: "sk-mine" },
			}).env,
			{ OPENAI_BASE_URL: "https://api.deepseek.com", OPENAI_API_KEY: "sk-mine" },
		);
	});

	it("a pi-defined endpoint beats the provider-specific export; the export supplies the key", () => {
		// A custom deepseek endpoint defined in pi's config must win over the
		// shell DEEPSEEK_API_KEY: the export is a KEY source, never an endpoint
		// override that would silently route back to the official API.
		const roots = withProfileDirs({
			modelsJson: { providers: { deepseek: { baseUrl: "https://my-deepseek-proxy.example/v1" } } },
		});
		assert.deepEqual(
			resolveVerifierModel({
				override: "deepseek/deepseek-v4-flash",
				baseCwd: roots.baseCwd,
				env: { DEEPSEEK_API_KEY: "sk-mine" },
			}).env,
			{ OPENAI_BASE_URL: "https://my-deepseek-proxy.example/v1", OPENAI_API_KEY: "sk-mine" },
		);
	});

	it("a fixed-provider ref never falls through to an unrelated generic export", () => {
		const roots = withProfileDirs({}); // pi knows no deepseek here
		assert.throws(
			() =>
				resolveVerifierModel({
					override: "deepseek/deepseek-v4-flash",
					baseCwd: roots.baseCwd,
					env: { OPENAI_BASE_URL: "https://unrelated.example/v1", OPENAI_API_KEY: "x" },
				}),
			(error: Error) => {
				assert.ok(error instanceof VerifierProfileError);
				assert.match(error.message, /provider "deepseek"/);
				assert.match(error.message, /DEEPSEEK_API_KEY/);
				return true;
			},
		);
	});

	it("resolves the exact model's endpoint and never borrows another model's URL", () => {
		const roots = withProfileDirs({
			modelsJson: {
				providers: {
					acme: {
						baseUrl: "https://provider-default.example/v1",
						apiKey: "provider-key",
						models: [{ id: "model-a", baseUrl: "https://a.example/v1" }],
					},
					opencode: { models: [{ id: "free", baseUrl: "https://free.example/v1" }] },
				},
			},
			modelsStore: {
				opencode: { models: [{ id: "other", baseUrl: "https://other.example/v1" }] },
			},
		});
		// Exact models.json model entry wins over the provider default.
		assert.deepEqual(
			resolveVerifierModel({ override: "acme/model-a", baseCwd: roots.baseCwd, env: EMPTY_ENV }).env,
			{ OPENAI_BASE_URL: "https://a.example/v1", OPENAI_API_KEY: "provider-key" },
		);
		// No exact entry: provider-level default.
		assert.deepEqual(
			resolveVerifierModel({ override: "acme/model-z", baseCwd: roots.baseCwd, env: EMPTY_ENV }).env,
			{ OPENAI_BASE_URL: "https://provider-default.example/v1", OPENAI_API_KEY: "provider-key" },
		);
		// models.json exact model, no provider URL, store has only a DIFFERENT
		// model: use the models.json one, never the store's other-model URL.
		assert.deepEqual(
			resolveVerifierModel({ override: "opencode/free", baseCwd: roots.baseCwd, env: EMPTY_ENV }).env,
			{ OPENAI_BASE_URL: "https://free.example/v1" },
		);
		// Unknown model on a known provider with no fallback URL: fail closed.
		assert.throws(
			() => resolveVerifierModel({ override: "opencode/missing", baseCwd: roots.baseCwd, env: EMPTY_ENV }),
			/no usable endpoint/,
		);
	});

	it("an unknown provider uses the exported generic door; nothing exported fails closed", () => {
		const roots = withProfileDirs({});
		assert.deepEqual(
			resolveVerifierModel({
				override: "vllm/qwen-logprob",
				baseCwd: roots.baseCwd,
				env: { OPENAI_BASE_URL: "http://localhost:8000/v1" },
			}).env,
			{ OPENAI_BASE_URL: "http://localhost:8000/v1" }, // keyless local server is valid
		);
		assert.throws(
			() => resolveVerifierModel({ override: "madeup/foo", baseCwd: roots.baseCwd, env: EMPTY_ENV }),
			/no usable endpoint/,
		);
	});

	it("$ENV and !command apiKeys are not passed through raw; the auth-store key is used instead", () => {
		const roots = withProfileDirs({
			modelsJson: { providers: { acme: { baseUrl: "https://acme/v1", apiKey: "$ACME_SECRET" } } },
			auth: { acme: { key: "sk-authstore" } },
		});
		assert.deepEqual(
			resolveVerifierModel({ override: "acme/anything", baseCwd: roots.baseCwd, env: EMPTY_ENV }).env,
			{ OPENAI_BASE_URL: "https://acme/v1", OPENAI_API_KEY: "sk-authstore" },
		);
	});

	it("a bare value names a profile (project over global)", () => {
		const roots = withProfileDirs({ global: "---\nmodel: deepseek/global-fast\n---\n" });
		writeProfile(roots, "project", "fast", "---\nmodel: deepseek/proj-fast\nthinking: low\n---\n");
		const resolved = resolveVerifierModel({ override: "fast", baseCwd: roots.baseCwd, env: { DEEPSEEK_API_KEY: "sk" } });
		assert.equal(resolved.model, "proj-fast");
		assert.equal(resolved.thinking, "low");
		assert.deepEqual(resolved.env, { DEEPSEEK_API_KEY: "sk" });
	});
});
