import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SubagentSyncManager } from "../../src/subagents/sync.ts";
import type { CompletedSubagentResult, RunningSubagent } from "../../src/subagents/runtime-types.ts";

function createCompleted(id = "child-1"): CompletedSubagentResult {
  return {
    id,
    name: "Child",
    task: "Work",
    summary: "done",
    mode: "background",
    status: "completed",
    deliveryState: "detached",
    parentClosePolicy: "terminate",
    blocking: false,
    deliveredTo: null,
    exitCode: 0,
    elapsed: 1,
    sessionFile: `/tmp/${id}.jsonl`,
  };
}

describe("sync manager direct module tests", () => {
  it("returns cached completed results and can await them directly", async () => {
    const completed = new Map<string, CompletedSubagentResult>();
    const running = new Map<string, RunningSubagent>();
    const cached = createCompleted();
    completed.set(cached.id, cached);

    const sync = new SubagentSyncManager({
      runningSubagents: running,
      completedSubagentResults: completed,
      cacheCompletedSubagentResult: (_running, result) => ({ ...createCompleted("cached"), ...result, id: "cached" }),
      updateWidget: () => {},
      deliverCompletedSubagentResultViaSteer: () => cached,
    });

    assert.equal(sync.getCompletedResult(cached.id), cached);

    const result = await sync.waitForResult({ id: cached.id });
    assert.equal(result.details.id, cached.id);
    assert.equal(result.details.deliveryState, "awaited");
    assert.equal(cached.deliveredTo, "wait");
  });

  it("detaches owned cached results back to detached delivery", () => {
    const completed = new Map<string, CompletedSubagentResult>();
    const running = new Map<string, RunningSubagent>();
    const cached = createCompleted("child-2");
    cached.deliveryState = "joined";
    completed.set(cached.id, cached);

    let delivered = false;
    const sync = new SubagentSyncManager({
      runningSubagents: running,
      completedSubagentResults: completed,
      cacheCompletedSubagentResult: (_running, result) => ({ ...createCompleted("cached"), ...result, id: "cached" }),
      updateWidget: () => {},
      deliverCompletedSubagentResultViaSteer: () => {
        delivered = true;
        return cached;
      },
    });

    const result = sync.detachResult({ id: cached.id }, { sendMessage() {} } as any);
    assert.equal(result.details.status, "detached");
    assert.equal(cached.deliveryState, "detached");
    assert.equal(delivered, true);
  });
});
