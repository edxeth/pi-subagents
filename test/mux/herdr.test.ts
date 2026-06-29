import {
	assert,
	closeSurface,
	createSurface,
	createSurfaceSplit,
	createTestDir,
	describe,
	it,
	join,
	readFileSync,
	readScreen,
	readScreenAsync,
	renameCurrentTab,
	renameWorkspace,
	sendCommand,
	sendShellCommand,
	writeExecutable,
	writeFileSync,
	getMuxBackend,
	isHerdrAvailable,
	isMuxAvailable,
	muxSetupHint,
} from "../support/index.ts";
import {
	getHerdrCurrentPane,
	getHerdrServerStatus,
	getHerdrTab,
	getHerdrWorkspace,
} from "../../src/mux/herdr.ts";

function clearMuxRuntimeEnv(): void {
	delete process.env.CMUX_SOCKET_PATH;
	delete process.env.CMUX_SURFACE_ID;
	delete process.env.TMUX;
	delete process.env.TMUX_PANE;
	delete process.env.WEZTERM_PANE;
	delete process.env.WEZTERM_UNIX_SOCKET;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_SESSION_NAME;
	delete process.env.HERDR_PANE_ID;
	delete process.env.HERDR_TAB_ID;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.PI_SUBAGENT_MUX;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_SESSION;
}

function writeFakeHerdr(dir: string): string {
	const logFile = join(dir, "herdr.log");
	writeFileSync(logFile, "");
	writeExecutable(
		dir,
		"herdr",
		`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_HERDR_LOG"
cmd="$*"
mode="\${FAKE_HERDR_MODE:-available}"

if [ "$cmd" = "status server --json" ]; then
  case "$mode" in
    stopped)
      printf '%s\n' '{"status":"stopped","running":false,"compatible":true,"protocol":14,"version":"0.7.0"}'
      ;;
    incompatible)
      printf '%s\n' '{"status":"running","running":true,"compatible":false,"protocol":13,"version":"0.6.0"}'
      ;;
    malformed-status)
      printf '%s\n' 'not-json'
      ;;
    *)
      printf '%s\n' '{"status":"running","running":true,"compatible":true,"protocol":14,"version":"0.7.0","capabilities":{"live_handoff":true}}'
      ;;
  esac
  exit 0
fi

if [ "$cmd" = "pane current --current" ]; then
  case "$mode" in
    no-current)
      printf '%s\n' '{"error":{"code":"current_pane_not_found","message":"no current Herdr pane"},"id":"cli:pane:current"}'
      exit 1
      ;;
    api-error)
      printf '%s\n' '{"error":{"code":"boom","message":"fake current failed"},"id":"cli:pane:current"}'
      exit 1
      ;;
    malformed-current)
      printf '%s\n' 'this is not json'
      exit 0
      ;;
    *)
      printf '%s\n' '{"id":"cli:pane:current","result":{"type":"pane_current","pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","terminal_id":"term_fake","cwd":"/workspace","foreground_cwd":"/workspace/app","focused":true}}}'
      exit 0
      ;;
  esac
fi

if [ "$cmd" = "tab get w1:t1" ]; then
  printf '%s\n' '{"id":"cli:tab:get","result":{"type":"tab_info","tab":{"tab_id":"w1:t1","workspace_id":"w1","label":"One","focused":true,"pane_count":1}}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "list" ]; then
  printf '%s\n' '{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","workspace_id":"w1","label":"One","focused":true,"pane_count":1},{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1}]}}'
  exit 0
fi

if [ "$cmd" = "workspace get w1" ]; then
  printf '%s\n' '{"id":"cli:workspace:get","result":{"type":"workspace_info","workspace":{"workspace_id":"w1","active_tab_id":"w1:t1","label":"Main","focused":true,"tab_count":1,"pane_count":1}}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "create" ]; then
  case "$mode" in
    tab-created-without-pane)
      printf '%s\n' '{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1}}}'
      ;;
    *)
      printf '%s\n' '{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"w1:t2","workspace_id":"w1","label":"Child","focused":false,"pane_count":1},"root_pane":{"pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":"/workspace/app","focused":false}}}'
      ;;
  esac
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  direction=""
  previous=""
  for arg in "$@"; do
    if [ "$previous" = "--direction" ]; then direction="$arg"; fi
    previous="$arg"
  done
  printf '%s\n' '{"id":"cli:pane:split","result":{"type":"pane_split","pane":{"pane_id":"w1:p-split-'"$direction"'","tab_id":"w1:t1","workspace_id":"w1","cwd":"/workspace/app","focused":false}}}'
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "run" ]; then
  case "$mode" in
    run-api-error)
      printf '%s\n' '{"error":{"code":"permission_denied","message":"fake run refused"},"id":"cli:pane:run"}'
      exit 1
      ;;
    run-malformed-output)
      printf '%s\n' 'not-json'
      exit 0
      ;;
    run-empty-failure)
      exit 1
      ;;
    *)
      exit 0
      ;;
  esac
fi

if [ "$1" = "pane" ] && [ "$2" = "send-text" ]; then
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "send-keys" ]; then
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "read" ]; then
  while IFS= read -r line; do
    printf '%s\n' "$line"
  done < "$FAKE_HERDR_SCREEN"
  exit 0
fi

if [ "$1" = "pane" ] && [ "$2" = "close" ]; then
  if [ "$3" = "w1:closed" ]; then
    printf '%s\n' '{"error":{"code":"pane_not_found","message":"pane already closed"},"id":"cli:pane:close"}'
    exit 1
  fi
  if [ "$3" = "w1:bad" ]; then
    printf '%s\n' '{"error":{"code":"permission_denied","message":"fake close refused"},"id":"cli:pane:close"}'
    exit 1
  fi
  printf '%s\n' '{"id":"cli:pane:close","result":{"type":"pane_closed"}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "close" ]; then
  printf '%s\n' '{"id":"cli:tab:close","result":{"type":"ok"}}'
  exit 0
fi

if [ "$1" = "tab" ] && [ "$2" = "rename" ]; then
  printf '%s\n' '{"id":"cli:tab:rename","result":{"type":"tab_renamed"}}'
  exit 0
fi

if [ "$1" = "workspace" ] && [ "$2" = "rename" ]; then
  printf '%s\n' '{"id":"cli:workspace:rename","result":{"type":"workspace_renamed"}}'
  exit 0
fi

printf '%s\n' '{"error":{"code":"unknown_command","message":"unsupported fake herdr command"}}'
exit 1
`,
	);
	return logFile;
}

function useFakeHerdr(mode = "available"): {
	dir: string;
	logFile: string;
	screenFile: string;
} {
	const dir = createTestDir();
	const logFile = writeFakeHerdr(dir);
	const screenFile = join(dir, "herdr-screen.txt");
	writeFileSync(screenFile, "herdr line 1\nherdr line 2\n");
	clearMuxRuntimeEnv();
	process.env.PATH = dir;
	process.env.FAKE_HERDR_LOG = logFile;
	process.env.FAKE_HERDR_MODE = mode;
	process.env.FAKE_HERDR_SCREEN = screenFile;
	return { dir, logFile, screenFile };
}

function writeFakeCommand(dir: string, command: string): void {
	writeExecutable(dir, command, "#!/bin/sh\nexit 0\n");
}

describe("Herdr mux backend", () => {
	describe("backend selection", () => {
		it("selects Herdr when a compatible server and current pane are available", () => {
			useFakeHerdr();

			assert.equal(isHerdrAvailable(), true);
			assert.equal(isMuxAvailable(), true);
			assert.equal(getMuxBackend(), "herdr");
		});

		it("does not select Herdr when the herdr command is missing", () => {
			const dir = createTestDir();
			clearMuxRuntimeEnv();
			process.env.PATH = dir;

			assert.equal(isHerdrAvailable(), false);
			assert.equal(getMuxBackend(), null);
		});

		for (const [mode, expected] of [
			["no-current", "current pane"],
			["stopped", "stopped server"],
			["incompatible", "incompatible protocol"],
		] as const) {
			it(`does not select Herdr with ${expected}`, () => {
				useFakeHerdr(mode);

				assert.equal(isHerdrAvailable(), false);
				assert.equal(getMuxBackend(), null);
			});
		}

		it("prefers Herdr over an outer tmux when no forced preference is set", () => {
			const { dir } = useFakeHerdr();
			writeFakeCommand(dir, "tmux");
			process.env.TMUX = "fake-tmux-socket";
			process.env.TMUX_PANE = "%1";

			assert.equal(getMuxBackend(), "herdr");
		});

		it("uses forced Herdr only when Herdr is actually available", () => {
			useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";
			assert.equal(getMuxBackend(), "herdr");

			useFakeHerdr("no-current");
			process.env.PI_SUBAGENT_MUX = "herdr";
			assert.equal(getMuxBackend(), null);
		});

		for (const { backend, command, envKey, envValue } of [
			{
				backend: "cmux",
				command: "cmux",
				envKey: "CMUX_SOCKET_PATH",
				envValue: "/tmp/fake-cmux.sock",
			},
			{
				backend: "tmux",
				command: "tmux",
				envKey: "TMUX",
				envValue: "fake-tmux-socket",
			},
			{
				backend: "zellij",
				command: "zellij",
				envKey: "ZELLIJ_SESSION_NAME",
				envValue: "fake-zellij",
			},
			{
				backend: "wezterm",
				command: "wezterm",
				envKey: "WEZTERM_UNIX_SOCKET",
				envValue: "fake-wezterm-socket",
			},
		] as const) {
			it(`respects forced ${backend} preference over available Herdr`, () => {
				const { dir } = useFakeHerdr();
				writeFakeCommand(dir, command);
				process.env.PI_SUBAGENT_MUX = backend;
				process.env[envKey] = envValue;

				assert.equal(getMuxBackend(), backend);
			});
		}

		it("returns a Herdr-specific setup hint", () => {
			process.env.PI_SUBAGENT_MUX = "herdr";

			assert.match(muxSetupHint(), /Herdr/);
		});
	});

	describe("surface creation", () => {
		it("creates normal surfaces as numbered Herdr tabs in the parent workspace", () => {
			const { logFile } = useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";

			assert.equal(createSurface("Herdr Child"), "w1:p2");

			const log = readFileSync(logFile, "utf8");
			assert.match(
				log,
				/tab create --workspace w1 --cwd .* --label Herdr Child --no-focus/,
			);
			assert.match(log, /tab rename w1:t2 2: Herdr Child/);
			assert.doesNotMatch(log, /pane split/);
		});

		it("creates child agent Herdr tab labels without positional numbering", () => {
			const { logFile } = useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";

			assert.equal(createSurface("[scout] Explore auth implementation"), "w1:p2");

			const log = readFileSync(logFile, "utf8");
			assert.match(
				log,
				/tab create --workspace w1 --cwd .* --label \[scout\] Explore auth implementation --no-focus/,
			);
			assert.doesNotMatch(log, /tab list --workspace w1/);
			assert.match(log, /tab rename w1:t2 \[scout\] Explore auth implementation/);
		});

		it("closes the created Herdr tab when tab creation returns no root pane", () => {
			const { logFile } = useFakeHerdr("tab-created-without-pane");
			process.env.PI_SUBAGENT_MUX = "herdr";

			assert.throws(
				() => createSurface("Herdr Child"),
				/Herdr tab create returned malformed pane record/,
			);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /tab create --workspace w1 --cwd .* --label Herdr Child --no-focus/);
			assert.match(log, /tab close w1:t2/);
		});

		for (const direction of ["right", "down"] as const) {
			it(`creates explicit ${direction} Herdr splits with cwd and no-focus`, () => {
				const { logFile } = useFakeHerdr();
				process.env.PI_SUBAGENT_MUX = "herdr";

				assert.equal(
					createSurfaceSplit("Herdr Split", direction, "w1:p1"),
					`w1:p-split-${direction}`,
				);

				const log = readFileSync(logFile, "utf8");
				assert.match(
					log,
					new RegExp(
						`pane split w1:p1 --direction ${direction} --cwd .* --no-focus`,
					),
				);
				assert.doesNotMatch(log, /tab create/);
			});
		}

		for (const direction of ["left", "up"] as const) {
			it(`rejects unsupported ${direction} Herdr splits honestly`, () => {
				const { logFile } = useFakeHerdr();
				process.env.PI_SUBAGENT_MUX = "herdr";

				assert.throws(
					() => createSurfaceSplit("Herdr Split", direction, "w1:p1"),
					new RegExp(
						`Herdr split direction "${direction}" is unsupported; .*right and down`,
					),
				);

				const log = readFileSync(logFile, "utf8");
				assert.doesNotMatch(log, /pane split/);
			});
		}
	});

	describe("I/O, titles, and cleanup", () => {
		it("sends commands, empty Enter, shell commands, reads recent output, and closes panes", async () => {
			const { logFile, screenFile } = useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";
			writeFileSync(
				screenFile,
				"herdr line 1\nherdr line 2\n__SUBAGENT_DONE_0__\n",
			);

			sendCommand("w1:p2", "echo herdr");
			sendCommand("w1:p2", "");
			sendShellCommand("w1:p2", "printf shell");

			assert.match(readScreen("w1:p2", 10), /__SUBAGENT_DONE_0__/);
			assert.match(await readScreenAsync("w1:p2", 10), /herdr line 2/);
			closeSurface("w1:p2");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /pane run w1:p2 echo herdr/);
			const stagedScriptPath = log.match(/pane run w1:p2 '([^']+)'/)?.[1];
			assert.ok(stagedScriptPath, "expected sendShellCommand to stage Herdr shell command");
			assert.match(readFileSync(stagedScriptPath, "utf8"), /printf shell/);
			assert.equal((log.match(/pane send-keys w1:p2 Enter/g) ?? []).length, 1);
			assert.match(
				log,
				/pane read w1:p2 --source recent --lines 10 --format text/,
			);
			assert.match(log, /pane close w1:p2/);
		});

		for (const [mode, expected] of [
			[
				"run-api-error",
				/Herdr pane run failed: permission_denied: fake run refused/,
			],
			["run-malformed-output", /Herdr pane run returned malformed JSON/],
			[
				"run-empty-failure",
				/Herdr pane run failed with exit code 1: \(empty\)/,
			],
		] as const) {
			it(`reports ${mode} Herdr command failures`, () => {
				const { logFile } = useFakeHerdr(mode);
				process.env.PI_SUBAGENT_MUX = "herdr";

				assert.throws(() => sendCommand("w1:p2", "echo herdr"), expected);

				const log = readFileSync(logFile, "utf8");
				assert.match(log, /pane run w1:p2 echo herdr/);
				assert.doesNotMatch(log, /pane send-keys w1:p2 Enter/);
			});
		}

		it("renames Herdr tab and workspace labels from environment or current pane metadata", () => {
			const { logFile } = useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";
			process.env.HERDR_TAB_ID = "w1:t-env";
			process.env.HERDR_WORKSPACE_ID = "w1-env";

			renameCurrentTab("Env Tab");
			renameWorkspace("Env Workspace");
			delete process.env.HERDR_TAB_ID;
			delete process.env.HERDR_WORKSPACE_ID;
			renameCurrentTab("Current Tab");
			renameWorkspace("Current Workspace");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /tab rename w1:t-env Env Tab/);
			assert.match(log, /workspace rename w1-env Env Workspace/);
			assert.match(log, /tab rename w1:t1 Current Tab/);
			assert.match(log, /workspace rename w1 Current Workspace/);
		});

		it("does not prefix Herdr child agent tab labels with the positional tab index", () => {
			const { logFile } = useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";
			process.env.PI_SUBAGENT_NAME = "scout-child";

			renameCurrentTab("[scout] Exploring auth implementation");
			delete process.env.PI_SUBAGENT_NAME;

			const log = readFileSync(logFile, "utf8");
			assert.doesNotMatch(log, /tab list --workspace w1/);
			assert.match(log, /tab rename w1:t1 \[scout\] Exploring auth implementation/);
		});

		it("ignores already-closed Herdr panes but propagates cleanup failures", () => {
			const { logFile } = useFakeHerdr();
			process.env.PI_SUBAGENT_MUX = "herdr";

			assert.doesNotThrow(() => closeSurface("w1:closed"));
			assert.throws(
				() => closeSurface("w1:bad"),
				/Herdr pane close failed: permission_denied: fake close refused/,
			);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /pane close w1:closed/);
			assert.match(log, /pane close w1:bad/);
		});
	});

	describe("structured CLI adapter", () => {
		it("extracts typed status, pane, tab, and workspace records", () => {
			useFakeHerdr();

			assert.deepEqual(getHerdrServerStatus(), {
				status: "running",
				running: true,
				compatible: true,
				protocol: 14,
				version: "0.7.0",
				capabilities: { live_handoff: true },
			});
			assert.deepEqual(getHerdrCurrentPane(), {
				paneId: "w1:p1",
				tabId: "w1:t1",
				workspaceId: "w1",
				terminalId: "term_fake",
				cwd: "/workspace",
				foregroundCwd: "/workspace/app",
				focused: true,
			});
			assert.deepEqual(getHerdrTab("w1:t1"), {
				tabId: "w1:t1",
				workspaceId: "w1",
				label: "One",
				focused: true,
				paneCount: 1,
			});
			assert.deepEqual(getHerdrWorkspace("w1"), {
				workspaceId: "w1",
				activeTabId: "w1:t1",
				label: "Main",
				focused: true,
				tabCount: 1,
				paneCount: 1,
			});

			const log = readFileSync(process.env.FAKE_HERDR_LOG!, "utf8");
			assert.match(log, /status server --json/);
			assert.match(log, /pane current --current/);
			assert.match(log, /tab get w1:t1/);
			assert.match(log, /workspace get w1/);
		});

		it("reports Herdr API errors with the failing operation name", () => {
			useFakeHerdr("api-error");

			assert.throws(
				() => getHerdrCurrentPane(),
				/Herdr pane current failed: boom: fake current failed/,
			);
		});

		it("reports malformed JSON with the failing operation name", () => {
			useFakeHerdr("malformed-current");

			assert.throws(
				() => getHerdrCurrentPane(),
				/Herdr pane current returned malformed JSON/,
			);
		});

		it("reports malformed server status JSON with the status operation name", () => {
			useFakeHerdr("malformed-status");

			assert.throws(
				() => getHerdrServerStatus(),
				/Herdr status server returned malformed JSON/,
			);
		});
	});
});
