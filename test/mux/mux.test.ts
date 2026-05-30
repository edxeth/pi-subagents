import {
	assert,
	execFileSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
	join,
	describe,
	it,
	closeSurface,
	createSurface,
	createSurfaceSplit,
	exitStatusVar,
	getMuxBackend,
	isCmuxAvailable,
	isFishShell,
	isMuxAvailable,
	isTmuxAvailable,
	isZellijAvailable,
	muxSetupHint,
	pollForExit,
	readScreen,
	readScreenAsync,
	renameCurrentTab,
	renameWorkspace,
	sendCommand,
	sendShellCommand,
	shellEscape,
	createTestDir,
	sleep,
	writeExecutable,
	ORIGINAL_ENV,
} from "../support/index.ts";

describe("mux.ts", () => {
	describe("shellEscape", () => {
		it("wraps in single quotes", () => {
			assert.equal(shellEscape("hello"), "'hello'");
		});

		it("escapes single quotes", () => {
			assert.equal(shellEscape("it's"), "'it'\\''s'");
		});

		it("handles empty string", () => {
			assert.equal(shellEscape(""), "''");
		});

		it("handles special characters", () => {
			const input = 'echo "hello $world" && rm -rf /';
			const escaped = shellEscape(input);
			assert.ok(escaped.startsWith("'"));
			assert.ok(escaped.endsWith("'"));
			assert.ok(escaped.includes("$world"));
		});
	});

	describe("environment helpers", () => {
		it("detects fish shell and the correct exit status variable", () => {
			process.env.SHELL = "/usr/bin/fish";
			assert.equal(isFishShell(), true);
			assert.equal(exitStatusVar(), "$status");

			process.env.SHELL = "/bin/zsh";
			assert.equal(isFishShell(), false);
			assert.equal(exitStatusVar(), "$?");
		});

		it("selects tmux when it is the available runtime", () => {
			const dir = createTestDir();
			writeExecutable(dir, "tmux", "#!/usr/bin/env bash\nexit 0\n");
			process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
			process.env.PI_SUBAGENT_MUX = "tmux";
			process.env.TMUX = "test-tmux-socket";
			delete process.env.CMUX_SOCKET_PATH;
			delete process.env.WEZTERM_UNIX_SOCKET;
			delete process.env.ZELLIJ;
			delete process.env.ZELLIJ_SESSION_NAME;

			assert.equal(getMuxBackend(), "tmux");
			assert.equal(isMuxAvailable(), true);
		});

		it("returns null when the preferred backend is unavailable", () => {
			process.env.PI_SUBAGENT_MUX = "cmux";
			delete process.env.CMUX_SOCKET_PATH;
			delete process.env.TMUX;
			delete process.env.WEZTERM_UNIX_SOCKET;
			delete process.env.ZELLIJ;
			delete process.env.ZELLIJ_SESSION_NAME;

			assert.equal(getMuxBackend(), null);
			assert.equal(isMuxAvailable(), false);
		});

		it("returns a setup hint for the selected preference", () => {
			process.env.PI_SUBAGENT_MUX = "tmux";
			assert.match(muxSetupHint(), /tmux new -A -s pi 'pi'/);

			process.env.PI_SUBAGENT_MUX = "zellij";
			assert.match(muxSetupHint(), /zellij --session pi/);

			process.env.PI_SUBAGENT_MUX = "wezterm";
			assert.match(muxSetupHint(), /WezTerm/);
		});

		it("reports cmux availability as a boolean", () => {
			const result = isCmuxAvailable();
			assert.equal(typeof result, "boolean");
		});
	});

	describe("exit sidecar polling", () => {
		it("returns a done result from the session exit sidecar", async () => {
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");
			writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));

			try {
				const result = await pollForExit(
					"ignored",
					new AbortController().signal,
					{
						interval: 10,
						sessionFile,
					},
				);
				assert.equal(result.reason, "done");
				assert.equal(result.exitCode, 0);
				assert.equal(existsSync(`${sessionFile}.exit`), false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("returns a ping result from the session exit sidecar", async () => {
			const dir = createTestDir();
			const sessionFile = join(dir, "child.jsonl");
			writeFileSync(sessionFile, "");
			writeFileSync(
				`${sessionFile}.exit`,
				JSON.stringify({
					type: "ping",
					name: "Ping Child",
					message: "Need input",
				}),
			);

			try {
				const result = await pollForExit(
					"ignored",
					new AbortController().signal,
					{
						interval: 10,
						sessionFile,
					},
				);
				assert.equal(result.reason, "ping");
				assert.equal(result.exitCode, 0);
				assert.deepEqual(result.ping, {
					name: "Ping Child",
					message: "Need input",
				});
				assert.equal(existsSync(`${sessionFile}.exit`), false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	const canRunTmuxIntegration =
		!!ORIGINAL_ENV.TMUX && !!ORIGINAL_ENV.TMUX_PANE && isTmuxAvailable();

	describe("tmux integration", () => {
		const maybeIt = canRunTmuxIntegration ? it : it.skip;

		maybeIt(
			"creates panes, sends commands, reads output, and closes them",
			async () => {
				let baseSurface: string | undefined;
				let splitSurface: string | undefined;
				const marker = `pane-output-${Date.now()}`;

				try {
					baseSurface = createSurface("Pi Test Base");
					splitSurface = createSurfaceSplit(
						"Pi Test Split",
						"down",
						baseSurface,
					);
					assert.notEqual(baseSurface, splitSurface);

					sendCommand(splitSurface, `printf '${marker}'`);
					await sleep(250);

					assert.match(
						readScreen(splitSurface, 20).replace(/\s+/g, ""),
						new RegExp(marker),
					);
					assert.match(
						(await readScreenAsync(splitSurface, 20)).replace(/\s+/g, ""),
						new RegExp(marker),
					);
				} finally {
					if (splitSurface) {
						try {
							closeSurface(splitSurface);
						} catch {}
					}
					if (baseSurface) {
						try {
							closeSurface(baseSurface);
						} catch {}
					}
				}

				await sleep(150);
				const panes = execFileSync(
					"tmux",
					["list-panes", "-a", "-F", "#{pane_id}"],
					{
						encoding: "utf8",
					},
				);
				if (baseSurface) assert.ok(!panes.includes(baseSurface));
				if (splitSurface) assert.ok(!panes.includes(splitSurface));
			},
		);

		maybeIt("renames the current tmux window and session", () => {
			const paneId = ORIGINAL_ENV.TMUX_PANE!;
			const windowId = execFileSync(
				"tmux",
				["display-message", "-p", "-t", paneId, "#{window_id}"],
				{
					encoding: "utf8",
				},
			).trim();
			const sessionId = execFileSync(
				"tmux",
				["display-message", "-p", "-t", paneId, "#{session_id}"],
				{
					encoding: "utf8",
				},
			).trim();
			const originalWindowName = execFileSync(
				"tmux",
				["display-message", "-p", "-t", paneId, "#{window_name}"],
				{
					encoding: "utf8",
				},
			).trim();
			const originalSessionName = execFileSync(
				"tmux",
				["display-message", "-p", "-t", paneId, "#{session_name}"],
				{
					encoding: "utf8",
				},
			).trim();

			try {
				process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW = "1";
				renameCurrentTab("Pi Test Window");
				assert.equal(
					execFileSync(
						"tmux",
						["display-message", "-p", "-t", paneId, "#{window_name}"],
						{
							encoding: "utf8",
						},
					).trim(),
					"Pi Test Window",
				);

				process.env.PI_SUBAGENT_RENAME_TMUX_SESSION = "1";
				renameWorkspace("Pi Test Session");
				assert.equal(
					execFileSync(
						"tmux",
						["display-message", "-p", "-t", paneId, "#{session_name}"],
						{
							encoding: "utf8",
						},
					).trim(),
					"Pi Test Session",
				);
			} finally {
				execFileSync(
					"tmux",
					["rename-window", "-t", windowId, originalWindowName],
					{ encoding: "utf8" },
				);
				execFileSync(
					"tmux",
					["rename-session", "-t", sessionId, originalSessionName],
					{ encoding: "utf8" },
				);
			}
		});

		maybeIt(
			"polls until the subagent completion sentinel appears",
			async () => {
				const surface = createSurface("Pi Test Poll");

				try {
					sendCommand(surface, "sleep 0.1; printf '__SUBAGENT_DONE_7__'");
					const ticks: number[] = [];
					const result = await pollForExit(
						surface,
						new AbortController().signal,
						{
							interval: 50,
							onTick(elapsed) {
								ticks.push(elapsed);
							},
						},
					);

					assert.equal(result.exitCode, 7);
					assert.ok(ticks.length >= 0);
				} finally {
					try {
						closeSurface(surface);
					} catch {}
				}
			},
		);

		maybeIt("aborts polling when the caller aborts", async () => {
			const surface = createSurface("Pi Test Abort");
			const controller = new AbortController();

			try {
				const pending = pollForExit(surface, controller.signal, {
					interval: 200,
				});
				setTimeout(() => controller.abort(), 50);
				await assert.rejects(pending, /Aborted/);
			} finally {
				try {
					closeSurface(surface);
				} catch {}
			}
		});
	});

	describe("fake backend integration", () => {
		it("gates tmux window renaming behind PI_SUBAGENT_RENAME_TMUX_WINDOW", () => {
			const dir = createTestDir();
			const logFile = join(dir, "tmux.log");
			writeFileSync(logFile, "");
			writeExecutable(
				dir,
				"tmux",
				`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "$1" = "display-message" ]; then
  if [ "$5" = '#{window_id}' ]; then printf '@1\n';
  elif [ "$5" = '#{session_id}' ]; then printf '$1\n';
  fi
fi
`,
			);

			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
			process.env.PI_SUBAGENT_MUX = "tmux";
			process.env.TMUX = "fake-tmux-socket";
			process.env.TMUX_PANE = "%1";
			process.env.FAKE_TMUX_LOG = logFile;

			renameCurrentTab("Ignored by default");
			let log = readFileSync(logFile, "utf8");
			assert.doesNotMatch(log, /rename-window/);

			process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW = "1";
			renameCurrentTab("Enabled rename");
			log = readFileSync(logFile, "utf8");
			assert.match(log, /rename-window/);
		});

		it("splits tmux surfaces only when measured geometry is safe", () => {
			const dir = createTestDir();
			const logFile = join(dir, "tmux-surface.log");
			writeFileSync(logFile, "");
			writeExecutable(
				dir,
				"tmux",
				`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_TMUX_LOG"
if [ "$1" = "display-message" ]; then
  if [ "$FAKE_TMUX_GEOMETRY" = "wide" ]; then printf '160 40 160 40 1\n';
  elif [ "$FAKE_TMUX_GEOMETRY" = "three-fit" ]; then printf '76 52 153 52 2\n';
  elif [ "$FAKE_TMUX_GEOMETRY" = "narrow" ]; then printf '40 8 80 8 8\n';
  else exit 1;
  fi
elif [ "$1" = "split-window" ]; then
  printf '%%split\n'
elif [ "$1" = "new-window" ]; then
  printf '%%window\n'
fi
`,
			);

			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
			process.env.PI_SUBAGENT_MUX = "tmux";
			process.env.TMUX = "fake-tmux-socket";
			process.env.TMUX_PANE = "%1";
			process.env.FAKE_TMUX_LOG = logFile;

			process.env.FAKE_TMUX_GEOMETRY = "wide";
			assert.equal(createSurface("Wide Tmux"), "%split");
			let log = readFileSync(logFile, "utf8");
			assert.match(log, /split-window -d -h -t %1 -P -F #\{pane_id\}/);
			assert.match(log, /select-layout -t %1 even-horizontal/);
			assert.doesNotMatch(log, /new-window/);

			writeFileSync(logFile, "");
			process.env.FAKE_TMUX_GEOMETRY = "three-fit";
			assert.equal(createSurface("Third Tmux"), "%split");
			log = readFileSync(logFile, "utf8");
			assert.match(log, /split-window -d -h -t %1 -P -F #\{pane_id\}/);
			assert.match(log, /select-layout -t %1 tiled/);
			assert.doesNotMatch(log, /new-window/);

			writeFileSync(logFile, "");
			process.env.FAKE_TMUX_GEOMETRY = "narrow";
			assert.equal(createSurface("Narrow Tmux"), "%window");
			log = readFileSync(logFile, "utf8");
			assert.doesNotMatch(log, /split-window/);
			assert.match(log, /new-window -d -P -F #\{pane_id\}/);
		});

		it("exercises the cmux backend with a fake cmux binary", async () => {
			const dir = createTestDir();
			const logFile = join(dir, "cmux.log");
			const screenFile = join(dir, "cmux-screen.txt");
			writeFileSync(screenFile, "cmux line 1\ncmux line 2\n");
			writeExecutable(
				dir,
				"cmux",
				`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CMUX_LOG"
case "$1" in
  tree)
    printf 'pane:42\n'
    ;;
  identify)
    if [ "$2" = "--surface" ]; then
      printf '{"caller":{"surface_ref":"%s","pane_ref":"pane:42"}}\n' "$3"
    else
      printf '{"focused":{"surface_ref":"surface:99","pane_ref":"pane:42"},"caller":{"surface_ref":"surface:99","pane_ref":"pane:42"}}\n'
    fi
    ;;
  new-split|new-surface)
    printf 'surface:42 pane:7\n'
    ;;
  rename-tab)
    printf 'OK\n'
    ;;
  focus-pane|focus-panel)
    # no-op
    ;;
  read-screen)
    cat "$FAKE_CMUX_SCREEN"
    ;;
esac
`,
			);

			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
			process.env.PI_SUBAGENT_MUX = "cmux";
			process.env.CMUX_SOCKET_PATH = "/tmp/fake-cmux.sock";
			process.env.CMUX_SURFACE_ID = "surface:99";
			process.env.FAKE_CMUX_LOG = logFile;
			process.env.FAKE_CMUX_SCREEN = screenFile;

			const surface = createSurface("Fake Cmux");
			const secondSurface = createSurface("Fake Cmux 2");
			assert.equal(surface, "surface:42");
			assert.equal(secondSurface, "surface:42");
			renameCurrentTab("Cmux Tab");
			renameWorkspace("Cmux Workspace");
			sendCommand(surface, "echo cmux");
			assert.match(readScreen(surface, 10), /cmux line 1/);
			assert.match(await readScreenAsync(surface, 10), /cmux line 2/);
			closeSurface(surface);
			closeSurface(secondSurface);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /new-surface/);
			assert.doesNotMatch(log, /--focus/);
			assert.doesNotMatch(log, /new-split/);
			assert.match(log, /rename-tab/);
			assert.match(log, /workspace-action/);
			assert.match(log, /send/);
			assert.match(log, /read-screen/);
			assert.match(log, /close-surface/);
		});

		it("stages long cmux shell commands through a temp script", () => {
			const dir = createTestDir();
			const logFile = join(dir, "cmux-stage.log");
			writeExecutable(
				dir,
				"cmux",
				`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CMUX_LOG"
`,
			);

			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
			process.env.PI_SUBAGENT_MUX = "cmux";
			process.env.CMUX_SOCKET_PATH = "/tmp/fake-cmux.sock";
			process.env.CMUX_WORKSPACE_ID = "workspace:8";
			process.env.FAKE_CMUX_LOG = logFile;
			process.env.SHELL = "/bin/sh";

			let stagedPath: string | null = null;
			try {
				const longCommand = `FILLER='${"x".repeat(8000)}' pi --session /tmp/session.jsonl @/tmp/prompt.md; echo '__SUBAGENT_DONE_'$?'__'`;
				sendShellCommand("surface:42", longCommand);

				const log = readFileSync(logFile, "utf8");
				assert.match(log, /send --surface surface:42/);
				assert.doesNotMatch(log, /FILLER='x{100}/);
				assert.match(log, /pi-subagent-cmux-/);
				assert.match(log, /rm -f/);

				const pathMatch = log.match(
					/(\/[^\s']*pi-subagent-cmux-[^\s']+\.(?:sh|fish))/,
				);
				assert.ok(pathMatch);
				stagedPath = pathMatch[1];
				assert.equal(existsSync(stagedPath), true);

				const stagedCommand = readFileSync(stagedPath, "utf8");
				assert.match(stagedCommand, /^#!\/bin\/sh\n/);
				assert.match(stagedCommand, /FILLER='x{100}/);
				assert.match(stagedCommand, /pi --session \/tmp\/session\.jsonl/);
				assert.match(stagedCommand, /__SUBAGENT_DONE_/);
			} finally {
				if (stagedPath && existsSync(stagedPath))
					rmSync(stagedPath, { force: true });
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("exercises the wezterm backend with a fake wezterm binary", async () => {
			const dir = createTestDir();
			const logFile = join(dir, "wezterm.log");
			const screenFile = join(dir, "wezterm-screen.txt");
			writeFileSync(screenFile, "wez line 1\nwez line 2\n");
			writeExecutable(
				dir,
				"wezterm",
				`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_WEZTERM_LOG"
if [ "$1" = "cli" ] && [ "$2" = "split-pane" ]; then
  printf '77\n'
elif [ "$1" = "cli" ] && [ "$2" = "get-text" ]; then
  cat "$FAKE_WEZTERM_SCREEN"
fi
`,
			);

			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
			process.env.PI_SUBAGENT_MUX = "wezterm";
			process.env.WEZTERM_UNIX_SOCKET = "fake-wezterm-socket";
			process.env.WEZTERM_PANE = "77";
			process.env.FAKE_WEZTERM_LOG = logFile;
			process.env.FAKE_WEZTERM_SCREEN = screenFile;

			const surface = createSurfaceSplit("Fake WezTerm", "up", "42");
			assert.equal(surface, "77");
			renameCurrentTab("WezTerm Tab");
			renameWorkspace("WezTerm Window");
			sendCommand(surface, "echo wezterm");
			assert.match(readScreen(surface, 10), /wez line 1/);
			assert.match(await readScreenAsync(surface, 10), /wez line 2/);
			closeSurface(surface);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /split-pane --top --cwd/);
			assert.match(log, /set-tab-title/);
			assert.match(log, /set-window-title/);
			assert.match(log, /send-text/);
			assert.match(log, /get-text/);
			assert.match(log, /kill-pane/);
		});

		it("exercises the zellij backend with a fake zellij binary", async () => {
			const dir = createTestDir();
			const logFile = join(dir, "zellij.log");
			const screenFile = join(dir, "zellij-screen.txt");
			writeFileSync(screenFile, "z1\nz2\nz3\nz4\n");
			writeExecutable(
				dir,
				"zellij",
				`#!/bin/sh
printf '%s | pane=%s\n' "$*" "\${ZELLIJ_PANE_ID:-}" >> "$FAKE_ZELLIJ_LOG"
[ "$1" = "action" ] || exit 0
action="$2"
if [ "$action" = "new-pane" ]; then
  printf 'terminal_%s\n' "\${FAKE_ZELLIJ_PANE_ID:-7}"
elif [ "$action" = "write-chars" ]; then
  if [ "$3" = "--pane-id" ]; then
    text="$5"
  else
    text="$3"
  fi
  printf '%s' "$text" > "$FAKE_ZELLIJ_SCREEN"
elif [ "$action" = "dump-screen" ]; then
  cat "$FAKE_ZELLIJ_SCREEN"
fi
`,
			);

			process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH}`;
			process.env.PI_SUBAGENT_MUX = "zellij";
			process.env.ZELLIJ_SESSION_NAME = "fake-zellij";
			process.env.FAKE_ZELLIJ_LOG = logFile;
			process.env.FAKE_ZELLIJ_SCREEN = screenFile;
			process.env.FAKE_ZELLIJ_PANE_ID = "7";
			process.env.ZELLIJ_PANE_ID = "3";

			assert.equal(isZellijAvailable(), true);
			const surface = createSurfaceSplit("Fake Zellij", "up", "pane:3");
			assert.equal(surface, "pane:7");
			renameCurrentTab("Zellij Tab");
			renameWorkspace("Ignored for zellij");
			sendCommand(surface, "echo zellij");
			assert.match(readScreen(surface, 1), /echo zellij/);
			assert.match(await readScreenAsync(surface, 1), /echo zellij/);
			closeSurface(surface);

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /new-pane/);
			assert.match(log, /--pane-id 3/);
			assert.match(log, /move-pane --pane-id 7/);
			assert.match(log, /rename-pane --pane-id 7/);
			assert.match(log, /rename-pane --pane-id 3 Zellij Tab/);
			assert.doesNotMatch(log, /write-chars.*echo "\$ZELLIJ_PANE_ID"/);
			assert.doesNotMatch(log, /rename-tab/);
			assert.match(log, /dump-screen --pane-id 7/);
			assert.match(log, /close-pane --pane-id 7/);
		});
	});
});
