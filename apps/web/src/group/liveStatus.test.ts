/**
 * The member rail claims an Agent is running. That claim must come from a
 * persisted node status and nothing else, so the derivation is tested on its own
 * rather than through a rendered component.
 */
import { describe, expect, it } from "vitest";
import type { GroupPlanNode } from "../types";
import { liveStatusFor } from "./liveStatus";

function node(
  over: Partial<GroupPlanNode> & { id: string; agentId: string },
): GroupPlanNode {
  return {
    groupTaskId: "t1",
    kind: "work",
    nodeRole: "backend-contract",
    dependsOn: [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "queued",
    runId: null,
    output: null,
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    expectedOutput: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

describe("liveStatusFor", () => {
  it("reports idle when the Agent owns no node in this task", () => {
    const status = liveStatusFor("a9", [node({ id: "n1", agentId: "a1" })], "running");
    expect(status.state).toBe("idle");
    expect(status.label).toBe("No step in this task");
  });

  it("reports the running node, and names it", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({
          id: "n1",
          agentId: "a1",
          status: "running",
          nodeRole: "security-review",
        }),
      ],
      "running",
    );
    expect(status.state).toBe("running");
    expect(status.nodeRole).toBe("security-review");
    expect(status.label).toBe("Running security-review");
  });

  it("prefers a running node over a queued one", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({ id: "n1", agentId: "a1", status: "completed" }),
        node({
          id: "n2",
          agentId: "a1",
          status: "running",
          nodeRole: "backend-impl",
        }),
        node({ id: "n3", agentId: "a1", status: "queued" }),
      ],
      "running",
    );
    expect(status.state).toBe("running");
    expect(status.nodeRole).toBe("backend-impl");
  });

  it("reports waiting while the task is live and the node has not started", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({
          id: "n1",
          agentId: "a1",
          status: "queued",
          nodeRole: "frontend-plan",
        }),
      ],
      "running",
    );
    expect(status.state).toBe("waiting");
    expect(status.label).toBe("Waiting for frontend-plan");
  });

  it("reports a failure over a completed sibling", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({ id: "n1", agentId: "a1", status: "completed" }),
        node({
          id: "n2",
          agentId: "a1",
          status: "failed",
          nodeRole: "backend-impl",
        }),
      ],
      "partial",
    );
    expect(status.state).toBe("failed");
    expect(status.label).toBe("Failed on backend-impl");
  });

  it("counts finished steps when everything completed", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({ id: "n1", agentId: "a1", status: "completed" }),
        node({ id: "n2", agentId: "a1", status: "completed" }),
      ],
      "completed",
    );
    expect(status.state).toBe("done");
    expect(status.completed).toBe(2);
    expect(status.total).toBe(2);
    expect(status.label).toBe("Finished 2 steps");
  });

  it("says stopped, not waiting, once a cancelled task leaves a node unstarted", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({
          id: "n1",
          agentId: "a1",
          status: "queued",
          nodeRole: "frontend-impl",
        }),
      ],
      "cancelled",
    );
    expect(status.state).toBe("stopped");
    expect(status.label).toBe("Stopped before frontend-impl");
  });
});
