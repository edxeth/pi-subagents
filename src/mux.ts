// Re-export Zellij discovery lifecycle hooks here so extension wiring does not
// depend on the private module layout of the mux implementation.
export {
	exitStatusVar,
	getMuxBackend,
	getZellijRuntimeError,
	initializeZellijRuntimeContext,
	isCmuxAvailable,
	isFishShell,
	isHerdrAvailable,
	isMuxAvailable,
	isTmuxAvailable,
	isZellijAvailable,
	muxSetupHint,
	resetZellijRuntimeContext,
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
