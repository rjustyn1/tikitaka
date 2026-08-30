import { describe, expect, it } from "vitest";
import type { GroupPlanNode, GroupTaskStatus } from "../types.js";
import {
  isRetryableFailure,
  locksConflict,
  orderForExecution,
} from "./group-runner.js";

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
    attempts: 0,
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

describe("isRetryableFailure", () => {
  it("retries failures that are about the environment, not the answer", () => {
    for (const message of [
      "Codex timed out after 600000 ms",
      "Runtime timed out after 600000 ms",
      "Agent already has an active Codex process",
      "Codex exited with code 1: connection reset",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      expect(isRetryableFailure(message)).toBe(true);
    }
  });

  it("does not retry a failure a second run cannot fix", () => {
    for (const message of [
      // The model answered, just emptily. The same run gives the same answer.
      "Codex completed without an agent message",
      // Deterministic: the output will be just as large next time.
      "Codex output exceeded CODEX_MAX_OUTPUT_BYTES",
      // A deployment fault; the binary will still be missing.
      "spawn codex ENOENT",
      "This Agent is no longer a group member",
    ]) {
      expect(isRetryableFailure(message)).toBe(false);
    }
  });

  it("treats a clean exit code 0 message as not retryable", () => {
    expect(isRetryableFailure("Codex exited with code 0: fine")).toBe(false);
  });
});

describe("locksConflict — the runtime-lock collision rule", () => {
  it("lets disjoint areas of the shared tree run together", () => {
    expect(
      locksConflict(["code/apps/server/**"], ["code/apps/web/**"]),
    ).toBe(false);
  });

  it("blocks two nodes claiming the same area", () => {
    expect(
      locksConflict(["code/apps/server/**"], ["code/apps/server/**"]),
    ).toBe(true);
  });

  it("blocks a broad claim that CONTAINS a narrow one", () => {
    // String equality would miss this, and it is the dangerous case: `code/**`
    // and `code/apps/server/**` overlap on disk.
    expect(locksConflict(["code/**"], ["code/apps/server/**"])).toBe(true);
    expect(locksConflict(["code/apps/server/**"], ["code/**"])).toBe(true);
  });

  it("never blocks a read-only node, which declares no locks", () => {
    expect(locksConflict([], ["code/**"])).toBe(false);
    expect(locksConflict(["code/**"], [])).toBe(false);
  });

  it("treats a bare wildcard as covering everything", () => {
    expect(locksConflict(["**"], ["code/apps/web/**"])).toBe(true);
  });

  it("does not confuse sibling directories with a shared prefix", () => {
    // "code/apps/webhooks" must not look like it is inside "code/apps/web".
    expect(
      locksConflict(["code/apps/web/**"], ["code/apps/webhooks/**"]),
    ).toBe(false);
  });
});
