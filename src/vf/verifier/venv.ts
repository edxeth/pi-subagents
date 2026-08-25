import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgentConfigDir } from "../../agents/definitions.ts";
import { fileURLToPath } from "node:url";

/**
 * Managed Python runtime for the verifier bridge.
 *
 * A private, versioned venv is provisioned on first use (prefer `uv`, else
 * `python3 -m venv`) with the pinned `llm-verifier` version, so scoring is
 * reproducible and the user's own Python is untouched. The venv is reused
 * across runs via a marker file; the bridge script itself ships next to this
 * module and is executed by the venv's interpreter.
 */

export const LLM_VERIFIER_VERSION = "0.2.0";

export const RUNNER_SCRIPT_PATH = fileURLToPath(new URL("./runner.py", import.meta.url));

export class VerifierRuntimeError extends Error {
	/** Concrete commands the user can run to repair the runtime. */
	readonly repairSteps: string[];

	constructor(message: string, repairSteps: string[]) {
		super(message);
		this.name = "VerifierRuntimeError";
		this.repairSteps = repairSteps;
	}
}

export interface VerifierRuntimeInfo {
	/** Root holding the versioned venv + marker. */
	root: string;
	/** The venv directory (`<root>/venv`). */
	venvDir: string;
	/** Absolute path of the venv's python interpreter. */
	python: string;
	/** Tool that provisioned the venv (`uv` | `python3-venv`). */
	provisioner: string;
	/** Pinned library version the marker recorded. */
	version: string;
	/** True when an existing venv was reused (no install ran). */
	reused: boolean;
}

interface Marker {
	version: string;
	provisioner: string;
	createdAt: string;
}

export function getVerifierVenvRoot(): string {
	if (process.env.PI_SUBAGENT_LLM_VERIFIER_VENV?.trim()) {
		return process.env.PI_SUBAGENT_LLM_VERIFIER_VENV.trim();
	}
	return join(getAgentConfigDir(), "llm-verifier-venv");
}

function venvPython(venvDir: string): string {
	return join(venvDir, "bin", "python");
}

function findBinary(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		} catch {
			// Unreadable PATH entry: skip it.
		}
	}
	return null;
}

function runCaptured(command: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
	return spawnSync(command, args, {
		encoding: "utf8",
		cwd: options.cwd,
		timeout: options.timeoutMs ?? 300_000,
	});
}

function tail(text: string | undefined, lines = 6): string {
	if (!text) return "";
	return text
		.trim()
		.split(/\r?\n/)
		.slice(-lines)
		.join("\n");
}

function validateInstalled(python: string): { ok: boolean; version: string | null; error: string | null } {
	const probe = runCaptured(python, ["-c", "import llm_verifier; print(llm_verifier.__version__)"], {
		timeoutMs: 30_000,
	});
	if (probe.status !== 0) {
		return { ok: false, version: null, error: tail(probe.stderr || probe.stdout) };
	}
	const version = probe.stdout.trim();
	if (version !== LLM_VERIFIER_VERSION) {
		return { ok: false, version, error: `installed llm-verifier ${version} != pinned ${LLM_VERIFIER_VERSION}` };
	}
	return { ok: true, version, error: null };
}

function readMarker(root: string): Marker | null {
	try {
		const parsed = JSON.parse(readFileSync(join(root, "marker.json"), "utf8")) as Marker;
		if (parsed && typeof parsed.version === "string" && typeof parsed.provisioner === "string") return parsed;
} catch {
		// Missing or corrupt marker: fall through and re-provision.
	}
	return null;
}

function installWithUv(root: string, uv: string): { provisioner: string; python: string } {
	const venvDir = join(root, "venv");
	const create = runCaptured(uv, ["venv", venvDir]);
	if (create.status !== 0) {
		throw new VerifierRuntimeError(`uv venv failed to create the verifier venv:\n${tail(create.stderr)}`, [
			`Retry manually: ${uv} venv ${venvDir}`,
			`Then: ${uv} pip install --python ${venvPython(venvDir)} llm-verifier==${LLM_VERIFIER_VERSION}`,
			`Or set PI_SUBAGENT_LLM_VERIFIER_VENV to a pre-provisioned venv root.`,
		]);
	}
	const python = venvPython(venvDir);
	const install = runCaptured(uv, [
		"pip",
		"install",
		"--python",
		python,
		`llm-verifier==${LLM_VERIFIER_VERSION}`,
	]);
	if (install.status !== 0) {
		throw new VerifierRuntimeError(
			`uv pip install llm-verifier==${LLM_VERIFIER_VERSION} failed (network, index, or disk). Installer output:\n${tail(install.stderr || install.stdout)}`,
			[
				`Retry manually: ${uv} pip install --python ${python} llm-verifier==${LLM_VERIFIER_VERSION}`,
				"Check network access to pypi.org, or set PI_SUBAGENT_LLM_VERIFIER_VENV to a pre-provisioned venv root.",
			],
		);
	}
	return { provisioner: "uv", python };
}

function installWithPythonVenv(root: string, python3: string): { provisioner: string; python: string } {
	const venvDir = join(root, "venv");
	const create = runCaptured(python3, ["-m", "venv", venvDir]);
	if (create.status !== 0) {
		throw new VerifierRuntimeError(`python3 -m venv failed to create the verifier venv:\n${tail(create.stderr)}`, [
			`Install the venv module (e.g. Debian/Ubuntu: apt install python3-venv) or install uv.`,
			`Retry manually: ${python3} -m venv ${venvDir}`,
		]);
	}
	const python = venvPython(venvDir);
	const pip = runCaptured(python, ["-m", "pip", "install", "--no-input", "--quiet", `llm-verifier==${LLM_VERIFIER_VERSION}`]);
	if (pip.status !== 0) {
		throw new VerifierRuntimeError(
			`pip install llm-verifier==${LLM_VERIFIER_VERSION} failed (network, index, or disk). Installer output:\n${tail(pip.stderr || pip.stdout)}`,
			[
				`Retry manually: ${python} -m pip install llm-verifier==${LLM_VERIFIER_VERSION}`,
				"Check network access to pypi.org, or set PI_SUBAGENT_LLM_VERIFIER_VENV to a pre-provisioned venv root.",
			],
		);
	}
	return { provisioner: "python3-venv", python };
}

/**
 * Ensure the managed verifier venv exists, has the pinned library version,
 * and is usable. Concurrent callers coordinate through a lock file; the
 * loser waits for the winner's marker instead of double-installing.
 */
export function ensureVerifierRuntime(options: { timeoutMs?: number } = {}): VerifierRuntimeInfo {
	if (process.platform === "win32") {
		throw new VerifierRuntimeError("Verified fan-out supports Linux and macOS only.", ["Run from a Linux or macOS host."]);
	}
	const root = getVerifierVenvRoot();
	mkdirSync(root, { recursive: true });
	const marker = readMarker(root);
	const python = venvPython(join(root, "venv"));
	if (marker && marker.version === LLM_VERIFIER_VERSION && existsSync(python)) {
		const validation = validateInstalled(python);
		if (validation.ok) {
			return { root, venvDir: join(root, "venv"), python, provisioner: marker.provisioner, version: marker.version, reused: true };
		}
		// Version drift or a broken install: re-provision from scratch.
		rmSync(join(root, "venv"), { recursive: true, force: true });
	}

	const lockPath = join(root, "install.lock");
	const lockAcquired = tryCreateLock(lockPath);
	if (!lockAcquired) {
		const appeared = waitForMarker(root, options.timeoutMs ?? 300_000);
		if (appeared) {
			const again = ensureVerifierRuntime({ timeoutMs: options.timeoutMs });
			return again;
		}
		throw new VerifierRuntimeError(
			`Another process is provisioning the verifier venv at ${root} and did not finish in time.`,
			[`Delete ${lockPath} if no install is actually running, then retry the launch.`],
		);
	}

	try {
		rmSync(join(root, "venv"), { recursive: true, force: true });
		const uv = findBinary("uv");
		const installed = uv
			? installWithUv(root, uv)
			: installWithPythonVenv(root, findBinary("python3") ?? "python3");
		const validation = validateInstalled(installed.python);
		if (!validation.ok) {
			throw new VerifierRuntimeError(
				`The verifier venv was created but the library failed validation: ${validation.error ?? "unknown error"}`,
				[
					`Reinstall manually: ${installed.python} -m pip install --force-reinstall llm-verifier==${LLM_VERIFIER_VERSION}`,
					`Or set PI_SUBAGENT_LLM_VERIFIER_VENV to a pre-provisioned venv root.`,
				],
			);
		}
		const nextMarker: Marker = {
			version: LLM_VERIFIER_VERSION,
			provisioner: installed.provisioner,
			createdAt: new Date().toISOString(),
		};
		writeFileSync(join(root, "marker.json"), `${JSON.stringify(nextMarker, null, "\t")}\n`);
		return {
			root,
			venvDir: join(root, "venv"),
			python: installed.python,
			provisioner: installed.provisioner,
			version: LLM_VERIFIER_VERSION,
			reused: false,
		};
	} finally {
		try {
			rmSync(lockPath, { force: true });
		} catch {
			// Best effort: a stale lock is recoverable via timeout.
		}
	}
}

function tryCreateLock(lockPath: string): boolean {
	try {
		const fd = openSync(lockPath, "wx");
		writeSync(fd, `${process.pid}\n`);
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function waitForMarker(root: string, timeoutMs: number): boolean {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const marker = readMarker(root);
		if (marker && marker.version === LLM_VERIFIER_VERSION && existsSync(venvPython(join(root, "venv")))) return true;
		// Synchronous sleep without a subprocess: the caller expects this
		// function to block until the concurrent install finishes.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
	}
	return readMarker(root)?.version === LLM_VERIFIER_VERSION;
}
