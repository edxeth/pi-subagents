import assert from "node:assert/strict";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createSurface, createSurfaceSplit } from "../../src/mux.ts";

const ORIGINAL_ENV = {
	PATH: process.env.PATH,
	PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX,
	CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
	FAKE_CMUX_GEOMETRY: process.env.FAKE_CMUX_GEOMETRY,
};

afterEach(() => {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value == null) delete process.env[key];
		else process.env[key] = value;
	}
});

function installFakeCmux(): { dir: string; log: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-cmux-test-"));
	const log = join(dir, "cmux.log");
	const bin = join(dir, "cmux");
	writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_CMUX_LOG;
const args = process.argv.slice(2);
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const cmd = args[0];
if (cmd === "new-split") {
  console.log("surface:101 pane:9");
} else if (cmd === "new-surface") {
  console.log("surface:102 pane:9");
} else if (cmd === "rename-tab") {
  console.log("OK");
} else if (cmd === "identify") {
  const sub = args[1];
  if (sub === "--surface") {
    console.log(JSON.stringify({ caller: { surface_ref: args[2], pane_ref: "pane:9" } }));
  } else {
    const geometry = process.env.FAKE_CMUX_GEOMETRY === "wide"
      ? { columns: 160, rows: 40 }
      : process.env.FAKE_CMUX_GEOMETRY === "narrow"
        ? { columns: 40, rows: 8 }
        : {};
    console.log(JSON.stringify({ focused: { surface_ref: "surface:99", pane_ref: "pane:9", ...geometry }, caller: { surface_ref: "surface:99", pane_ref: "pane:9", ...geometry } }));
  }
} else if (cmd === "tree") {
  console.log("workspace:1\\n  pane:9");
} else if (cmd === "focus-pane") {
  // no-op in test
} else if (cmd === "focus-panel") {
  // no-op in test
} else {
  console.error("unexpected cmux command", args.join(" "));
  process.exit(2);
}
`,
	);
	chmodSync(bin, 0o755);
	process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH ?? ""}`;
	process.env.PI_SUBAGENT_MUX = "cmux";
	process.env.CMUX_SOCKET_PATH = join(dir, "cmux.sock");
	process.env.FAKE_CMUX_LOG = log;
	return { dir, log };
}

function readLog(log: string): string[][] {
	return readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("cmux surface creation", () => {
	it("creates cmux splits without stealing focus", () => {
		const { dir, log } = installFakeCmux();
		try {
			assert.equal(createSurfaceSplit("Focus-Free Split", "right"), "surface:101");
			const calls = readLog(log);
			// Should capture focus identify before the split
			const identifyIdx = calls.findIndex((args) => args[0] === "identify" && args[1] === "--json");
			const splitIdx = calls.findIndex((args) => args[0] === "new-split");
			assert.ok(identifyIdx >= 0, "expected identify --json call");
			assert.ok(splitIdx >= 0, "expected new-split call");
			assert.ok(
				!calls.some(
					(args) =>
						args[0] === "new-split" &&
						args.includes("--focus") &&
						args.includes("true"),
				),
				"should NOT use --focus true",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to cmux surfaces when geometry is unavailable", () => {
		const { dir, log } = installFakeCmux();
		try {
			assert.equal(createSurface("First"), "surface:102");
			assert.equal(createSurface("Second"), "surface:102");
			const calls = readLog(log);
			const surfaceCalls = calls.filter((args) => args[0] === "new-surface");
			assert.equal(surfaceCalls.length, 2);
			assert.equal(
				calls.some((args) => args[0] === "new-split"),
				false,
			);
			assert.ok(
				surfaceCalls.every((args) => !args.includes("--focus")),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("splits cmux surfaces when measured geometry leaves a usable child pane", () => {
		const { dir, log } = installFakeCmux();
		try {
			process.env.FAKE_CMUX_GEOMETRY = "wide";
			assert.equal(createSurface("Wide"), "surface:101");
			const calls = readLog(log);
			const splitCalls = calls.filter((args) => args[0] === "new-split");
			assert.equal(splitCalls.length, 1);
			assert.deepEqual(splitCalls[0], ["new-split", "right", "--surface", "surface:99"]);
			assert.equal(
				calls.some((args) => args[0] === "new-surface"),
				false,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses cmux surfaces when a split would leave a too-small child pane", () => {
		const { dir, log } = installFakeCmux();
		try {
			process.env.FAKE_CMUX_GEOMETRY = "narrow";
			assert.equal(createSurface("Narrow"), "surface:102");
			const calls = readLog(log);
			assert.equal(
				calls.some((args) => args[0] === "new-split"),
				false,
			);
			assert.equal(
				calls.some((args) => args[0] === "new-surface"),
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
