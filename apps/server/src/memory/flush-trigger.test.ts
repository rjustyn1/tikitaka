import { describe, expect, it } from "vitest";
import { decideFlush } from "./flush-trigger.js";
import type { GroupPlanNode, GroupTask, GroupTaskStatus } from "../types.js";

const TASK_ID = "task-1";

function makeTask(overrides: Partial<GroupTask> = {}): GroupTask {
  return {
    id: TASK_ID,
    groupId: "group-1",
    prompt: "Plan an upload feature.",
    sharedCodePath: "/tmp/shared-code/task-1",
    status: "running",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function makeNode(
  id: string,
  status: GroupTaskStatus,
  dependsOn: string[] = [],
): GroupPlanNode {
  return {
    id,
    groupTaskId: TASK_ID,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

/** The v1 five-node chain, with each node's status supplied in order. */
function chain(...statuses: GroupTaskStatus[]): GroupPlanNode[] {
  return statuses.map((status, index) =>
    makeNode("n" + index, status, index === 0 ? [] : ["n" + (index - 1)]),
  );
}

describe("decideFlush", () => {
  it("flushes when the last node of a sequential chain completes", () => {
    const decision = decideFlush({
      groupTask: makeTask({ status: "completed" }),
      planNodes: chain(
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
      ),
    });
    expect(decision).toEqual({
      shouldFlush: true,
      reason: "completed",
    });
  });

  it("does not flush while a node is still runnable or running", () => {
    expect(
      decideFlush({
        groupTask: makeTask(),
        planNodes: chain("completed", "running", "queued", "queued", "queued"),
      }),
    ).toEqual({ shouldFlush: false, reason: "not_terminal" });
  });

  it("returns partial when a mid-chain node fails and later nodes never ran", () => {
    // The runner breaks out of the loop on failure, so n2..n4 stay queued.
    // They are unreachable, so the task is terminal and partially useful.
    const decision = decideFlush({
      groupTask: makeTask({ status: "partial" }),
      planNodes: chain("completed", "failed", "queued", "queued", "queued"),
    });
    expect(decision).toEqual({
      shouldFlush: true,
      reason: "partial",
    });
  });

  it("returns partial when the sink itself was cancelled but earlier work landed", () => {
    const decision = decideFlush({
      groupTask: makeTask({ status: "partial" }),
      planNodes: chain(
        "completed",
        "completed",
        "completed",
        "completed",
        "cancelled",
      ),
    });
    expect(decision.shouldFlush).toBe(true);
    expect(decision).toMatchObject({ reason: "partial" });
  });

  it("does not flush when nothing completed", () => {
    expect(
      decideFlush({
        groupTask: makeTask({ status: "failed" }),
        planNodes: chain("failed", "queued", "queued", "queued", "queued"),
      }),
    ).toEqual({ shouldFlush: false, reason: "no_completed_runs" });
  });

  it("never flushes a task twice", () => {
    expect(
      decideFlush({
        groupTask: makeTask({
          status: "completed",
          flushedAt: "2026-01-01T00:01:00.000Z",
        }),
        planNodes: chain(
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
        ),
      }),
    ).toEqual({ shouldFlush: false, reason: "not_terminal" });
  });

  it("ignores nodes belonging to another task", () => {
    const foreign = makeNode("other", "running");
    foreign.groupTaskId = "task-2";
    const decision = decideFlush({
      groupTask: makeTask({ status: "completed" }),
      planNodes: [...chain("completed", "completed"), foreign],
    });
    expect(decision).toMatchObject({ shouldFlush: true, reason: "completed" });
  });

  it("treats a task with no nodes as having produced nothing", () => {
    expect(
      decideFlush({
        groupTask: makeTask({ status: "cancelled" }),
        planNodes: [],
      }),
    ).toEqual({ shouldFlush: false, reason: "no_completed_runs" });
    expect(
      decideFlush({ groupTask: makeTask({ status: "queued" }), planNodes: [] }),
    ).toEqual({ shouldFlush: false, reason: "not_terminal" });
  });

  it("flushes a branch-and-join shape once every sink is terminal (STRETCH-ready)", () => {
    // Not built in v1, but decideFlush must already be DAG-correct so the
    // upgrade is a planner change only.
    const nodes = [
      makeNode("root", "completed"),
      makeNode("left", "completed", ["root"]),
      makeNode("right", "running", ["root"]),
    ];
    expect(decideFlush({ groupTask: makeTask(), planNodes: nodes })).toEqual({
      shouldFlush: false,
      reason: "not_terminal",
    });

    nodes[2]!.status = "completed";
    const decision = decideFlush({ groupTask: makeTask(), planNodes: nodes });
    expect(decision).toMatchObject({ shouldFlush: true, reason: "completed" });
  });

  it("fails open on a dependency cycle instead of looping forever", () => {
    // A cycle leaves no sink at all. The trigger must terminate and refuse to
    // flush rather than hang: "memory consolidation must fail open".
    const a = makeNode("a", "queued", ["b"]);
    const b = makeNode("b", "queued", ["a"]);
    expect(decideFlush({ groupTask: makeTask(), planNodes: [a, b] })).toEqual({
      shouldFlush: false,
      reason: "no_completed_runs",
    });
  });
});
