import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type {
  AgentRun,
  GroupPlanNode,
  GroupTask,
  TraceSpan,
} from "../types.js";
import { MAX_TASK_BUFFER_CHARS, TaskBufferBuilder } from "./task-buffer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function freshStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-buffer-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

function task(): GroupTask {
  return {
    id: "task-1",
    groupId: "group-1",
    prompt: "Build the upload feature.",
    sharedCodePath: "/ws/shared-code/task-1",
    status: "completed",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:10:00.000Z",
  };
}

function node(overrides: Partial<GroupPlanNode> & { id: string }): GroupPlanNode {
  return {
    groupTaskId: "task-1",
    agentId: "agent-" + overrides.id,
    kind: "work",
    nodeRole: "backend",
    dependsOn: [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "completed",
    runId: "run-" + overrides.id,
    output: "output of " + overrides.id,
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    expectedOutput: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

function run(id: string): AgentRun {
  return {
    id,
    agentId: "agent-x",
    status: "completed",
    prompt: "p",
    output: "run output " + id,
    error: null,
    usage: null,
    traceSummary: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function agentMessageSpan(
  id: string,
  runId: string,
  text: string,
): TraceSpan {
  return {
    id,
    runId,
    agentId: "agent-x",
    seq: 1,
    type: "agent_message",
    parentId: null,
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    payload: { kind: "agent_message", text },
    itemId: null,
  };
}

describe("TaskBufferBuilder", () => {
  it("builds a sequential buffer in chain order regardless of insertion order", async () => {
    const store = await freshStore();
    await store.mutate((db) => {
      db.groupTasks.push(task());
      // Inserted out of chain order on purpose.
      db.groupPlanNodes.push(
        node({ id: "c", dependsOn: ["b"] }),
        node({ id: "a", dependsOn: [] }),
        node({ id: "b", dependsOn: ["a"] }),
      );
    });

    const buffer = new TaskBufferBuilder(store).build({
      groupTaskId: "task-1",
      sinkNodeIds: ["c"],
    });
    expect(buffer.orderedNodeIds).toEqual(["a", "b", "c"]);
  });

  it("builds a DAG buffer in topological order with sibling tie-break", async () => {
    const store = await freshStore();
    await store.mutate((db) => {
      db.groupTasks.push(task());
      db.groupPlanNodes.push(
        node({ id: "a", dependsOn: [] }),
        node({
          id: "c",
          dependsOn: ["a"],
          completedAt: "2026-01-01T00:07:00.000Z",
        }),
        node({
          id: "b",
          dependsOn: ["a"],
          completedAt: "2026-01-01T00:06:00.000Z",
        }),
        node({ id: "d", kind: "join", dependsOn: ["b", "c"] }),
      );
    });

    const buffer = new TaskBufferBuilder(store).build({
      groupTaskId: "task-1",
      sinkNodeIds: ["d"],
    });
    // b completed before c, so it comes first; join d is last.
    expect(buffer.orderedNodeIds).toEqual(["a", "b", "c", "d"]);
  });

  it("includes context injection IDs for audit", async () => {
    const store = await freshStore();
    await store.mutate((db) => {
      db.groupTasks.push(task());
      db.groupPlanNodes.push(node({ id: "a" }));
      db.runs.push(run("run-a"));
      db.contextInjections.push({
        id: "inj-1",
        groupTaskId: "task-1",
        planNodeId: "a",
        agentId: "agent-a",
        fromSeqExclusive: 0,
        toSeqInclusive: 5,
        injectedMessageIds: ["m-1", "m-2"],
        injectedDependencyNodeIds: ["dep-1"],
        withheldMessageIds: ["m-9"],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    const buffer = new TaskBufferBuilder(store).build({
      groupTaskId: "task-1",
      sinkNodeIds: ["a"],
    });
    expect(buffer.entries[0]?.injectedMessageIds).toEqual(["m-1", "m-2"]);
    expect(buffer.entries[0]?.injectedDependencyNodeIds).toEqual(["dep-1"]);
  });

  it("handles a node with no run without throwing", async () => {
    const store = await freshStore();
    await store.mutate((db) => {
      db.groupTasks.push(task());
      db.groupPlanNodes.push(
        node({ id: "a", status: "failed", runId: null, output: null }),
      );
    });

    const buffer = new TaskBufferBuilder(store).build({
      groupTaskId: "task-1",
      sinkNodeIds: ["a"],
    });
    expect(buffer.entries).toHaveLength(1);
    expect(buffer.entries[0]?.spans).toEqual([]);
    expect(buffer.entries[0]?.output).toBe("");
  });

  it("caps huge span payloads before returning the buffer", async () => {
    const store = await freshStore();
    const huge = "x".repeat(20_000);
    await store.mutate((db) => {
      db.groupTasks.push(task());
      db.groupPlanNodes.push(node({ id: "a" }));
      db.runs.push(run("run-a"));
      db.spans.push(agentMessageSpan("span-1", "run-a", huge));
    });

    const buffer = new TaskBufferBuilder(store).build({
      groupTaskId: "task-1",
      sinkNodeIds: ["a"],
    });
    const span = buffer.entries[0]?.spans[0];
    expect(span?.payload.kind).toBe("agent_message");
    if (span?.payload.kind === "agent_message") {
      expect(span.payload.text.length).toBeLessThan(20_000);
    }
    expect(JSON.stringify(buffer.entries).length).toBeLessThanOrEqual(
      MAX_TASK_BUFFER_CHARS,
    );
  });
});
