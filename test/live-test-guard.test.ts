import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let releases: Array<() => void> = [];
let testDir = "";
let acquireLiveWindowLock;
let requireLiveWindowOptIn;

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), "live-test-guard-"));
  process.env.PI_SUBAGENT_LIVE_LOCK_PATH = join(testDir, "window.lock");
  ({ acquireLiveWindowLock, requireLiveWindowOptIn } = await import(`../scripts/live-test-guard.mjs?ts=${Date.now()}`));
});

afterEach(() => {
  for (const release of releases.reverse()) {
    try {
      release();
    } catch {}
  }
  releases = [];
  delete process.env.PI_SUBAGENT_LIVE_LOCK_PATH;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("live-test-guard", () => {
  it("refuses live window scripts unless explicitly opted in", () => {
    delete process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS;
    assert.throws(
      () => requireLiveWindowOptIn("test-e2e-live"),
      /PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1/,
    );

    process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS = "1";
    assert.doesNotThrow(() => requireLiveWindowOptIn("test-e2e-live"));
    delete process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS;
  });

  it("refuses a second live window lock while one is active", () => {
    const release = acquireLiveWindowLock("first-test");
    releases.push(release);

    assert.throws(
      () => acquireLiveWindowLock("second-test"),
      /Refusing to spawn another live terminal window/,
    );
  });

  it("allows reacquiring the lock after release", () => {
    const first = acquireLiveWindowLock("first-test");
    first();

    const second = acquireLiveWindowLock("second-test");
    releases.push(second);
    assert.equal(typeof second, "function");
  });
});
