import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

// One-shot child launcher. Reads the launch capsule written by the parent pi
// process, deletes it, and spawns the child with the merged environment:
//
//   child env = parent snapshot -> pane identity -> controlled overrides
//
// Env data crosses this boundary as JSON, never as shell source, so values and
// names with shell-hostile characters cannot become code. This file must stay
// plain JavaScript with no package imports: it runs under whatever runtime the
// parent used, in whatever shell the mux pane provided.

const capsulePath = process.argv[2];
if (!capsulePath) {
	process.stderr.write("run-child: missing capsule path\n");
	process.exit(2);
}

let capsuleSource;
try {
	// One-shot even on malformed input: consume the file before parsing it.
	capsuleSource = readFileSync(capsulePath, "utf8");
	unlinkSync(capsulePath);
	try {
		rmdirSync(dirname(capsulePath));
	} catch {
		// Directory not empty or already gone; the file itself is consumed.
	}
} catch (error) {
	process.stderr.write(`run-child: cannot read capsule ${capsulePath}: ${error?.message ?? error}\n`);
	process.exit(2);
}

let capsule;
try {
	capsule = JSON.parse(capsuleSource);
} catch (error) {
	process.stderr.write(`run-child: cannot parse capsule ${capsulePath}: ${error?.message ?? error}\n`);
	process.exit(2);
}

function envNameMatches(name, pattern) {
	if (!pattern.includes("*")) return name === pattern;
	const segments = pattern.split("*");
	let cursor = 0;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (index === 0) {
			if (!name.startsWith(segment)) return false;
			cursor = segment.length;
			continue;
		}
		if (index === segments.length - 1) {
			return name.slice(cursor).endsWith(segment);
		}
		const found = name.indexOf(segment, cursor);
		if (found === -1) return false;
		cursor = found + segment.length;
	}
	return true;
}

function pickPaneIdentity(paneEnv, patterns) {
	const picked = {};
	if (!Array.isArray(patterns)) return picked;
	for (const [key, value] of Object.entries(paneEnv)) {
		if (typeof value !== "string" || value === "") continue;
		if (patterns.some((pattern) => typeof pattern === "string" && envNameMatches(key, pattern))) {
			picked[key] = value;
		}
	}
	return picked;
}

function mergeEnv(parts) {
	const env = {};
	for (const part of parts) Object.assign(env, part);
	for (const key of Object.keys(env)) {
		if (key.includes("=") || key.includes("\0") || typeof env[key] !== "string") delete env[key];
	}
	return env;
}

const env = mergeEnv([capsule.parentEnv, pickPaneIdentity(process.env, capsule.paneIdentityKeys), capsule.overrides]);
if (capsule.deriveZellijPaneSurface && typeof process.env.ZELLIJ_PANE_ID === "string" && process.env.ZELLIJ_PANE_ID) {
	env.PI_SUBAGENT_SURFACE = `pane:${process.env.ZELLIJ_PANE_ID}`;
}

const child = spawn(capsule.command, capsule.args, {
	cwd: capsule.cwd || undefined,
	env,
	stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
	process.stderr.write(`run-child: ${error?.message ?? error}\n`);
	process.exit(1);
});

child.on("exit", (code, signal) => {
	if (signal) {
		// Re-raise with default handlers so the launcher dies by the same signal;
		// our forwarders would otherwise swallow the self-kill and exit 0.
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(name);
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 1);
	}
});
