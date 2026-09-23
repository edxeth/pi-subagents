import {
	buildStagedShellCommand,
	classifyPaneShell,
	classifyPaneShells,
	defaultPaneShellKind,
	isWslBashPath,
	posixInterpreterSetupHint,
	resolveStagedShellPlan,
	resolveWindowsPosixInterpreter,
} from "../../src/mux/staged-shell.ts";
import { assert, describe, it } from "../support/index.ts";

const GIT_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
const WSL_BASH = "C:\\Windows\\System32\\bash.exe";

function probe(options: {
	env?: Record<string, string | undefined>;
	present?: string[];
	which?: string[];
}) {
	const env = options.env ?? {};
	const present = new Set((options.present ?? []).map((entry) => entry.toLowerCase()));
	return {
		getEnv: (name: string) => env[name],
		exists: (path: string) => present.has(path.toLowerCase()),
		whichAll: () => options.which ?? [],
	};
}

describe("staged shell pane classification", () => {
	it("classifies PowerShell, cmd, and POSIX pane processes by executable name", () => {
		assert.equal(classifyPaneShell("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"), "powershell");
		assert.equal(classifyPaneShell("powershell.EXE"), "powershell");
		assert.equal(classifyPaneShell("cmd.exe"), "cmd");
		assert.equal(classifyPaneShell("C:\\Program Files\\Git\\usr\\bin\\bash.exe"), "posix");
		assert.equal(classifyPaneShell("/bin/zsh"), "posix");
		assert.equal(classifyPaneShell("fish"), "posix");
	});

	it("returns undefined for unknown or empty process names", () => {
		assert.equal(classifyPaneShell(undefined), undefined);
		assert.equal(classifyPaneShell(""), undefined);
		assert.equal(classifyPaneShell("node.exe"), undefined);
	});

	it("takes the first recognized shell when a busy pane also reports a program", () => {
		assert.equal(classifyPaneShells(["node.exe", "pwsh.exe"]), "powershell");
		assert.equal(classifyPaneShells(["node.exe"]), undefined);
		assert.equal(classifyPaneShells([]), undefined);
	});

	it("defaults to PowerShell on win32 and POSIX elsewhere", () => {
		assert.equal(defaultPaneShellKind("win32"), "powershell");
		assert.equal(defaultPaneShellKind("linux"), "posix");
		assert.equal(defaultPaneShellKind("darwin"), "posix");
	});
});

describe("staged shell command construction", () => {
	it("keeps the POSIX line unchanged for POSIX panes", () => {
		assert.equal(
			buildStagedShellCommand("/tmp/pi-subagent-shell-1.sh", { kind: "posix" }),
			"'/tmp/pi-subagent-shell-1.sh'; rm -f '/tmp/pi-subagent-shell-1.sh'",
		);
	});

	it("invokes the interpreter through the PowerShell call operator and deletes with Remove-Item", () => {
		const command = buildStagedShellCommand("C:\\Temp\\pi-subagent-shell-1.sh", {
			kind: "powershell",
			interpreter: GIT_BASH,
		});
		assert.equal(
			command,
			`& '${GIT_BASH}' 'C:\\Temp\\pi-subagent-shell-1.sh'; Remove-Item -Force 'C:\\Temp\\pi-subagent-shell-1.sh'`,
		);
		assert.ok(command.startsWith("& "), "a bare quoted path is a string literal in PowerShell");
		assert.ok(!command.includes("rm -f"), "rm -f resolves to Remove-Item, whose -f is ambiguous");
	});

	it("escapes single quotes in PowerShell paths by doubling them", () => {
		const command = buildStagedShellCommand("C:\\Temp\\it's\\script.sh", {
			kind: "powershell",
			interpreter: GIT_BASH,
		});
		assert.ok(command.includes("'C:\\Temp\\it''s\\script.sh'"));
	});

	it("uses double quotes and del for cmd panes", () => {
		assert.equal(
			buildStagedShellCommand("C:\\Temp\\script.sh", { kind: "cmd", interpreter: GIT_BASH }),
			`"${GIT_BASH}" "C:\\Temp\\script.sh" & del /f /q "C:\\Temp\\script.sh"`,
		);
	});

	it("refuses to build a non-POSIX line without an interpreter", () => {
		assert.throws(() => buildStagedShellCommand("C:\\Temp\\script.sh", { kind: "powershell" }), /POSIX interpreter/);
	});
});

describe("windows POSIX interpreter resolution", () => {
	it("prefers PI_SUBAGENT_WIN_BASH when it exists", () => {
		const custom = "D:\\tools\\bash.exe";
		assert.equal(
			resolveWindowsPosixInterpreter(
				probe({ env: { PI_SUBAGENT_WIN_BASH: custom }, present: [custom, GIT_BASH], which: [GIT_BASH] }),
			),
			custom,
		);
	});

	it("does not silently fall back when PI_SUBAGENT_WIN_BASH is wrong", () => {
		assert.equal(
			resolveWindowsPosixInterpreter(
				probe({ env: { PI_SUBAGENT_WIN_BASH: "D:\\missing\\bash.exe" }, present: [GIT_BASH], which: [GIT_BASH] }),
			),
			undefined,
		);
	});

	it("skips WSL bash on PATH and takes the next real POSIX shell", () => {
		assert.ok(isWslBashPath(WSL_BASH));
		assert.ok(isWslBashPath("C:/Windows/Sysnative/bash.exe"));
		assert.ok(!isWslBashPath(GIT_BASH));
		assert.equal(
			resolveWindowsPosixInterpreter(probe({ present: [WSL_BASH, GIT_BASH], which: [WSL_BASH, GIT_BASH] })),
			GIT_BASH,
		);
	});

	it("falls back to known install roots when PATH has no usable bash", () => {
		assert.equal(
			resolveWindowsPosixInterpreter(
				probe({ env: { ProgramFiles: "C:\\Program Files" }, present: [GIT_BASH], which: [WSL_BASH] }),
			),
			GIT_BASH,
		);
		assert.equal(
			resolveWindowsPosixInterpreter(
				probe({
					env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
					present: ["C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe"],
				}),
			),
			"C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe",
		);
	});

	it("returns undefined when nothing usable exists", () => {
		assert.equal(resolveWindowsPosixInterpreter(probe({ which: [WSL_BASH], present: [WSL_BASH] })), undefined);
	});
});

describe("staged shell plan", () => {
	it("uses the reported pane shell over the platform default", () => {
		const plan = resolveStagedShellPlan(["bash.exe"], probe({ present: [GIT_BASH], which: [GIT_BASH] }), "win32");
		assert.deepEqual(plan, { kind: "posix" });
	});

	it("plans a PowerShell launch for a pwsh pane", () => {
		const plan = resolveStagedShellPlan(["pwsh.exe"], probe({ present: [GIT_BASH], which: [GIT_BASH] }), "win32");
		assert.deepEqual(plan, { kind: "powershell", interpreter: GIT_BASH });
	});

	it("falls back to the platform default when the pane reports no known shell", () => {
		const plan = resolveStagedShellPlan(["node.exe"], probe({ present: [GIT_BASH], which: [GIT_BASH] }), "win32");
		assert.equal(plan.kind, "powershell");
		assert.deepEqual(resolveStagedShellPlan([], probe({}), "linux"), { kind: "posix" });
	});

	it("fails loudly instead of staging a script no shell can run", () => {
		assert.throws(
			() => resolveStagedShellPlan(["pwsh.exe"], probe({ which: [WSL_BASH], present: [WSL_BASH] }), "win32"),
			/PI_SUBAGENT_WIN_BASH/,
		);
	});

	it("names the bad override in the hint when one is set", () => {
		const hint = posixInterpreterSetupHint((name) =>
			name === "PI_SUBAGENT_WIN_BASH" ? "D:\\missing\\bash.exe" : undefined,
		);
		assert.ok(hint.includes("D:\\missing\\bash.exe"));
	});
});
