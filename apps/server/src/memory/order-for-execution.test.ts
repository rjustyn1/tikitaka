import { describe, expect, it } from "vitest";
import type { GroupPlanNode, GroupTaskStatus } from "../types.js";
import { orderForExecution } from "./group-runner.js";

/**
 * `chainFor()` used to sort by `createdAt` alone — but every node of a task is
 * stamped with the SAME timestamp, so the run order survived only on V8's sort
 * stability. These pin the replacement.
 */
function node(
  id: string,
  dependsOn: string[] = [],
  status: GroupTaskStatus = "queued",
): GroupPlanNode {
  return {
    id,
    groupTaskId: "task-1",
    agentId: "agent-" + id,
    kind: "work",
    nodeRole: id,
    dependsOn,
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status,
    runId: null,
    output: null,
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    instruction: "",
    expectedOutput: "",
    // Identical for every node — exactly the condition that made the old
    // createdAt sort a no-op.
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

const ids = (nodes: GroupPlanNode[]) => nodes.map((item) => item.id);

describe("orderForExecution", () => {
  it("keeps an already-topological plan in exactly its planner order", () => {
    const nodes = [node("a"), node("b", ["a"]), node("c", ["b"])];
    expect(ids(orderForExecution(nodes))).toEqual(["a", "b", "c"]);
  });

  it("repairs an order that would run a node before its dependency", () => {
    const nodes = [node("c", ["b"]), node("b", ["a"]), node("a")];
    expect(ids(orderForExecution(nodes))).toEqual(["a", "b", "c"]);
  });

  it("preserves planner order between two equally-ready nodes", () => {
    // Both depend only on "a". Their relative order is the planner's decision
    // and must not be re-decided by id or timestamp — which is why this does
    // not reuse task-buffer's topologicalSort (it tie-breaks on id).
    const nodes = [node("a"), node("zzz", ["a"]), node("aaa", ["a"])];
    expect(ids(orderForExecution(nodes))).toEqual(["a", "zzz", "aaa"]);
  });

  it("emits every node of a fan-out/fan-in graph after its dependencies", () => {
    const nodes = [
      node("root"),
      node("left", ["root"]),
      node("right", ["root"]),
      node("join", ["left", "right"]),
    ];
    const ordered = orderForExecution(nodes);
    const seen = new Set<string>();
    for (const item of ordered) {
      for (const dependency of item.dependsOn) {
        expect(seen.has(dependency)).toBe(true);
      }
      seen.add(item.id);
    }
    expect(ordered).toHaveLength(4);
  });

  it("ignores a dependency outside the set rather than stalling", () => {
    const nodes = [node("a", ["not-in-this-task"]), node("b", ["a"])];
    expect(ids(orderForExecution(nodes))).toEqual(["a", "b"]);
  });

  it("never drops a node, even on a cycle", () => {
    // The planner rejects cycles; this guards stored data that predates it.
    const nodes = [node("a", ["b"]), node("b", ["a"]), node("c")];
    const ordered = orderForExecution(nodes);
    expect(ordered).toHaveLength(3);
    expect(new Set(ids(ordered))).toEqual(new Set(["a", "b", "c"]));
    // The acyclic node still gets placed properly first.
    expect(ids(ordered)[0]).toBe("c");
  });

  it("handles an empty task", () => {
    expect(orderForExecution([])).toEqual([]);
  });
});
