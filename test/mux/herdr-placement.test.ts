import {
	assert,
	createSurface,
	createTestDir,
	describe,
	it,
	join,
	createSurfaceSplit,
	readFileSync,
	renameCurrentTab,
	renameWorkspace,
	writeExecutable,
	writeFileSync,
} from "../support/index.ts";

function clearHerdrPlacementEnv(): void {
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
	delete process.env.PI_SUBAGENT_HERDR_PLACEMENT;
	delete process.env.PI_SUBAGENT_HERDR_MIN_COLUMNS;
	delete process.env.PI_SUBAGENT_HERDR_MIN_ROWS;
	delete process.env.PI_SUBAGENT_NAME;
	delete process.env.PI_SUBAGENT_SESSION;
	delete process.env.PI_SUBAGENT_PARENT_SESSION;
	delete process.env.PI_SUBAGENT_SURFACE;
	delete process.env.FAKE_HERDR_LAYOUT;
	delete process.env.FAKE_HERDR_COUNTER;
	delete process.env.FAKE_HERDR_RENAME_FAIL;
	delete process.env.FAKE_HERDR_SPLIT_FAIL;
}

function writeFakeHerdr(dir: string): string {
	const logFile = join(dir, "herdr.log");
	writeFileSync(logFile, "");
	writeExecutable(
		dir,
		"herdr",
		`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_HERDR_LOG"
if [ "$*" = "status server --json" ]; then
  printf '%s\n' '{"status":"running","running":true,"compatible":true,"protocol":17,"version":"0.7.5"}'
  exit 0
fi
if [ "$*" = "pane current --current" ]; then
  printf '%s\n' '{"result":{"pane":{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","focused":true}}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "layout" ]; then
  IFS= read -r count < "$FAKE_HERDR_COUNTER"
  if [ "\${FAKE_HERDR_LAYOUT:-first}" = "small" ]; then
    printf '%s\n' '{"result":{"layout":{"area":{"height":20,"width":80,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":20,"width":80,"x":0,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}'
  elif [ "\${FAKE_HERDR_LAYOUT:-first}" = "owned-full" ] && [ "$count" -gt 0 ]; then
    printf '%s\n' '{"result":{"layout":{"area":{"height":52,"width":120,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":52,"width":60,"x":0,"y":0}},{"pane_id":"w1:p2","rect":{"height":12,"width":50,"x":60,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}'
  elif [ "\${FAKE_HERDR_LAYOUT:-first}" = "owned-stack" ] && [ "$count" -gt 0 ]; then
    printf '%s\n' '{"result":{"layout":{"area":{"height":52,"width":120,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":52,"width":60,"x":0,"y":0}},{"pane_id":"w1:p2","rect":{"height":26,"width":60,"x":60,"y":0}},{"pane_id":"w1:p8","rect":{"height":52,"width":200,"x":120,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}'
  else
    printf '%s\n' '{"result":{"layout":{"area":{"height":52,"width":120,"x":0,"y":0},"focused_pane_id":"w1:p1","panes":[{"focused":true,"pane_id":"w1:p1","rect":{"height":52,"width":120,"x":0,"y":0}}],"splits":[],"tab_id":"w1:t1","workspace_id":"w1","zoomed":false}}}'
  fi
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "split" ]; then
  if [ "\${FAKE_HERDR_SPLIT_FAIL:-0}" = "1" ]; then
    printf '%s\n' '{"error":{"code":"pane_split_failed","message":"fake split refused"}}'
    exit 1
  fi
  IFS= read -r count < "$FAKE_HERDR_COUNTER"
  pane_number=$((count + 2))
  echo $((count + 1)) > "$FAKE_HERDR_COUNTER"
  printf '%s\n' '{"result":{"pane":{"pane_id":"w1:p'"$pane_number"'","tab_id":"w1:t1","workspace_id":"w1","focused":false}}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "rename" ]; then
  if [ "\${FAKE_HERDR_RENAME_FAIL:-0}" = "1" ] && [ "$3" = "w1:p2" ]; then
    printf '%s\n' '{"error":{"code":"rename_failed","message":"fake rename failed"}}'
    exit 1
  fi
  printf '%s\n' '{"result":{"type":"pane_renamed"}}'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "close" ]; then
  printf '%s\n' '{"result":{"type":"pane_closed"}}'
  exit 0
fi
if [ "$1" = "tab" ] && [ "$2" = "create" ]; then
  printf '%s\n' '{"result":{"tab":{"tab_id":"w1:t2","workspace_id":"w1"},"root_pane":{"pane_id":"w1:p9","tab_id":"w1:t2","workspace_id":"w1"}}}'
  exit 0
fi
if [ "$1" = "tab" ] && [ "$2" = "list" ]; then
  printf '%s\n' '{"result":{"tabs":[{"tab_id":"w1:t1","workspace_id":"w1"},{"tab_id":"w1:t2","workspace_id":"w1"}]}}'
  exit 0
fi
if [ "$1" = "tab" ] && [ "$2" = "rename" ]; then
  printf '%s\n' '{"result":{"type":"tab_renamed"}}'
  exit 0
fi
if [ "$1" = "tab" ] && [ "$2" = "close" ]; then
  printf '%s\n' '{"result":{"type":"tab_closed"}}'
  exit 0
fi
printf '%s\n' '{"error":{"code":"unknown_command","message":"unsupported fake herdr command"}}'
exit 1
`,
	);
	return logFile;
}

function useFakeHerdr(): string {
	const dir = createTestDir();
	const logFile = writeFakeHerdr(dir);
	clearHerdrPlacementEnv();
	process.env.PATH = dir;
	process.env.FAKE_HERDR_LOG = logFile;
	process.env.FAKE_HERDR_COUNTER = join(dir, "split-count");
	writeFileSync(process.env.FAKE_HERDR_COUNTER, "0\n");
	process.env.PI_SUBAGENT_MUX = "herdr";
	process.env.PI_SUBAGENT_SESSION = `parent-${dir}`;
	return logFile;
}

describe("Herdr owned placement", () => {
	it("uses a safe same-tab split by default and names the child pane", async () => {
		const logFile = useFakeHerdr();

		assert.equal(await createSurface("[reviewer] Auth review"), "w1:p2");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane layout --pane w1:p1/);
		assert.match(
			log,
			/pane split w1:p1 --direction right --ratio 0\.5 --cwd .* --no-focus/,
		);
		assert.match(log, /pane rename w1:p2 \[reviewer\] Auth review/);
		assert.doesNotMatch(log, /tab create/);
	});

	it("splits the largest live owned pane instead of a foreign pane", async () => {
		const logFile = useFakeHerdr();
		process.env.FAKE_HERDR_LAYOUT = "owned-stack";

		assert.equal(await createSurface("[reviewer] First child"), "w1:p2");
		assert.equal(await createSurface("[tester] Second child"), "w1:p3");

		const log = readFileSync(logFile, "utf8");
		assert.match(
			log,
			/pane split w1:p2 --direction down --ratio 0\.5 --cwd .* --no-focus/,
		);
		assert.doesNotMatch(log, /pane split w1:p8/);
	});

	it("opens a dedicated named tab when the window is too small", async () => {
		const logFile = useFakeHerdr();
		process.env.FAKE_HERDR_LAYOUT = "small";

		assert.equal(await createSurface("[scout] Small window"), "w1:p9");

		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane split/);
		assert.match(log, /tab create --workspace w1 --cwd .* --label \[scout\] Small window --no-focus/);
		assert.match(log, /pane rename w1:p9 \[scout\] Small window/);
		assert.match(log, /tab rename w1:t2 \[scout\] Small window/);
	});

	it("uses a dedicated tab when no owned pane can remain usable", async () => {
		const logFile = useFakeHerdr();
		process.env.FAKE_HERDR_LAYOUT = "owned-full";

		assert.equal(await createSurface("[reviewer] First child"), "w1:p2");
		assert.equal(await createSurface("[tester] Overflow child"), "w1:p9");

		const log = readFileSync(logFile, "utf8");
		assert.equal((log.match(/pane split /g) ?? []).length, 1);
		assert.match(log, /tab create --workspace w1/);
	});

	it("closes a split pane before falling back when pane naming fails", async () => {
		const logFile = useFakeHerdr();
		process.env.FAKE_HERDR_RENAME_FAIL = "1";

		assert.equal(await createSurface("[reviewer] Rename failure"), "w1:p9");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane split w1:p1/);
		assert.match(log, /pane rename w1:p2 \[reviewer\] Rename failure/);
		assert.match(log, /pane close w1:p2/);
		assert.ok(log.indexOf("pane close w1:p2") < log.indexOf("tab create"));
	});

	it("keeps explicit right-stack placement available", async () => {
		const logFile = useFakeHerdr();
		process.env.FAKE_HERDR_LAYOUT = "owned-stack";
		process.env.PI_SUBAGENT_HERDR_PLACEMENT = "right-stack";

		assert.equal(await createSurface("[reviewer] First child"), "w1:p2");
		assert.equal(await createSurface("[tester] Second child"), "w1:p3");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane split w1:p1 --direction right --ratio 0\.62/);
		assert.match(log, /pane split w1:p2 --direction down --ratio 0\.5/);
	});

	it("honors dedicated-tab placement without inspecting pane geometry", async () => {
		const logFile = useFakeHerdr();
		process.env.PI_SUBAGENT_HERDR_PLACEMENT = "tab";

		assert.equal(await createSurface("[reviewer] Tab child"), "w1:p9");

		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane layout|pane split/);
		assert.match(log, /pane rename w1:p9 \[reviewer\] Tab child/);
		assert.match(log, /tab rename w1:t2 \[reviewer\] Tab child/);
	});

	it("prefers an explicit Herdr placement context over the parent environment", async () => {
		const logFile = useFakeHerdr();
		process.env.PI_SUBAGENT_HERDR_PLACEMENT = "auto";

		assert.equal(
			await createSurface("[reviewer] Agent tab child", {
				herdr: { policy: "tab" },
			}),
			"w1:p9",
		);

		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane layout|pane split/);
		assert.match(log, /tab create --workspace w1/);
	});

	it("rejects invalid placement before creating a Herdr surface", async () => {
		const logFile = useFakeHerdr();
		process.env.PI_SUBAGENT_HERDR_PLACEMENT = "sideways";

		await assert.rejects(
			() => createSurface("[reviewer] Invalid placement"),
			/Invalid PI_SUBAGENT_HERDR_PLACEMENT/,
		);

		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane layout|pane split|tab create/);
	});

	it("propagates the real Herdr error from an explicit split failure", () => {
		useFakeHerdr();
		process.env.FAKE_HERDR_SPLIT_FAIL = "1";

		assert.throws(
			() => createSurfaceSplit("[reviewer] Split fail", "right", "w1:p1"),
			/pane split failed.*fake split refused/,
		);
	});

	for (const policy of ["right", "down"] as const) {
		it(`splits the parent for explicit ${policy} placement without geometry checks`, async () => {
			const logFile = useFakeHerdr();
			process.env.PI_SUBAGENT_HERDR_PLACEMENT = policy;

			assert.equal(await createSurface("[reviewer] Explicit child"), "w1:p2");

			const log = readFileSync(logFile, "utf8");
			assert.doesNotMatch(log, /pane layout/);
			assert.match(
				log,
				new RegExp(`pane split w1:p1 --direction ${policy} --cwd .* --no-focus`),
			);
			assert.match(log, /pane rename w1:p2 \[reviewer\] Explicit child/);
			assert.doesNotMatch(log, /tab create/);
		});
	}

	it("routes child title updates to the Herdr pane without renaming the workspace", () => {
		const logFile = useFakeHerdr();
		process.env.PI_SUBAGENT_NAME = "reviewer";
		process.env.PI_SUBAGENT_SURFACE = "w1:p2";

		renameCurrentTab("Reviewing tests");
		renameWorkspace("Reviewing tests");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane rename w1:p2 Reviewing tests/);
		assert.doesNotMatch(log, /tab rename/);
		assert.doesNotMatch(log, /workspace rename/);
	});
});
