import {
	createHerdrTabSurface,
	getHerdrCurrentPane,
	listHerdrTabs,
	renameHerdrTab,
	renameHerdrWorkspace,
	splitHerdrPane,
} from "./herdr.ts";

type SurfaceSplitDirection = "left" | "right" | "up" | "down";

function assertSupportedHerdrSplitDirection(
	direction: SurfaceSplitDirection,
): asserts direction is "right" | "down" {
	if (direction === "right" || direction === "down") return;
	throw new Error(
		`Herdr split direction "${direction}" is unsupported; Herdr pane split supports only right and down`,
	);
}

function cleanNumberedHerdrTabTitle(title: string): string {
	return title.replace(/^\d+:\s*/, "").trim();
}

function isAgentTabTitle(title: string): boolean {
	return /^\[[^\]\r\n]+\](?:\s|$)/.test(cleanNumberedHerdrTabTitle(title));
}

function numberedHerdrTabTitle(title: string, tabNumber: number | undefined): string {
	const cleanTitle = cleanNumberedHerdrTabTitle(title);
	if (isAgentTabTitle(cleanTitle)) return cleanTitle;
	if (tabNumber === undefined) return title;
	return `${tabNumber}: ${cleanTitle}`;
}

function isSubagentProcess(): boolean {
	return !!(process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_SESSION);
}

function herdrTabPosition(workspaceId: string, tabId: string): number | undefined {
	const tabs = listHerdrTabs(workspaceId);
	const index = tabs.findIndex((tab) => tab.tabId === tabId);
	return index === -1 ? undefined : index + 1;
}

export function createHerdrSurface(name: string): string {
	const parentPane = getHerdrCurrentPane();
	const surface = createHerdrTabSurface({
		label: name,
		cwd: process.cwd(),
		workspaceId: parentPane.workspaceId,
		focus: false,
	});

	if (parentPane.tabId && surface.tab.tabId === parentPane.tabId) {
		throw new Error(
			`Herdr tab create returned the parent tab ${parentPane.tabId}; expected a non-shrinking new tab`,
		);
	}

	const tabNumber = !isAgentTabTitle(name) && parentPane.workspaceId
		? herdrTabPosition(parentPane.workspaceId, surface.tab.tabId)
		: undefined;
	renameHerdrTab(surface.tab.tabId, numberedHerdrTabTitle(name, tabNumber));
	return surface.pane.paneId;
}

export function createHerdrSplit(
	_name: string,
	direction: SurfaceSplitDirection,
	fromSurface?: string,
): string {
	assertSupportedHerdrSplitDirection(direction);
	return splitHerdrPane({
		paneId: fromSurface,
		direction,
		cwd: process.cwd(),
		focus: false,
	}).paneId;
}

function currentHerdrTabId(): string {
	const envTabId = process.env.HERDR_TAB_ID?.trim();
	if (envTabId) return envTabId;
	const tabId = getHerdrCurrentPane().tabId;
	if (!tabId) throw new Error("Herdr current pane did not report a tab id");
	return tabId;
}

function currentHerdrWorkspaceId(): string {
	const envWorkspaceId = process.env.HERDR_WORKSPACE_ID?.trim();
	if (envWorkspaceId) return envWorkspaceId;
	const workspaceId = getHerdrCurrentPane().workspaceId;
	if (!workspaceId) {
		throw new Error("Herdr current pane did not report a workspace id");
	}
	return workspaceId;
}

export function renameHerdrCurrentTab(title: string): void {
	const tabId = currentHerdrTabId();
	if (!isSubagentProcess()) {
		renameHerdrTab(tabId, title);
		return;
	}
	if (isAgentTabTitle(title)) {
		renameHerdrTab(tabId, cleanNumberedHerdrTabTitle(title));
		return;
	}
	const workspaceId = currentHerdrWorkspaceId();
	renameHerdrTab(tabId, numberedHerdrTabTitle(title, herdrTabPosition(workspaceId, tabId)));
}

export function renameHerdrCurrentWorkspace(title: string): void {
	renameHerdrWorkspace(currentHerdrWorkspaceId(), title);
}
