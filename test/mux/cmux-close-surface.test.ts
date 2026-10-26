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

import { isMuxConfirmationRequired } from "../../src/mux/io.ts";
import { closeSurface } from "../../src/mux.ts";

const ORIGINAL_ENV = {
	PATH: process.env.PATH,
	PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX,
	CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
	FAKE_CMUX_LOG: process.env.FAKE_CMUX_LOG,
};

afterEach(() => {
	for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
		if (value == null) delete process.env[key];
		else process.env[key] = value;
	}
});

function installFakeCmux(): { dir: string; log: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-close-test-"));
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
if (cmd === "close-surface") {
  if (args.includes("--force")) {
    console.log("OK");
  } else {
    console.error("confirmation_required: Surface has a running process; retry with force=true");
    process.exit(1);
  }
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

describe("cmux close-surface confirmation gate", async () => {
	it("retries with --force when cmux reports confirmation_required", async () => {
		const { dir, log } = installFakeCmux();
		try {
			closeSurface("surface:101");
			const calls = readLog(log);
			assert.equal(calls.length, 2);
			assert.ok(!calls[0].includes("--force"), "first attempt must not force");
			assert.ok(calls[1].includes("--force"), "retry must pass --force");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("recognizes the confirmation gate in exec errors and plain strings", async () => {
		const err = new Error(
			"Command failed: cmux close-surface\nconfirmation_required: Surface has a running process; retry with force=true",
		);
		assert.equal(isMuxConfirmationRequired(err), true);
		assert.equal(isMuxConfirmationRequired(new Error("boom")), false);
		assert.equal(isMuxConfirmationRequired("confirmation_required"), true);
		assert.equal(isMuxConfirmationRequired(undefined), false);
	});
});
