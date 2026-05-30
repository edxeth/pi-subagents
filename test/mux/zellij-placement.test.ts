import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	canSplitZellijPane,
	predictZellijSplitDirection,
	selectZellijPlacement,
	selectZellijStackPlacement,
	type ZellijPaneSnapshot,
} from "../../src/mux/zellij-placement.ts";

describe("zellij placement", () => {
	const pane = (overrides: Partial<ZellijPaneSnapshot>): ZellijPaneSnapshot => ({
		id: 1,
		is_plugin: false,
		is_floating: false,
		is_selectable: true,
		exited: false,
		pane_rows: 20,
		pane_columns: 80,
		tab_id: 1,
		...overrides,
	});

	it("matches Zellij direction and minimum split rules", () => {
		assert.equal(
			predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 11 })),
			"right",
		);
		assert.equal(
			predictZellijSplitDirection(pane({ pane_rows: 11, pane_columns: 5 })),
			"down",
		);
		assert.equal(
			predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 10 })),
			null,
		);
		assert.equal(
			predictZellijSplitDirection(pane({ pane_rows: 4, pane_columns: 80 })),
			null,
		);

		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 11 })),
			true,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 11, pane_columns: 5 })),
			true,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 10 })),
			false,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 4, pane_columns: 80 })),
			false,
		);

		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 100 }), 80, 20),
			false,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 45, pane_columns: 100 }), 80, 20),
			true,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 170 }), 80, 20),
			true,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 47 }), 50, 10),
			false,
		);
		assert.equal(
			canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 77 }), 50, 10),
			true,
		);
	});

	it("uses tab-scoped split only when all Zellij split candidates are safe", () => {
		const plan = selectZellijPlacement(
			[
				pane({ id: 10, tab_id: 1, pane_rows: 40, pane_columns: 120 }),
				pane({ id: 11, tab_id: 1, pane_rows: 120, pane_columns: 100 }),
				pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
			],
			10,
		);

		assert.deepEqual(plan, {
			mode: "split",
			anchorPaneId: 11,
			targetPaneId: 11,
			tabId: 1,
			splitDirection: "down",
		});
	});

	it("stacks when any Zellij split candidate would fall below Pi's configured minimum", () => {
		const plan = selectZellijPlacement(
			[
				pane({ id: 10, tab_id: 1, pane_rows: 100, pane_columns: 47 }),
				pane({ id: 11, tab_id: 1, pane_rows: 31, pane_columns: 77 }),
			],
			10,
			50,
			10,
		);

		assert.deepEqual(plan, {
			mode: "stack",
			anchorPaneId: 11,
			targetPaneId: 11,
			tabId: 1,
		});
	});

	it("stacks when Zellij would split a pane below Pi's usable minimum", () => {
		const plan = selectZellijPlacement(
			[
				pane({ id: 10, tab_id: 1, pane_rows: 20, pane_columns: 20 }),
				pane({ id: 11, tab_id: 1, pane_rows: 18, pane_columns: 60 }),
				pane({ id: 12, tab_id: 1, pane_rows: 10, pane_columns: 70 }),
			],
			10,
		);

		assert.deepEqual(plan, {
			mode: "stack",
			anchorPaneId: 11,
			targetPaneId: 11,
			tabId: 1,
		});
	});

	it("does not split narrow Zellij panes when actual split direction may differ from prediction", () => {
		const plan = selectZellijPlacement(
			[pane({ id: 10, tab_id: 1, pane_rows: 22, pane_columns: 80 })],
			10,
			50,
			10,
		);

		assert.equal(plan, null);
	});

	it("never chooses the parent pane as the stack target", () => {
		const plan = selectZellijStackPlacement(
			[
				pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 }),
				pane({ id: 11, tab_id: 1, pane_rows: 10, pane_columns: 20 }),
				pane({ id: 12, tab_id: 1, pane_rows: 8, pane_columns: 30 }),
			],
			10,
		);

		assert.deepEqual(plan, {
			mode: "stack",
			anchorPaneId: 12,
			targetPaneId: 12,
			tabId: 1,
		});
	});

	it("does not stack when the only usable pane is the parent", () => {
		const plan = selectZellijStackPlacement(
			[pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 })],
			10,
		);

		assert.equal(plan, null);
	});

	it("stacks on the largest usable non-parent pane when none can split", () => {
		const plan = selectZellijPlacement(
			[
				pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
				pane({ id: 11, tab_id: 1, pane_rows: 6, pane_columns: 8 }),
				pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
			],
			10,
		);

		assert.deepEqual(plan, {
			mode: "stack",
			anchorPaneId: 11,
			targetPaneId: 11,
			tabId: 1,
		});
	});

	it("ignores floating, plugin, exited, unselectable, and other-tab panes", () => {
		const plan = selectZellijPlacement(
			[
				pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
				pane({
					id: 11,
					tab_id: 1,
					pane_rows: 60,
					pane_columns: 200,
					is_floating: true,
				}),
				pane({
					id: 12,
					tab_id: 1,
					pane_rows: 60,
					pane_columns: 200,
					is_plugin: true,
				}),
				pane({
					id: 13,
					tab_id: 1,
					pane_rows: 60,
					pane_columns: 200,
					exited: true,
				}),
				pane({
					id: 14,
					tab_id: 1,
					pane_rows: 60,
					pane_columns: 200,
					is_selectable: false,
				}),
				pane({ id: 15, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
			],
			10,
		);

		assert.equal(plan, null);
	});

	it("returns null when the parent pane cannot be found", () => {
		assert.equal(
			selectZellijPlacement([pane({ id: 10 })], 99),
			null,
		);
	});
});
