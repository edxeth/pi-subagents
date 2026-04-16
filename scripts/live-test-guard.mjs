import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const LIVE_TEST_MODEL = process.env.PI_SUBAGENT_LIVE_MODEL ?? "zai-messages/glm-5-turbo:high";
const LIVE_WINDOW_LOCK = process.env.PI_SUBAGENT_LIVE_LOCK_PATH ?? join(tmpdir(), "pi-subagents-live-window.lock");

export function requireLiveWindowOptIn(script) {
  if (process.env.PI_SUBAGENT_ALLOW_LIVE_WINDOWS === "1") return;
  throw new Error(
    `Refusing to run ${script} without PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1. ` +
      "This live test spawns a real terminal window and tmux session.",
  );
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLiveWindowLock(script) {
  while (true) {
    try {
      const fd = openSync(LIVE_WINDOW_LOCK, "wx");
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, script, startedAt: new Date().toISOString() }),
        "utf8",
      );
      return () => {
        try {
          rmSync(LIVE_WINDOW_LOCK, { force: true });
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const current = JSON.parse(readFileSync(LIVE_WINDOW_LOCK, "utf8"));
        if (!isPidAlive(current?.pid)) {
          rmSync(LIVE_WINDOW_LOCK, { force: true });
          continue;
        }
        throw new Error(
          `Refusing to spawn another live terminal window while ${current?.script ?? "another live script"} is still running (pid ${current?.pid ?? "unknown"}).`,
        );
      } catch (readError) {
        if (readError instanceof Error && readError.message.startsWith("Refusing to spawn another live terminal window")) {
          throw readError;
        }
        rmSync(LIVE_WINDOW_LOCK, { force: true });
      }
    }
  }
}
