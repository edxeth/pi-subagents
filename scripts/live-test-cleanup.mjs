import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

export function installLiveTestCleanup({
  hasTmuxSession,
  execTmux,
  tmuxSession,
  ghostty,
  releaseLiveWindowLock,
  keepTmp,
  tmpRoot,
  keepLabel,
}) {
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (hasTmuxSession()) execTmux(["kill-session", "-t", tmuxSession]);
    } catch {}
    try {
      ghostty.kill("SIGTERM");
    } catch {}
    try {
      ghostty.kill("SIGKILL");
    } catch {}
    try {
      execFileSync("pkill", ["-f", tmpRoot], { stdio: "ignore" });
    } catch {}
    try {
      releaseLiveWindowLock();
    } catch {}
    if (!keepTmp) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    } else {
      console.error(`${keepLabel}: ${tmpRoot}`);
    }
  };

  process.on("exit", cleanup);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(1);
    });
  }
  process.on("uncaughtException", (error) => {
    cleanup();
    throw error;
  });
  process.on("unhandledRejection", (error) => {
    cleanup();
    throw error;
  });

  return cleanup;
}
