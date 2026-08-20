import { assert, describe, it } from "../support/index.ts";
import {
	envNameMatchesPattern,
	filterDeniedEnv,
	parseDenyEnvList,
	pickPaneIdentityEnv,
	resolveDenyEnvPatterns,
	stripVolatileShellEnv,
} from "../../src/launch/child-env.ts";

describe("child env policy", () => {
	describe("parseDenyEnvList", () => {
		it("splits comma-separated names, trims, drops empties, and dedupes", () => {
			assert.deepEqual(parseDenyEnvList("AWS_KEY, OPENAI_API_KEY ,,AWS_KEY,"), ["AWS_KEY", "OPENAI_API_KEY"]);
		});

		it("returns an empty list for undefined, empty, and whitespace-only specs", () => {
			assert.deepEqual(parseDenyEnvList(undefined), []);
			assert.deepEqual(parseDenyEnvList(""), []);
			assert.deepEqual(parseDenyEnvList("  "), []);
		});

		it("keeps unusual-but-legal env names verbatim except newline, which separates", () => {
			assert.deepEqual(parseDenyEnvList("FOO-BAR"), ["FOO-BAR"]);
		});

		it("accepts newline-separated YAML block entries", () => {
			assert.deepEqual(parseDenyEnvList("AWS_*\nOPENCODE_API_KEY\n"), ["AWS_*", "OPENCODE_API_KEY"]);
		});
	});

	describe("resolveDenyEnvPatterns", () => {
		it("unions agent frontmatter deny-env with the global PI_SUBAGENT_ENV_DENY", () => {
			const patterns = resolveDenyEnvPatterns("AWS_*, MY_KEY", { PI_SUBAGENT_ENV_DENY: "MY_KEY, GLOBAL_*" });
			assert.deepEqual(patterns, ["AWS_*", "MY_KEY", "GLOBAL_*"]);
		});

		it("returns an empty list when neither source is set", () => {
			assert.deepEqual(resolveDenyEnvPatterns(undefined, {}), []);
		});
	});

	describe("envNameMatchesPattern", () => {
		it("matches exact names without wildcards", () => {
			assert.equal(envNameMatchesPattern("OPENCODE_API_KEY", "OPENCODE_API_KEY"), true);
			assert.equal(envNameMatchesPattern("OPENCODE_API_KEY_EXTRA", "OPENCODE_API_KEY"), false);
		});

		it("treats * as any-sequence wildcard including empty", () => {
			assert.equal(envNameMatchesPattern("AWS_ACCESS_KEY_ID", "AWS_*"), true);
			assert.equal(envNameMatchesPattern("AWS_", "AWS_*"), true);
			assert.equal(envNameMatchesPattern("AWS", "AWS_*"), false);
			assert.equal(envNameMatchesPattern("OPENCODE_API_KEY", "AWS_*"), false);
			assert.equal(envNameMatchesPattern("AXB", "A*B"), true);
			assert.equal(envNameMatchesPattern("AB", "A*B"), true);
			assert.equal(envNameMatchesPattern("AXBC", "A*B"), false);
		});

		it("matches everything with a lone star", () => {
			assert.equal(envNameMatchesPattern("ANYTHING", "*"), true);
		});

		it("keeps matching literal for names with shell-hostile characters", () => {
			assert.equal(envNameMatchesPattern("SAFE\nprintf injected > /tmp/x#", "SAFE\nprintf injected > /tmp/x#"), true);
			assert.equal(envNameMatchesPattern("SAFE\nprintf injected > /tmp/x#", "SAFE*"), true);
		});
	});

	describe("filterDeniedEnv", () => {
		it("removes denied names and keeps everything else", () => {
			const filtered = filterDeniedEnv(
				{ KEEP_ME: "1", OPENCODE_API_KEY: "secret", AWS_SECRET: "secret" },
				["OPENCODE_API_KEY", "AWS_*"],
			);
			assert.deepEqual(filtered, { KEEP_ME: "1" });
		});

		it("silently ignores patterns that match nothing", () => {
			const filtered = filterDeniedEnv({ KEEP_ME: "1" }, ["DOES_NOT_EXIST", "ALSO_*"]);
			assert.deepEqual(filtered, { KEEP_ME: "1" });
		});

		it("does not mutate the input env", () => {
			const env = { A: "1", B: "2" };
			filterDeniedEnv(env, ["A"]);
			assert.deepEqual(env, { A: "1", B: "2" });
		});
	});

	describe("stripVolatileShellEnv", () => {
		it("removes shell-relative vars that are meaningless in a new pane shell", () => {
			const stripped = stripVolatileShellEnv({
				PWD: "/old",
				OLDPWD: "/older",
				SHLVL: "3",
				_: "/bin/cat",
				PATH: "/bin",
			});
			assert.deepEqual(stripped, { PATH: "/bin" });
		});
	});

	describe("pickPaneIdentityEnv", () => {
		it("extracts only mux/terminal context from the pane shell env", () => {
			const picked = pickPaneIdentityEnv({
				ZELLIJ_PANE_ID: "7",
				TMUX: "/tmp/tmux-1000/default,123,0",
				TMUX_PANE: "%3",
				TERM: "screen-256color",
				COLORTERM: "truecolor",
				HERDR_ENV: "1",
				WEZTERM_PANE: "5",
				CMUX_SOCKET_PATH: "/run/cmux.sock",
				OPENCODE_API_KEY: "secret",
				PATH: "/usr/bin",
			});
			assert.deepEqual(picked, {
				ZELLIJ_PANE_ID: "7",
				TMUX: "/tmp/tmux-1000/default,123,0",
				TMUX_PANE: "%3",
				TERM: "screen-256color",
				COLORTERM: "truecolor",
				HERDR_ENV: "1",
				WEZTERM_PANE: "5",
				CMUX_SOCKET_PATH: "/run/cmux.sock",
			});
		});

		it("skips unset and empty values", () => {
			assert.deepEqual(pickPaneIdentityEnv({ TMUX_PANE: undefined, TERM: "" }), {});
		});
	});
});
