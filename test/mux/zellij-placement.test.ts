import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zellijPlacementGroupId } from "../../src/mux/zellij-anchor-state.ts";
import {
	canSplitZellijPaneInDirection,
	resolveZellijPlacementPolicy,
	selectLiveOwnedZellijAnchor,
	selectZellijFirstPlacement,
	type ZellijPaneSnapshot,
} from "../../src/mux/zellij-placement.ts";

describe("zellij placement", () => {
	const pane = (overrides: Partial<ZellijPaneSnapshot>): ZellijPaneSnapshot => ({
		id: 1,
		is_plugin: false,
		is_floating: false,
		is_selectable: true,
		exited: false,
		pane_rows: 30,
		pane_columns: 120,
		tab_id: 1,
		...overrides,
	});

	it("scopes owned anchor ids to one parent runtime", () => {
		assert.notEqual(
			zellijPlacementGroupId("parent", 7, "right-stack", "runtime-a"),
			zellijPlacementGroupId("parent", 7, "right-stack", "runtime-b"),
		);
	});

	it("scopes owned anchor ids by effective placement policy", () => {
		assert.notEqual(
			zellijPlacementGroupId("parent", 7, "right-stack", "runtime-a"),
			zellijPlacementGroupId("parent", 7, "down-stack", "runtime-a"),
		);
	});

	it("resolves supported operator policies and rejects invalid values", () => {
		assert.equal(resolveZellijPlacementPolicy(undefined), "auto");
		assert.equal(resolveZellijPlacementPolicy("right-stack"), "right-stack");
		assert.equal(resolveZellijPlacementPolicy("down-stack"), "down-stack");
		assert.equal(resolveZellijPlacementPolicy("floating"), "floating");
		assert.equal(resolveZellijPlacementPolicy("tab-stack"), "tab-stack");
		assert.throws(
			() => resolveZellijPlacementPolicy("largest-pane"),
			/PI_SUBAGENT_ZELLIJ_PLACEMENT.*largest-pane/,
		);
	});

	it("checks explicit split directions against Pi's usable minimum", () => {
		assert.equal(
			canSplitZellijPaneInDirection(
				pane({ pane_rows: 20, pane_columns: 100 }),
				"right",
				50,
				10,
			),
			true,
		);
		assert.equal(
			canSplitZellijPaneInDirection(
				pane({ pane_rows: 20, pane_columns: 99 }),
				"right",
				50,
				10,
			),
			false,
		);
		assert.equal(
			canSplitZellijPaneInDirection(
				pane({ pane_rows: 20, pane_columns: 50 }),
				"down",
				50,
				10,
			),
			true,
		);
		assert.equal(
			canSplitZellijPaneInDirection(
				pane({ pane_rows: 19, pane_columns: 50 }),
				"down",
				50,
				10,
			),
			false,
		);
	});

	it("places the first right-stack child beside the parent, never a foreign pane", () => {
		const panes = [
			pane({ id: 10, pane_rows: 40, pane_columns: 120 }),
			pane({ id: 11, pane_rows: 100, pane_columns: 300 }),
		];

		assert.deepEqual(selectZellijFirstPlacement(panes, 10, "right-stack"), {
			mode: "split",
			parentPaneId: 10,
			tabId: 1,
			direction: "right",
		});
	});

	it("supports down-stack and automatic parent-only direction selection", () => {
		const tallParent = pane({ id: 10, pane_rows: 60, pane_columns: 100 });
		assert.deepEqual(
			selectZellijFirstPlacement([tallParent], 10, "down-stack"),
			{
				mode: "split",
				parentPaneId: 10,
				tabId: 1,
				direction: "down",
			},
		);
		assert.deepEqual(selectZellijFirstPlacement([tallParent], 10, "auto"), {
			mode: "split",
			parentPaneId: 10,
			tabId: 1,
			direction: "down",
		});
	});

	it("falls back to a dedicated tab when the requested split is too small", () => {
		const smallParent = pane({ id: 10, pane_rows: 18, pane_columns: 90 });
		assert.deepEqual(
			selectZellijFirstPlacement([smallParent], 10, "right-stack"),
			{ mode: "tab" },
		);
		assert.deepEqual(
			selectZellijFirstPlacement([smallParent], 10, "down-stack"),
			{ mode: "tab" },
		);
		assert.deepEqual(selectZellijFirstPlacement([smallParent], 10, "auto"), {
			mode: "tab",
		});
	});

	it("plans floating and tab-stack without inspecting unrelated panes", () => {
		const parent = pane({ id: 10 });
		assert.deepEqual(selectZellijFirstPlacement([parent], 10, "floating"), {
			mode: "floating",
			parentPaneId: 10,
			tabId: 1,
		});
		assert.deepEqual(selectZellijFirstPlacement([], 10, "tab-stack"), {
			mode: "tab",
		});
	});

	it("reuses only live panes recorded as owned by the parent group", () => {
		const panes = [
			pane({ id: 10, pane_columns: 60 }),
			pane({ id: 20, pane_columns: 300 }),
			pane({ id: 31, pane_columns: 60 }),
			pane({ id: 32, pane_columns: 60, exited: true }),
		];

		assert.deepEqual(selectLiveOwnedZellijAnchor(panes, [32, 31]), panes[2]);
		assert.equal(selectLiveOwnedZellijAnchor(panes, [32, 99]), null);
	});

	it("does not reuse floating, plugin, or unselectable panes as stack anchors", () => {
		const panes = [
			pane({ id: 31, is_floating: true }),
			pane({ id: 32, is_plugin: true }),
			pane({ id: 33, is_selectable: false }),
		];
		assert.equal(selectLiveOwnedZellijAnchor(panes, [31, 32, 33]), null);
	});
});
