export {
	exitStatusVar,
	getMuxBackend,
	isCmuxAvailable,
	isFishShell,
	isHerdrAvailable,
	isMuxAvailable,
	isTmuxAvailable,
	isZellijAvailable,
	muxSetupHint,
	shellEscape,
} from "./mux/core.ts";
export {
	createSurface,
	createSurfaceSplit,
	renameCurrentTab,
	renameWorkspace,
} from "./mux/surfaces.ts";
export { resolveZellijPlacementPolicy } from "./mux/zellij-placement.ts";
export {
	closeSurface,
	readScreen,
	readScreenAsync,
	sendCommand,
	sendShellCommand,
} from "./mux/io.ts";
export { consumeSubagentExitSignal, pollForExit } from "./mux/poll.ts";
