import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function resolveArtifactProjectRoot(cwd: string): string {
  const envRoot = process.env.PI_ARTIFACT_PROJECT_ROOT?.trim();
  if (envRoot) return resolve(envRoot);

  let dir = resolve(cwd);
  let packageRoot: string | null = null;

  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    if (!packageRoot && existsSync(join(dir, "package.json"))) {
      packageRoot = dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return packageRoot ?? resolve(cwd);
    }
    dir = parent;
  }
}

export function getArtifactProjectName(cwd: string): string {
  return basename(resolveArtifactProjectRoot(cwd));
}

export function getProjectArtifactsDir(cwd: string): string {
  return join(homedir(), ".pi", "history", getArtifactProjectName(cwd), "artifacts");
}

export function getSessionArtifactDir(cwd: string, sessionId: string): string {
  return join(getProjectArtifactsDir(cwd), sessionId);
}

export function resolveSessionArtifactPath(cwd: string, sessionId: string, name: string): string {
  return resolve(getSessionArtifactDir(cwd, sessionId), name);
}
