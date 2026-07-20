import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	createZellijCommandSurface,
	createZellijSurface,
	resetZellijPlacementStateForTests,
	type ZellijPlacementContext,
} from "../../src/mux/zellij-placement.ts";
import {
	getZellijShellCommand,
	resolveZellijTargetFromSessions,
} from "../../src/mux/zellij-runtime.ts";
import { watchSubagent } from "../../src/runtime/interactive-watch.ts";
import type { RunningSubagent } from "../../src/types.ts";

const ORIGINAL_PATH = process.env.PATH;
const trackedEnv = [
	"FAKE_ZELLIJ_COUNTER",
	"FAKE_ZELLIJ_FOCUS",
	"FAKE_ZELLIJ_GHOST",
	"FAKE_ZELLIJ_LOG",
	"FAKE_ZELLIJ_MULTI_CLIENT",
	"FAKE_ZELLIJ_NEW_TAB_PANES",
	"FAKE_ZELLIJ_PANES",
	"PATH",
	"PI_SUBAGENT_MUX",
	"PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
	"PI_SUBAGENT_ZELLIJ_MIN_ROWS",
	"SHELL",
	"ZELLIJ_PANE_ID",
	"ZELLIJ_SESSION_NAME",
] as const;
const originalEnv = Object.fromEntries(
	trackedEnv.map((key) => [key, process.env[key]]),
) as Record<(typeof trackedEnv)[number], string | undefined>;

function terminalPane(
	id: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		is_plugin: false,
		is_floating: false,
		is_selectable: true,
		exited: false,
		pane_rows: 30,
		pane_columns: 120,
		tab_id: 1,
		tab_position: 0,
		...overrides,
	};
}

function writePanes(path: string, panes: Record<string, unknown>[]): void {
	writeFileSync(path, JSON.stringify(panes));
}

describe("owned Zellij surface placement", () => {
	it("resolves a renamed session instead of an immediately reused old name", () => {
		assert.deepEqual(
			resolveZellijTargetFromSessions(1, [
				{ name: "old", panes: [{ id: 1, pane_command: "fish" }] },
				{ name: "renamed", panes: [{ id: 1, pane_command: "pi" }] },
			]),
			{ sessionName: "renamed", parentPaneId: 1 },
		);
	});

	it("uses a live inherited session to disambiguate matching Pi panes", () => {
		assert.deepEqual(
			resolveZellijTargetFromSessions(
				0,
				[
					{ name: "first", panes: [{ id: 0, pane_command: "/usr/bin/zsh" }] },
					{ name: "second", panes: [{ id: 0, pane_command: "/usr/bin/zsh" }] },
				],
				"second",
			),
			{ sessionName: "second", parentPaneId: 0 },
		);
	});

	it("starts Bash without inherited startup hooks", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-zellij-shell-test-"));
		try {
			const marker = join(dir, "bash-env-ran");
			const bashEnv = join(dir, "bash-env.sh");
			writeFileSync(bashEnv, `touch ${JSON.stringify(marker)}\n`);
			process.env.SHELL = "/bin/bash";
			const argv = getZellijShellCommand(`printf '%s|%s' "$BASH_ENV" "$ENV"`);
			const output = execFileSync(argv[0], argv.slice(1), {
				env: { ...process.env, BASH_ENV: bashEnv, ENV: bashEnv },
				encoding: "utf8",
			});
			assert.equal(output, "|");
			assert.equal(existsSync(marker), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			const original = originalEnv.SHELL;
			if (original === undefined) delete process.env.SHELL;
			else process.env.SHELL = original;
		}
	});

	let dir: string;
	let focusFile: string;
	let logFile: string;
	let panesFile: string;
	let newTabPanesFile: string;
	let counterFile: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-zellij-owned-test-"));
		focusFile = join(dir, "focus.txt");
		logFile = join(dir, "zellij.log");
		panesFile = join(dir, "panes.json");
		newTabPanesFile = join(dir, "new-tab-panes.json");
		counterFile = join(dir, "counter");
		writeFileSync(counterFile, "29");
		writeFileSync(focusFile, "terminal_10");
		writeFileSync(logFile, "");
		writePanes(newTabPanesFile, [terminalPane(40, { tab_id: 2 })]);
		const binary = join(dir, "zellij");
		writeFileSync(
			binary,
			`#!/bin/sh
printf '%s | pane=%s\n' "$*" "\${ZELLIJ_PANE_ID:-}" >> "$FAKE_ZELLIJ_LOG"
if [ "$1" = "list-sessions" ]; then
  printf 'stale [Created 1m ago] (EXITED - attach to resurrect)\n%s [Created 1s ago]\n' "$ZELLIJ_SESSION_NAME"
  exit 0
fi
if [ "$1" = "--session" ] && [ "$2" = "stale" ]; then exit 9; fi
if [ "$1" = "--session" ]; then shift 2; fi
[ "$1" = "action" ] || exit 0
action="$2"
if [ "$action" = "list-panes" ]; then
  cat "$FAKE_ZELLIJ_PANES"
elif [ "$action" = "list-clients" ]; then
  printf 'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1         %s     shell\n' "$(cat "$FAKE_ZELLIJ_FOCUS")"
  if [ "\${FAKE_ZELLIJ_MULTI_CLIENT:-0}" = "1" ]; then
    printf '2         terminal_20     nvim\n'
  fi
elif [ "$action" = "focus-pane-id" ]; then
  printf '%s' "$3" > "$FAKE_ZELLIJ_FOCUS"
elif [ "$action" = "new-pane" ]; then
  next=$(( $(cat "$FAKE_ZELLIJ_COUNTER") + 1 ))
  printf '%s' "$next" > "$FAKE_ZELLIJ_COUNTER"
  if [ "\${FAKE_ZELLIJ_GHOST:-0}" != "1" ]; then
    node -e 'const fs=require("fs"); const [path,id,args]=process.argv.slice(1); const panes=JSON.parse(fs.readFileSync(path,"utf8")); panes.push({id:Number(id),is_plugin:false,is_floating:args.includes("--floating"),is_selectable:true,exited:false,pane_rows:30,pane_columns:120,tab_id:1}); fs.writeFileSync(path,JSON.stringify(panes));' "$FAKE_ZELLIJ_PANES" "$next" "$*"
  fi
  printf 'terminal_%s\n' "$next"
elif [ "$action" = "new-tab" ]; then
  cp "$FAKE_ZELLIJ_NEW_TAB_PANES" "$FAKE_ZELLIJ_PANES"
  printf '2\n'
fi
`,
		);
		chmodSync(binary, 0o755);

		process.env.PATH = `${dir}:${ORIGINAL_PATH}`;
		process.env.PI_SUBAGENT_MUX = "zellij";
		process.env.ZELLIJ_SESSION_NAME = `owned-${dir.split("-").at(-1)}`;
		process.env.ZELLIJ_PANE_ID = "10";
		process.env.FAKE_ZELLIJ_FOCUS = focusFile;
		process.env.FAKE_ZELLIJ_LOG = logFile;
		process.env.FAKE_ZELLIJ_PANES = panesFile;
		process.env.FAKE_ZELLIJ_NEW_TAB_PANES = newTabPanesFile;
		process.env.FAKE_ZELLIJ_COUNTER = counterFile;
		process.env.PI_SUBAGENT_ZELLIJ_MIN_COLUMNS = "50";
		process.env.PI_SUBAGENT_ZELLIJ_MIN_ROWS = "10";
	});

	afterEach(() => {
		resetZellijPlacementStateForTests();
		for (const key of trackedEnv) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("splits only the parent for the first child and stacks siblings on the owned pane", async () => {
		writePanes(panesFile, [
			terminalPane(10),
			terminalPane(20, { pane_columns: 300, title: "nvim" }),
		]);
		const context: ZellijPlacementContext = {
			groupKey: "parent-session-a",
			parentPaneId: 10,
			policy: "right-stack",
		};
		assert.equal(
			await createZellijCommandSurface(
				"first",
				{ sessionName: process.env.ZELLIJ_SESSION_NAME!, parentPaneId: 10 },
				["/bin/bash", "--noprofile", "--norc", "-c", "pi"],
				context,
			),
			"pane:30",
		);
		writePanes(panesFile, [terminalPane(10), terminalPane(20), terminalPane(30)]);
		assert.equal(await createZellijSurface("second", context), "pane:31");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /focus-pane-id terminal_10/);
		assert.match(log, /new-pane --direction right --tab-id 1.*-- \/bin\/bash --noprofile --norc -c pi/);
		assert.match(log, /new-pane --stacked --near-current-pane.*\| pane=30/);
		assert.match(log, /focus-previous-pane/);
		assert.doesNotMatch(log, /--stacked.*\| pane=20/);
	});

	it("keeps same-parent anchors separate when effective policies alternate", async () => {
		writePanes(panesFile, [terminalPane(10)]);
		const right: ZellijPlacementContext = {
			groupKey: "parent-session-mixed",
			parentPaneId: 10,
			policy: "right-stack",
		};
		const down: ZellijPlacementContext = {
			...right,
			policy: "down-stack",
		};

		assert.equal(await createZellijSurface("right-first", right), "pane:30");
		writePanes(panesFile, [terminalPane(10), terminalPane(30)]);
		assert.equal(await createZellijSurface("down-first", down), "pane:31");
		writePanes(panesFile, [
			terminalPane(10),
			terminalPane(30),
			terminalPane(31),
		]);
		assert.equal(await createZellijSurface("right-second", right), "pane:32");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /new-pane --direction right/);
		assert.match(log, /new-pane --direction down/);
		assert.match(log, /new-pane --stacked --near-current-pane.*\| pane=30/);
		assert.doesNotMatch(log, /--stacked.*\| pane=31/);
	});

	it("recreates a missing owned anchor instead of stacking onto a foreign pane", async () => {
		writePanes(panesFile, [terminalPane(10), terminalPane(20)]);
		const context: ZellijPlacementContext = {
			groupKey: "parent-session-b",
			parentPaneId: 10,
			policy: "right-stack",
		};
		assert.equal(await createZellijSurface("first", context), "pane:30");

		writePanes(panesFile, [terminalPane(10), terminalPane(20)]);
		assert.equal(await createZellijSurface("replacement", context), "pane:31");
		const log = readFileSync(logFile, "utf8");
		assert.equal((log.match(/new-pane --direction right/g) ?? []).length, 2);
		assert.doesNotMatch(log, /--stacked/);
	});

	it("falls back to a dedicated tab on a small parent and stacks later siblings there", async () => {
		writePanes(panesFile, [terminalPane(10, { pane_rows: 18, pane_columns: 90 })]);
		const context: ZellijPlacementContext = {
			groupKey: "parent-session-small",
			parentPaneId: 10,
			policy: "down-stack",
		};
		assert.equal(
			await createZellijCommandSurface(
				"first",
				{ sessionName: process.env.ZELLIJ_SESSION_NAME!, parentPaneId: 10 },
				["/bin/bash", "--noprofile", "--norc", "-c", "pi"],
				context,
			),
			"pane:30",
		);

		writePanes(panesFile, [
			terminalPane(10, { pane_rows: 18, pane_columns: 90 }),
			terminalPane(30, { tab_id: 2, pane_rows: 18, pane_columns: 90 }),
		]);
		assert.equal(await createZellijSurface("second", context), "pane:31");
		const log = readFileSync(logFile, "utf8");
		assert.match(log, /new-tab --name first/);
		assert.match(log, /new-pane --tab-id 2.*-- \/bin\/bash --noprofile/);
		assert.match(log, /close-pane --pane-id 40/);
		assert.match(log, /go-to-tab 1/);
		assert.match(log, /focus-pane-id terminal_10/);
		assert.match(log, /new-pane --stacked --near-current-pane.*\| pane=30/);
	});

	it("stops watching when the owned child pane exits without a sentinel", async () => {
		writePanes(panesFile, [terminalPane(10), terminalPane(30, { exited: true })]);
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, "");
		const running: RunningSubagent = {
			id: "dead-zellij-pane",
			name: "Dead pane",
			task: "Exit abruptly",
			mode: "interactive",
			executionState: "running",
			deliveryState: "detached",
			parentClosePolicy: "terminate",
			startTime: Date.now(),
			sessionFile,
			surface: "pane:30",
			zellijTarget: {
				sessionName: process.env.ZELLIJ_SESSION_NAME!,
				parentPaneId: 10,
			},
		};
		let closeCount = 0;
		const result = await watchSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				async closeRunningSurface() {
					closeCount++;
				},
			},
			new AbortController().signal,
		);

		assert.equal(result.exitCode, 1);
		assert.equal(
			result.errorMessage,
			"Zellij child pane exited without a completion signal.",
		);
		assert.equal(closeCount, 1);
		assert.match(
			readFileSync(logFile, "utf8"),
			new RegExp(`--session ${process.env.ZELLIJ_SESSION_NAME} action list-panes --all --json`),
		);
	});

	it("rejects ghost pane ids and does not persist them as owned anchors", async () => {
		writePanes(panesFile, [terminalPane(10), terminalPane(20)]);
		const context: ZellijPlacementContext = {
			groupKey: "parent-session-ghost",
			parentPaneId: 10,
			policy: "right-stack",
		};
		process.env.FAKE_ZELLIJ_GHOST = "1";
		await assert.rejects(
			() => createZellijSurface("ghost", context),
			/pane:30.*never became live/,
		);

		process.env.FAKE_ZELLIJ_GHOST = "0";
		assert.equal(await createZellijSurface("real", context), "pane:31");
		const log = readFileSync(logFile, "utf8");
		assert.equal((log.match(/new-pane --direction right/g) ?? []).length, 2);
		assert.doesNotMatch(log, /--stacked/);
	});

	it("rejects focus-mutating placement with multiple attached clients", async () => {
		writePanes(panesFile, [terminalPane(10), terminalPane(20)]);
		process.env.FAKE_ZELLIJ_MULTI_CLIENT = "1";
		await assert.rejects(
			() =>
				createZellijSurface("blocked", {
					groupKey: "parent-session-multi-client",
					parentPaneId: 10,
					policy: "right-stack",
				}),
			/exactly one attached client.*found 2/,
		);
	});

	it("creates independent floating panes without a stack anchor", async () => {
		writePanes(panesFile, [terminalPane(10)]);
		const context: ZellijPlacementContext = {
			groupKey: "parent-session-floating",
			parentPaneId: 10,
			policy: "floating",
		};
		assert.equal(await createZellijSurface("one", context), "pane:30");
		assert.equal(await createZellijSurface("two", context), "pane:31");
		const log = readFileSync(logFile, "utf8");
		assert.equal((log.match(/new-pane --floating --pinned true/g) ?? []).length, 2);
		assert.doesNotMatch(log, /--stacked/);
	});
});
