import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, Key, type Component, type EditorTheme } from "@earendil-works/pi-tui";
import { completedSubagentResults } from "../../runtime/state.ts";
import { resumeSubagentSession, type ResumeServiceRuntime } from "../../runtime/resume-service.ts";
import type { RunningSubagent, SubagentResult } from "../../types.ts";
import type { OverlayContext, OverlayItem, OverlayState, OverlayTui, TabId, Theme } from "./render-types.ts";
import { TABS } from "./render-types.ts";
import { renderHeader, renderFooter, getFooterHints } from "./render-frame.ts";
import { getItemRowCount, renderList } from "./render-list.ts";
import { renderDetail, getMaxScroll } from "./render-detail.ts";
import { buildRunningItems, buildCompletedItems, buildAgentItems } from "./data.ts";
import { fitLine } from "./render-helpers.ts";

export interface OverlayRuntime extends ResumeServiceRuntime {
	pi: ExtensionAPI;
	wireSubagentSteerBack: (
		pi: ExtensionAPI,
		r: RunningSubagent,
		p: Promise<SubagentResult>,
	) => void;
}

const TAB_ORDER: TabId[] = ["running", "completed", "agents"];
const FALLBACK_BODY_HEIGHT = 24;

export class SubagentsOverlayController implements Component {
	private completedLoadId = 0;
	private ctx: ExtensionContext;
	private done: (result: null) => void;
	private editor: Editor;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private runtime: OverlayRuntime;
	private theme: Theme;
	private tui: OverlayTui;
	private state: OverlayState = {
		activeTab: "running",
		selectedIndex: 0,
		view: { kind: "list" },
		items: [],
		listScroll: { running: 0, completed: 0, agents: 0 },
		loading: false,
	};

	constructor(
		done: (result: null) => void,
		ctx: ExtensionContext,
		theme: Theme,
		runtime: OverlayRuntime,
		tui: OverlayTui,
	) {
		this.done = done;
		this.ctx = ctx;
		this.theme = theme;
		this.runtime = runtime;
		this.tui = tui;
		this.editor = new Editor(tui, createEditorTheme(theme), { paddingX: 1 });
		this.editor.onSubmit = (text) => this.submitResume(text);
		runtime.startWidgetRefresh();
		this.refreshItems();
		this.refreshTimer = setInterval(() => {
			this.refreshItems();
			this.requestRender();
		}, 1000);
	}

	dispose(): void {
		if (!this.refreshTimer) return;
		clearInterval(this.refreshTimer);
		this.refreshTimer = null;
	}

	close(): void {
		this.dispose();
		this.done(null);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.alt("s"))) {
			this.close();
			return;
		}

		if (this.state.view.kind === "detail") this.handleDetailInput(data);
		else if (this.state.view.kind === "editor") this.handleEditorInput(data);
		else this.handleListInput(data);

		this.requestRender();
	}

	render(width: number): string[] {
		const lines = renderHeader(this.state, TABS, this.theme, width);
		const bodyHeight = this.bodyHeight();
		if (this.state.view.kind === "detail") {
			lines.push(...renderDetail(this.state.view.item, this.state.view.scroll, this.theme, width, bodyHeight));
		} else if (this.state.view.kind === "editor") {
			const item = this.state.items[this.state.view.itemIndex];
			if (item) lines.push(...this.renderEditorView(item, width));
		} else {
			lines.push(...renderList(this.state, this.theme, width, bodyHeight, this.state.listScroll[this.state.activeTab]));
		}
		lines.push(...renderFooter(getFooterHints(this.state), this.theme, width));
		return lines.map((line) => fitLine(line, width));
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		if (matchesKey(data, Key.left)) return this.switchTab(-1);
		if (matchesKey(data, Key.right)) return this.switchTab(1);
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) return this.moveSelection(-1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) return this.moveSelection(1);

		const item = this.selectedItem();
		if (!item) return;
		if (matchesKey(data, Key.enter) || matchesKey(data, "i")) {
			this.state.view = { kind: "detail", item, scroll: 0 };
			return;
		}
		if (matchesKey(data, "x") && item.canKill && item.onKill) {
			void item.onKill().finally(() => {
				this.refreshItems();
				this.requestRender();
			});
			return;
		}
		if (matchesKey(data, "m") && item.canResume) {
			this.editor.setText("");
			this.state.view = { kind: "editor", itemIndex: this.state.selectedIndex };
		}
	}

	private handleDetailInput(data: string): void {
		if (this.state.view.kind !== "detail") return;
		if (matchesKey(data, Key.escape)) {
			this.state.view = { kind: "list" };
			return;
		}
		const item = this.state.view.item;
		const maxScroll = getMaxScroll(item, this.tui.terminal?.columns ?? 80, this.bodyHeight());
		if ((matchesKey(data, Key.down) || matchesKey(data, "j")) && this.state.view.scroll < maxScroll) {
			this.state.view = { ...this.state.view, scroll: this.state.view.scroll + 1 };
		}
		if ((matchesKey(data, Key.up) || matchesKey(data, "k")) && this.state.view.scroll > 0) {
			this.state.view = { ...this.state.view, scroll: this.state.view.scroll - 1 };
		}
	}

	private handleEditorInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.state.view = { kind: "list" };
			return;
		}
		this.editor.disableSubmit = false;
		this.editor.handleInput(data);
	}

	private renderEditorView(item: OverlayItem, width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const editorLines = this.editor.render(innerWidth);
		const lines = [
			` ${this.theme.fg("accent", "▸")} Resume ${this.theme.bold(item.name)}`,
			`   ${this.theme.fg("muted", "Write a follow-up message. Enter sends, Esc cancels.")}`,
			"",
		];

		for (const line of editorLines) {
			lines.push(`  ${this.theme.bg("selectedBg", line)}`);
		}
		if (!this.editor.getText()) {
			lines.push(`  ${this.theme.fg("dim", "Message…")}`);
		}
		return lines.map((line) => fitLine(line, width));
	}

	private switchTab(direction: -1 | 1): void {
		const nextIndex = TAB_ORDER.indexOf(this.state.activeTab) + direction;
		if (nextIndex < 0 || nextIndex >= TAB_ORDER.length) return;
		this.state.activeTab = TAB_ORDER[nextIndex];
		this.state.selectedIndex = 0;
		this.state.view = { kind: "list" };
		this.refreshItems();
	}

	private moveSelection(direction: -1 | 1): void {
		this.state.selectedIndex = Math.max(
			0,
			Math.min(this.state.items.length - 1, this.state.selectedIndex + direction),
		);
		this.keepSelectionVisible();
	}

	private refreshItems(): void {
		const overlayCtx: OverlayContext = {
			ui: this.ctx.ui,
			cwd: this.ctx.cwd,
			sessionManager: this.ctx.sessionManager,
		};

		if (this.state.activeTab === "running") {
			this.state.items = buildRunningItems(overlayCtx);
			this.state.loading = false;
			this.clampSelection();
			return;
		}
		if (this.state.activeTab === "agents") {
			this.state.items = buildAgentItems(overlayCtx);
			this.state.loading = false;
			this.clampSelection();
			return;
		}

		const loadId = ++this.completedLoadId;
		this.state.loading = this.state.items.length === 0;
		void buildCompletedItems(overlayCtx).then((items) => {
			if (loadId !== this.completedLoadId || this.state.activeTab !== "completed") return;
			this.state.items = items;
			this.state.loading = false;
			this.clampSelection();
			this.requestRender();
		});
	}

	private clampSelection(): void {
		this.state.selectedIndex = Math.max(0, Math.min(this.state.selectedIndex, this.state.items.length - 1));
		this.keepSelectionVisible();
	}

	private keepSelectionVisible(): void {
		const height = this.bodyHeight();
		const width = this.tui.terminal?.columns ?? 80;
		let start = 0;
		for (let i = 0; i < this.state.selectedIndex; i++) {
			start += getItemRowCount(this.state.items[i], this.state.activeTab, width);
		}
		const selectedHeight = this.state.items[this.state.selectedIndex]
			? getItemRowCount(this.state.items[this.state.selectedIndex], this.state.activeTab, width)
			: 1;
		const end = start + selectedHeight;
		const current = this.state.listScroll[this.state.activeTab] ?? 0;
		let next = current;
		if (start < current) next = start;
		else if (end > current + height) next = Math.max(0, end - height);
		this.state.listScroll = { ...this.state.listScroll, [this.state.activeTab]: next };
	}

	private bodyHeight(): number {
		const rows = this.tui.terminal?.rows;
		if (!rows) return FALLBACK_BODY_HEIGHT;
		return Math.max(6, Math.min(FALLBACK_BODY_HEIGHT, rows - 12));
	}

	private selectedItem(): OverlayItem | undefined {
		return this.state.items[this.state.selectedIndex];
	}

	private submitResume(rawText: string): void {
		const text = rawText.trim();
		if (!text || this.state.view.kind !== "editor") return;
		const item = this.state.items[this.state.view.itemIndex];
		this.state.view = { kind: "list" };
		if (!item?.sessionFile) {
			this.ctx.ui.notify("No session file.", "error");
			return;
		}
		void this.doResume(item, text);
	}

	private async doResume(item: OverlayItem, message: string): Promise<void> {
		try {
			const running = await resumeSubagentSession(
				{ sessionFile: item.sessionFile!, task: message, name: item.name, agent: item.agent },
				this.runtime,
			);
			if (running.completionPromise) {
				this.runtime.wireSubagentSteerBack(this.runtime.pi, running, running.completionPromise);
			}
			completedSubagentResults.delete(item.id);
			this.ctx.ui.notify(`Resumed ${item.name}.`, "info");
			this.refreshItems();
		} catch (err) {
			this.ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			this.requestRender();
		}
	}

	private requestRender(): void {
		this.tui.requestRender();
	}
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			description: (text) => theme.fg("muted", text),
			noMatch: (text) => theme.fg("warning", text),
			scrollInfo: (text) => theme.fg("dim", text),
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
		},
	};
}
