import {
	assert,
	closeSurface,
	createSurface,
	createSurfaceSplit,
	createTestDir,
	describe,
	getMuxBackend,
	isMuxAvailable,
	it,
	join,
	muxSetupHint,
	readFileSync,
	readScreen,
	readScreenAsync,
	renameCurrentTab,
	renameWorkspace,
	sendCommand,
	sendShellCommand,
	useFakeHerdrApp,
	writeExecutable,
} from "../support/index.ts";

function clearMuxRuntimeEnv(): void {
	for (const key of [
		"CMUX_SOCKET_PATH",
		"CMUX_SURFACE_ID",
		"TMUX",
		"TMUX_PANE",
		"WEZTERM_PANE",
		"WEZTERM_UNIX_SOCKET",
		"ZELLIJ",
		"ZELLIJ_SESSION_NAME",
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"PI_SUBAGENT_MUX",
		"PI_SUBAGENT_HERDR_PLACEMENT",
		"PI_SUBAGENT_HERDR_MIN_COLUMNS",
		"PI_SUBAGENT_HERDR_MIN_ROWS",
		"PI_SUBAGENT_PARENT_SESSION",
	]) {
		delete process.env[key];
	}
}

function useApp(mode = "available") {
	clearMuxRuntimeEnv();
	return useFakeHerdrApp(mode);
}

function writeFakeOldHerdr(dir: string): void {
	writeExecutable(
		dir,
		"herdr",
		`#!/bin/sh
if [ "$*" = "status server --json" ]; then
  printf '%s\\n' '{"status":"running","running":true,"compatible":true,"protocol":17,"version":"0.7.5"}'
  exit 0
fi
if [ "$*" = "pane current --current" ]; then
  printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","focused":true}}}'
  exit 0
fi
exit 1
`,
	);
}

describe("Herdr app mux backend", () => {
	describe("backend selection", () => {
		it("selects herdr-app when the parent terminal is listed by the window", () => {
			useApp();

			assert.equal(getMuxBackend(), "herdr-app");
			assert.equal(isMuxAvailable(), true);
		});

		it("does not select herdr-app without HC_TERMINAL_ID", () => {
			useApp();
			delete process.env.HC_TERMINAL_ID;

			assert.equal(getMuxBackend(), null);
		});

		it("does not select herdr-app when the terminal is not in the window (unrelated app)", () => {
			useApp("missing-parent");

			assert.equal(getMuxBackend(), null);
		});

		it("does not select herdr-app when the window cannot be listed", () => {
			useApp("no-ls");

			assert.equal(getMuxBackend(), null);
		});

		it("does not select herdr-app when the herdr-app command is missing", () => {
			clearMuxRuntimeEnv();
			process.env.PATH = createTestDir();
			process.env.HC_TERMINAL_ID = "t1";

			assert.equal(getMuxBackend(), null);
		});

		it("honours forced preference only when herdr-app is available", () => {
			useApp();
			process.env.PI_SUBAGENT_MUX = "herdr-app";
			assert.equal(getMuxBackend(), "herdr-app");

			useApp("missing-parent");
			process.env.PI_SUBAGENT_MUX = "herdr-app";
			assert.equal(getMuxBackend(), null);
		});

		it("wins over an old Herdr server that has no pane id in the environment", () => {
			const { dir } = useApp();
			writeFakeOldHerdr(dir);

			assert.equal(getMuxBackend(), "herdr-app");
		});

		it("wins when both herdr-app and old Herdr environments are present", () => {
			const { dir } = useApp();
			writeFakeOldHerdr(dir);
			process.env.HERDR_ENV = "1";
			process.env.HERDR_PANE_ID = "w1:p1";

			assert.equal(getMuxBackend(), "herdr-app");
		});

		it("ignores terminals that only exist in remote spaces", () => {
			useApp("missing-parent,remote-space");

			assert.equal(getMuxBackend(), null);
		});

		it("caches detection for about a second per terminal and PATH", () => {
			const { logFile } = useApp();
			for (let i = 0; i < 3; i++) assert.equal(getMuxBackend(), "herdr-app");

			const lists = readFileSync(logFile, "utf8")
				.split("\n")
				.filter((line) => line === "herdr-app ls");
			assert.equal(lists.length, 1);
		});

		it("mentions herdr-app in setup hints", () => {
			useApp();
			assert.match(muxSetupHint(), /herdr-app/);
			process.env.PI_SUBAGENT_MUX = "herdr-app";
			assert.match(muxSetupHint(), /Herdr app terminal/);
		});
	});

	describe("surface placement", () => {
		it("splits the parent pane to the right and labels the new terminal", async () => {
			const { logFile } = useApp();

			assert.equal(await createSurface("[reviewer] Auth review"), "t2");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /herdr-app do pane\.split --direction right --pane p1/);
			assert.match(log, /hc label t2 pi\.subagent\.title=\[reviewer\] Auth review/);
			assert.doesNotMatch(log, /tab\.new/);
		});

		it("never adds a parent, notify flag or run command: the app creates the terminal", async () => {
			const { logFile } = useApp();

			await createSurface("child");

			assert.doesNotMatch(readFileSync(logFile, "utf8"), /hc run|--notify|--parent/);
		});

		it("stacks owned splits and overflows into a named tab", async () => {
			const { logFile } = useApp();

			assert.equal(await createSurface("[a] First"), "t2");
			assert.equal(await createSurface("[b] Second"), "t3");
			assert.equal(await createSurface("[c] Third"), "t4");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /do pane\.split --direction right --pane p1/);
			assert.match(log, /do pane\.split --direction down --pane p2/);
			assert.equal((log.match(/do pane\.split/g) ?? []).length, 2);
			assert.match(log, new RegExp(`do tab\\.new --space sp1 --folder ${process.cwd()} --name \\[c\\] Third`));
		});

		it("goes straight to a tab when the parent is too small", async () => {
			const { logFile } = useApp("small");

			assert.equal(await createSurface("[scout] Small window"), "t2");

			const log = readFileSync(logFile, "utf8");
			assert.doesNotMatch(log, /pane\.split/);
			assert.match(log, /do tab\.new --space sp1 --folder .* --name \[scout\] Small window/);
		});

		it("uses a tab when the parent geometry is unreadable", async () => {
			const { logFile } = useApp("geometry-fail");

			assert.equal(await createSurface("child"), "t2");
			assert.doesNotMatch(readFileSync(logFile, "utf8"), /pane\.split/);
		});

		it("honours explicit right, down and tab policies", async () => {
			const { logFile } = useApp();
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "down";
			assert.equal(await createSurface("one"), "t2");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "right";
			assert.equal(await createSurface("two"), "t3");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";
			assert.equal(await createSurface("three"), "t4");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /pane\.split --direction down --pane p1/);
			assert.match(log, /pane\.split --direction right --pane p1/);
			assert.match(log, /tab\.new --space sp1/);
		});

		it("falls back to a tab when the split fails", async () => {
			const { logFile } = useApp("split-fail");

			assert.equal(await createSurface("child"), "t2");
			assert.match(readFileSync(logFile, "utf8"), /do tab\.new/);
		});

		it("restores the viewer's focus after a layout change steals it", async () => {
			const { logFile } = useApp("steal-focus");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";

			await createSurface("child");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /do tab\.select --id tb1/);
			assert.match(log, /do pane\.focus --pane p1/);
			assert.ok(log.indexOf("do tab.new") < log.indexOf("do tab.select"));
		});

		it("restores a stolen space even when the pre-change status read failed", async () => {
			const { logFile } = useApp("steal-space,status-fail-once");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";

			assert.equal(await createSurface("child"), "t2");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /do space\.select --id sp1/);
			assert.ok(log.indexOf("do tab.new") < log.indexOf("do space.select"));
			assert.ok(
				log.indexOf("herdr-app status", log.indexOf("do space.select")) > 0,
				"re-reads status after the restore",
			);
		});

		it("exercises space.select when the viewer's space changed", async () => {
			const { logFile } = useApp("steal-space");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";

			await createSurface("child");

			assert.match(readFileSync(logFile, "utf8"), /do space\.select --id sp1/);
		});

		it("does not fail the launch when the focus restore itself fails", async () => {
			useApp("steal-space");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";
			process.env.PI_SUBAGENT_TRACE_LOG = join(createTestDir(), "trace.log");
			// Break the restore: make `space.select` fail by shadowing herdr-app after detection.
			const real = readFileSync(join(process.env.PATH ?? "", "herdr-app"), "utf8");
			writeExecutable(
				process.env.PATH ?? "",
				"herdr-app",
				real.replace(
					"space.select|pane.focus)",
					'space.select) printf \'{"error":"nope"}\\n\'; exit 1 ;;\n      pane.focus)',
				),
			);

			assert.equal(await createSurface("child"), "t2");
			assert.match(readFileSync(process.env.PI_SUBAGENT_TRACE_LOG, "utf8"), /focus-restore-failed/);
			delete process.env.PI_SUBAGENT_TRACE_LOG;
		});

		it("fails loudly when even the tab fallback fails", async () => {
			useApp("tab-fail");
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";

			await assert.rejects(createSurface("child"), /fake tab refused/);
		});

		it("splits from a named surface and rejects unsupported directions", async () => {
			const { logFile } = useApp();
			await createSurface("child");

			assert.equal(createSurfaceSplit("extra", "down", "t2"), "t3");
			assert.match(readFileSync(logFile, "utf8"), /do pane\.split --direction down --pane p2/);
			assert.throws(() => createSurfaceSplit("extra", "left"), /unsupported/);
			assert.throws(() => createSurfaceSplit("extra", "up"), /unsupported/);
		});
	});

	describe("input, output and lifecycle", () => {
		it("sends commands with hc send and presses Enter alone for empty text", async () => {
			const { logFile } = useApp();

			sendCommand("t2", "echo hi");
			sendCommand("t2", "");

			const log = readFileSync(logFile, "utf8");
			assert.match(log, /hc send t2 echo hi/);
			assert.match(log, /hc keys t2 enter/);
		});

		it("stages long shell commands into a script file", async () => {
			const { logFile } = useApp();
			const original = process.env.SHELL;
			process.env.SHELL = "/bin/sh";

			sendShellCommand("t2", "echo staged-body");

			const log = readFileSync(logFile, "utf8");
			const match = log.match(/hc send t2 '([^']+)'; rm -f/);
			assert.ok(match?.[1], `expected a staged script in: ${log}`);
			assert.match(readFileSync(match[1], "utf8"), /echo staged-body/);
			if (original === undefined) delete process.env.SHELL;
			else process.env.SHELL = original;
		});

		it("reads the screen tail synchronously and asynchronously", async () => {
			const { logFile } = useApp();

			assert.equal(readScreen("t2", 2).trim(), "app line 3");
			assert.equal((await readScreenAsync("t2", 2)).trim(), "app line 3");
			assert.match(readScreen("t2", 50), /app line 1/);
			assert.doesNotMatch(readScreen("t2", 50), /history line/);
			assert.match(readFileSync(logFile, "utf8"), /hc read t2 --lines 0/);
		});

		it("closes by killing the terminal, then removing it", async () => {
			const { logFile } = useApp();
			await createSurface("child");

			closeSurface("t2");

			const log = readFileSync(logFile, "utf8").split("\n");
			const kill = log.indexOf("hc kill t2");
			const rm = log.indexOf("hc rm t2");
			assert.ok(kill >= 0 && rm > kill, log.join("\n"));
			assert.ok(!log.some((line) => /do (pane|tab)\.close/.test(line)));
		});

		it("tolerates a terminal that is already gone", async () => {
			const { logFile } = useApp();
			await createSurface("child");
			process.env.FAKE_HERDR_APP_MODE = "kill-notfound";

			closeSurface("t2");

			assert.match(readFileSync(logFile, "utf8"), /hc rm t2/);
		});

		it("propagates other close failures", async () => {
			useApp();
			await createSurface("child");
			process.env.FAKE_HERDR_APP_MODE = "kill-fail";

			assert.throws(() => closeSurface("t2"), /fake kill failure/);
		});

		it("makes rename calls no-ops", async () => {
			const { logFile } = useApp();
			const before = readFileSync(logFile, "utf8").split("\n").length;

			renameCurrentTab("title");
			renameWorkspace("title");

			const added = readFileSync(logFile, "utf8")
				.split("\n")
				.slice(before - 1)
				.filter((line) => line && !/herdr-app ls$/.test(line));
			assert.deepEqual(added, []);
		});
	});
});
