import { describe, expect, it } from "vitest";
import type { GroupPlanNode, GroupTaskStatus } from "../types";
import { NODE_H, GAP_Y, layoutPlan, planProgress } from "./plan-graph";

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
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  } as GroupPlanNode;
}

/** a -> (b, c) -> d : one fan-out and one rejoin. */
const diamond = [
  node("a"),
  node("b", ["a"]),
  node("c", ["a"]),
  node("d", ["b", "c"]),
];

describe("layoutPlan", () => {
  it("puts a fan-out on one row and the rejoin below both branches", () => {
    const { boxes } = layoutPlan(diamond);
    const level = (id: string) => boxes.find((b) => b.node.id === id)?.level;
    expect(level("a")).toBe(0);
    expect(level("b")).toBe(1);
    expect(level("c")).toBe(1);
    // The join must clear BOTH branches, not just its first parent.
    expect(level("d")).toBe(2);
  });

  it("places parallel siblings side by side, not stacked", () => {
    const { boxes } = layoutPlan(diamond);
    const b = boxes.find((box) => box.node.id === "b");
    const c = boxes.find((box) => box.node.id === "c");
    expect(b?.y).toBe(c?.y);
    expect(b?.x).not.toBe(c?.x);
  });

  it("gives a join the longest path depth, not the shortest", () => {
    // a -> b -> c, and a -> c directly. c must sit below b.
    const { boxes } = layoutPlan([
      node("a"),
      node("b", ["a"]),
      node("c", ["a", "b"]),
    ]);
    expect(boxes.find((box) => box.node.id === "c")?.level).toBe(2);
  });

  it("sizes the canvas from the widest row and the depth", () => {
    const layout = layoutPlan(diamond);
    expect(layout.height).toBe(3 * NODE_H + 2 * GAP_Y);
    expect(layout.width).toBeGreaterThan(0);
  });

  it("emits one edge per real dependency and drops dangling ones", () => {
    const layout = layoutPlan([node("a"), node("b", ["a", "ghost"])]);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("highlights only the edges feeding a running step", () => {
    const layout = layoutPlan([
      node("a", [], "completed"),
      node("b", ["a"], "running"),
      node("c", ["b"]),
    ]);
    const active = layout.edges.filter((edge) => edge.active).map((e) => e.id);
    expect(active).toEqual(["a->b"]);
  });

  it("does not highlight an edge into a join still blocked on a sibling", () => {
    // backend is done, but review waits on frontend too -- nothing is moving
    // along backend -> review, so it must not read as the live path.
    const layout = layoutPlan([
      node("be", [], "completed"),
      node("fe", [], "running"),
      node("review", ["be", "fe"], "queued"),
    ]);
    expect(layout.edges.filter((edge) => edge.active)).toEqual([]);
  });

  it("renders a cyclic plan instead of hanging", () => {
    // Malformed, but the panel must still draw something.
    const layout = layoutPlan([node("a", ["b"]), node("b", ["a"])]);
    expect(layout.boxes).toHaveLength(2);
  });

  it("returns an empty layout for no nodes", () => {
    expect(layoutPlan([])).toEqual({ boxes: [], edges: [], width: 0, height: 0 });
  });
});

describe("planProgress", () => {
  it("counts only completed steps as done", () => {
    const progress = planProgress([
      node("a", [], "completed"),
      node("b", ["a"], "running"),
      node("c", ["b"], "queued"),
      node("d", ["c"], "failed"),
    ]);
    expect(progress.done).toBe(1);
    expect(progress.total).toBe(4);
    expect(progress.percent).toBe(25);
    expect(progress.running.map((n) => n.id)).toEqual(["b"]);
    expect(progress.failed.map((n) => n.id)).toEqual(["d"]);
  });

  it("reports a step ready only once every dependency is done", () => {
    // d waits on both branches; only b has finished.
    const progress = planProgress([
      node("a", [], "completed"),
      node("b", ["a"], "completed"),
      node("c", ["a"], "running"),
      node("d", ["b", "c"], "queued"),
    ]);
    expect(progress.ready.map((n) => n.id)).toEqual([]);
  });

  it("reports both branches ready after a fan-out completes", () => {
    const progress = planProgress([
      node("a", [], "completed"),
      node("b", ["a"], "queued"),
      node("c", ["a"], "queued"),
    ]);
    expect(progress.ready.map((n) => n.id)).toEqual(["b", "c"]);
  });

  it("handles an empty plan without dividing by zero", () => {
    expect(planProgress([])).toMatchObject({ done: 0, total: 0, percent: 0 });
  });
});
