import type {
	ContextPruneEventData,
	ForkReadyEventData,
	SummaryCandidateEventData,
} from "../../src/runtime/fork-session-manager.ts";
import { ForkSessionManager } from "../../src/runtime/fork-session-manager.ts";
import { assert, beforeEach, describe, it } from "../support/index.ts";

const PARENT_SESSION = "/tmp/parent.jsonl";
const CHILD_SESSION = "/tmp/child.jsonl";
const CHILD_CTX_WINDOW = 128_000;
const CANDIDATE_ID = "sc-001";
const CANDIDATE_TEXT =
	"Refactored auth module — split JWT validation into separate middleware, added integration tests for token refresh.";

function makeSummaryCandidate(overrides?: Partial<SummaryCandidateEventData>): SummaryCandidateEventData {
	return {
		event: "summary_candidate",
		id: CANDIDATE_ID,
		text: CANDIDATE_TEXT,
		tokens: 2048,
		...overrides,
	};
}

function makeContextPruneWithFork(
	overrides?: Partial<ContextPruneEventData & { forkEntryId?: string }>,
): ContextPruneEventData {
	return {
		event: "context_prune",
		prunedTokens: 4096,
		fork: {
			childSessionFile: CHILD_SESSION,
			entryId: overrides?.forkEntryId ?? "parent-entry-042",
		},
		...overrides,
	};
}

function makeContextPrunePlain(overrides?: Partial<ContextPruneEventData>): ContextPruneEventData {
	return {
		event: "context_prune",
		prunedTokens: 2048,
		...overrides,
	};
}

function makeForkReady(overrides?: Partial<ForkReadyEventData>): ForkReadyEventData {
	return {
		event: "fork_ready",
		childSessionFile: CHILD_SESSION,
		parentSessionFile: PARENT_SESSION,
		childContextWindow: CHILD_CTX_WINDOW,
		...overrides,
	};
}

describe("ForkSessionManager", () => {
	let manager: ForkSessionManager;

	beforeEach(() => {
		manager = new ForkSessionManager();
	});

	describe("initial state", () => {
		it("has no stashed summary and no in-flight candidate when created", () => {
			assert.equal(manager.summaryCandidateStash, null);
			assert.equal(manager.currentInflightCandidate, null);
		});

		it("reset() clears all state", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPruneWithFork());
			assert.notEqual(manager.summaryCandidateStash, null);

			manager.reset();
			assert.equal(manager.summaryCandidateStash, null);
			assert.equal(manager.currentInflightCandidate, null);
		});
	});

	// ------------------------------------------------------------------
	// Scenario 1: summary_candidate interrupted by context_prune + fork
	// ------------------------------------------------------------------
	describe("Scenario 1 — summary_candidate interrupted by context_prune+fork", () => {
		it("stashes the candidate and sets pending=true when context_prune has a fork entry", () => {
			// Given: a summary candidate is in-flight
			manager.handleSummaryCandidate(makeSummaryCandidate());

			// When: a context_prune event with a fork entry arrives
			const wasInterrupted = manager.handleContextPrune(makeContextPruneWithFork());

			// Then: the candidate was interrupted and stashed
			assert.equal(wasInterrupted, true);

			const stash = manager.summaryCandidateStash;
			assert.notEqual(stash, null);
			if (stash) {
				assert.equal(stash.id, CANDIDATE_ID);
				assert.equal(stash.text, CANDIDATE_TEXT);
				assert.equal(stash.pending, true);
				assert.equal(typeof stash.interruptedAt, "number");
				assert.ok(stash.interruptedAt > 0);
			}
		});

		it("does NOT stash when context_prune has no fork entry", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());

			const wasInterrupted = manager.handleContextPrune(makeContextPrunePlain());

			assert.equal(wasInterrupted, false);
			assert.equal(manager.summaryCandidateStash, null);
			// In-flight candidate remains (no interruption)
			assert.notEqual(manager.currentInflightCandidate, null);
		});

		it("does NOT stash when no summary candidate is in-flight", () => {
			const wasInterrupted = manager.handleContextPrune(makeContextPruneWithFork());

			assert.equal(wasInterrupted, false);
			assert.equal(manager.summaryCandidateStash, null);
		});

		it("replaces a previous in-flight candidate (last-in-wins)", () => {
			const first = makeSummaryCandidate({ id: "sc-old", text: "Old summary" });
			const second = makeSummaryCandidate({
				id: "sc-new",
				text: "New summary",
			});

			manager.handleSummaryCandidate(first);
			manager.handleSummaryCandidate(second);
			manager.handleContextPrune(makeContextPruneWithFork());

			const stash = manager.summaryCandidateStash;
			assert.notEqual(stash, null);
			if (stash) {
				assert.equal(stash.id, "sc-new");
				assert.equal(stash.text, "New summary");
			}
		});

		it("clears in-flight after stashing", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPruneWithFork());

			assert.equal(manager.currentInflightCandidate, null);
		});
	});

	// ------------------------------------------------------------------
	// Scenario 2: fork_ready replays the stashed candidate
	// ------------------------------------------------------------------
	describe("Scenario 2 — fork_ready replays stashed summary candidate in fork payload", () => {
		it("includes stashed summary in fork payload when stash exists", () => {
			// Given: a candidate was stashed via context_prune+fork interruption
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPruneWithFork());

			// When: fork_ready arrives
			const payload = manager.handleForkReady(makeForkReady());

			// Then: the stashed summary is included in the payload
			assert.equal(payload.childSessionFile, CHILD_SESSION);
			assert.equal(payload.parentSessionFile, PARENT_SESSION);
			assert.equal(payload.childContextWindow, CHILD_CTX_WINDOW);
			assert.equal(payload.stashedSummary, CANDIDATE_TEXT);
			assert.equal(payload.stashedSummaryPending, true);
		});

		it("clears the stash after replaying it in the fork payload", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPruneWithFork());
			manager.handleForkReady(makeForkReady());

			// Stash should be consumed
			assert.equal(manager.summaryCandidateStash, null);
		});

		it("includes in-flight candidate (no interruption) in fork payload with pending=false", () => {
			// Given: a summary candidate is in-flight but NO context_prune interrupt
			manager.handleSummaryCandidate(makeSummaryCandidate());

			// When: fork_ready arrives without any interruption
			const payload = manager.handleForkReady(makeForkReady());

			// Then: the candidate is included but NOT marked pending
			assert.equal(payload.stashedSummary, CANDIDATE_TEXT);
			assert.equal(payload.stashedSummaryPending, false);
		});

		it("fork payload has no summary when neither stash nor in-flight exist", () => {
			const payload = manager.handleForkReady(makeForkReady());

			assert.equal(payload.stashedSummary, undefined);
			assert.equal(payload.stashedSummaryPending, undefined);
		});

		it("prefers stashed summary over in-flight when both exist (should not happen in practice)", () => {
			// Edge case: after stashing, a new in-flight candidate arrives
			// before fork_ready. The stash should still take priority.
			manager.handleSummaryCandidate(makeSummaryCandidate({ id: CANDIDATE_ID, text: CANDIDATE_TEXT }));
			manager.handleContextPrune(makeContextPruneWithFork());
			manager.handleSummaryCandidate(makeSummaryCandidate({ id: "sc-new", text: "Newer summary" }));

			const payload = manager.handleForkReady(makeForkReady());

			// Stashed (interrupted) wins over newer in-flight
			assert.equal(payload.stashedSummary, CANDIDATE_TEXT);
			assert.equal(payload.stashedSummaryPending, true);
		});

		it("can replay multiple cycles of stash and fork_ready", () => {
			// Cycle 1
			manager.handleSummaryCandidate(makeSummaryCandidate({ id: "sc-cycle-1", text: "Cycle 1 summary" }));
			manager.handleContextPrune(makeContextPruneWithFork());
			let payload = manager.handleForkReady(makeForkReady());
			assert.equal(payload.stashedSummary, "Cycle 1 summary");

			// Cycle 2 — second fork with a different candidate
			manager.handleSummaryCandidate(makeSummaryCandidate({ id: "sc-cycle-2", text: "Cycle 2 summary" }));
			manager.handleContextPrune(makeContextPruneWithFork());
			payload = manager.handleForkReady(makeForkReady());
			assert.equal(payload.stashedSummary, "Cycle 2 summary");

			assert.equal(manager.summaryCandidateStash, null);
		});
	});

	describe("context_prune without fork does not interrupt fork_ready path", () => {
		it("plain context_prune preserves in-flight candidate for later fork_ready", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPrunePlain());

			// Still in-flight
			assert.equal(manager.summaryCandidateStash, null);
			assert.notEqual(manager.currentInflightCandidate, null);

			const payload = manager.handleForkReady(makeForkReady());
			assert.equal(payload.stashedSummary, CANDIDATE_TEXT);
			assert.equal(payload.stashedSummaryPending, false);
		});

		it("multiple context_prune without fork do not cause false stash", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPrunePlain());
			manager.handleContextPrune(makeContextPrunePlain());

			assert.equal(manager.summaryCandidateStash, null);
		});
	});

	describe("fork payload structure", () => {
		it("preserves all fork metadata fields", () => {
			manager.handleSummaryCandidate(makeSummaryCandidate());
			manager.handleContextPrune(makeContextPruneWithFork());

			const payload = manager.handleForkReady({
				event: "fork_ready",
				childSessionFile: "/custom/child.jsonl",
				parentSessionFile: "/custom/parent.jsonl",
				childContextWindow: 64_000,
			});

			assert.equal(payload.childSessionFile, "/custom/child.jsonl");
			assert.equal(payload.parentSessionFile, "/custom/parent.jsonl");
			assert.equal(payload.childContextWindow, 64_000);
		});
	});
});
