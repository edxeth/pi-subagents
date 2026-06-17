import {
	assert,
	closeSurface,
	createSurface,
	createSurfaceSplit,
	createTestDir,
	getMuxBackend,
	isHerdrAvailable,
	muxSetupHint,
	readFileSync,
	readScreen,
	readScreenAsync,
	renameCurrentTab,
	renameWorkspace,
	sendCommand,
	writeExecutable,
	writeFileSync,
	join,
	describe,
	it,
	ORIGINAL_ENV,
} from "../support/index.ts";

function installFakeHerdr(
	options: { compatible?: "yes" | "no"; serverStatus?: string } = {},
): { dir: string; logFile: string; screenFile: string } {
	const dir = createTestDir();
	const logFile = join(dir, "herdr.log");
	const screenFile = join(dir, "herdr-screen.txt");
	const compatible = options.compatible ?? "yes";
	const serverStatus = options.serverStatus ?? "running";
	writeFileSync(logFile, "");
	writeFileSync(screenFile, "herdr line 1\nherdr line 2\n");
	writeExecutable(
		dir,
		"herdr",
		`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_HERDR_LOG"
if [ "$1 $2 $3" = "status server --json" ]; then
  if [ -n "$FAKE_HERDR_STATUS" ]; then status_value="$FAKE_HERDR_STATUS"; else status_value="${serverStatus}"; fi
  if [ -n "$FAKE_HERDR_COMPATIBLE" ]; then compatible_value="$FAKE_HERDR_COMPATIBLE"; else compatible_value="${compatible}"; fi
  if [ "$status_value" = "running" ]; then running_json=true; else running_json=false; fi
  case "$compatible_value" in
    yes|true|1) compatible_json=true ;;
    *) compatible_json=false ;;
  esac
  printf '{"status":"%s","running":%s,"compatible":%s}\n' "$status_value" "$running_json" "$compatible_json"
  exit 0
fi
case "$1 $2" in
  "pane split")
    printf '{"id":"cli:pane:split","result":{"pane":{"pane_id":"pane-child","tab_id":"tab-1","workspace_id":"workspace-1"},"type":"pane_info"}}\n'
    ;;
  "pane get")
    printf '{"id":"cli:pane:get","result":{"pane":{"pane_id":"%s","tab_id":"tab-1","workspace_id":"workspace-1"},"type":"pane_info"}}\n' "$3"
    ;;
  "pane read")
    cat "$FAKE_HERDR_SCREEN"
    ;;
  "pane run")
    printf '%s\n' "$4" > "$FAKE_HERDR_SCREEN"
    ;;
  "pane rename"|"pane close"|"workspace rename")
    printf '{"id":"fake","result":{"type":"ok"}}\n'
    ;;
esac
`,
	);
	return { dir, logFile, screenFile };
}

function configureHerdrEnv(dir: string, logFile: string, screenFile: string): void {
	process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH ?? ""}`;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "pane-parent";
	process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr.sock";
	process.env.FAKE_HERDR_LOG = logFile;
	process.env.FAKE_HERDR_SCREEN = screenFile;
	delete process.env.FAKE_HERDR_COMPATIBLE;
	delete process.env.FAKE_HERDR_STATUS;
	delete process.env.HERDR_ACTIVE_PANE_ID;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.CMUX_SOCKET_PATH;
	delete process.env.TMUX;
	delete process.env.WEZTERM_UNIX_SOCKET;
	delete process.env.ZELLIJ;
	delete process.env.ZELLIJ_SESSION_NAME;
}

describe("herdr mux backend", () => {
	it("detects Herdr and prefers the current Herdr pane over outer muxes", () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		writeExecutable(dir, "tmux", "#!/bin/sh\nexit 0\n");
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.TMUX = "outer-tmux-socket";

		assert.equal(isHerdrAvailable(), true);
		assert.equal(getMuxBackend(), "herdr");

		process.env.PI_SUBAGENT_MUX = "herdr";
		assert.match(muxSetupHint(), /Herdr/);
	});

	it("detects Herdr from HERDR_ACTIVE_PANE_ID when HERDR_PANE_ID is absent", () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		configureHerdrEnv(dir, logFile, screenFile);
		delete process.env.HERDR_PANE_ID;
		process.env.HERDR_ACTIVE_PANE_ID = "pane-active";

		assert.equal(isHerdrAvailable(), true);
		assert.equal(getMuxBackend(), "herdr");
	});

	it("refuses Herdr when no current pane environment is set", () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		configureHerdrEnv(dir, logFile, screenFile);
		delete process.env.HERDR_PANE_ID;
		delete process.env.HERDR_ACTIVE_PANE_ID;

		assert.equal(isHerdrAvailable(), false);
		assert.equal(getMuxBackend(), null);
	});

	it("refuses Herdr when the server protocol is incompatible", () => {
		const { dir, logFile, screenFile } = installFakeHerdr({ compatible: "no" });
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.PI_SUBAGENT_MUX = "herdr";

		assert.equal(isHerdrAvailable(), false);
		assert.equal(getMuxBackend(), null);
	});

	it("refuses Herdr when the server is not running", () => {
		const { dir, logFile, screenFile } = installFakeHerdr({ serverStatus: "stopped" });
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.PI_SUBAGENT_MUX = "herdr";

		assert.equal(isHerdrAvailable(), false);
		assert.equal(getMuxBackend(), null);
	});

	it("re-probes Herdr status after an incompatible result", () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.FAKE_HERDR_COMPATIBLE = "no";

		assert.equal(isHerdrAvailable(), false);

		process.env.FAKE_HERDR_COMPATIBLE = "yes";
		assert.equal(isHerdrAvailable(), true);
	});

	it("creates, names, writes to, reads from, and closes Herdr panes", async () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.PI_SUBAGENT_MUX = "herdr";

		const surface = createSurface("Fake Herdr");
		assert.equal(surface, "pane-child");

		renameCurrentTab("Herdr Pane Title");
		renameWorkspace("Herdr Workspace");
		sendCommand(surface, "echo herdr");
		assert.match(readScreen(surface, 10), /echo herdr/);
		assert.match(await readScreenAsync(surface, 10), /echo herdr/);
		sendCommand(surface, "");
		closeSurface(surface);

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane split pane-parent --direction right --cwd .* --no-focus/);
		assert.match(log, /pane rename pane-child Fake Herdr/);
		assert.match(log, /pane rename pane-parent Herdr Pane Title/);
		assert.match(log, /pane get pane-parent/);
		assert.match(log, /workspace rename workspace-1 Herdr Workspace/);
		assert.match(log, /pane run pane-child echo herdr/);
		assert.match(log, /pane read pane-child --source visible --lines 10/);
		assert.match(log, /pane send-keys pane-child Enter/);
		assert.match(log, /pane close pane-child/);
	});

	it("splits Herdr panes from an explicit source while preserving axis", () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.PI_SUBAGENT_MUX = "herdr";

		const surface = createSurfaceSplit("Vertical Herdr", "up", "pane-source");
		assert.equal(surface, "pane-child");

		const log = readFileSync(logFile, "utf8");
		assert.match(log, /pane split pane-source --direction down --cwd .* --no-focus/);
		assert.match(log, /pane rename pane-child Vertical Herdr/);
	});

	it("renames Herdr workspaces from HERDR_WORKSPACE_ID when available", () => {
		const { dir, logFile, screenFile } = installFakeHerdr();
		configureHerdrEnv(dir, logFile, screenFile);
		process.env.HERDR_WORKSPACE_ID = "workspace-env";
		process.env.PI_SUBAGENT_MUX = "herdr";

		renameWorkspace("Herdr Env Workspace");

		const log = readFileSync(logFile, "utf8");
		assert.doesNotMatch(log, /pane get pane-parent/);
		assert.match(log, /workspace rename workspace-env Herdr Env Workspace/);
	});
});
