import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type {
  AgentRun,
  GroupMessage,
  GroupPlanNode,
  GroupTask,
  TopicSegment,
} from "../types.js";
import {
  MAX_SEGMENT_BUFFER_CHARS,
  SegmentBufferBuilder,
  TRANSCRIPT_BUDGET_SHARE,
} from "./task-buffer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function freshStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-segbuf-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

function segment(overrides: Partial<TopicSegment> = {}): TopicSegment {
  return {
    id: "seg-1",
    groupId: "group-1",
    status: "closed",
    startSeq: 1,
    endSeq: 10,
    groupTaskIds: ["task-1", "task-2"],
    closeReason: "topic_shift",
    driftScore: 0.95,
    flushedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T01:00:00.000Z",
    ...overrides,
  };
}

function task(id: string, prompt: string, createdAt: string): GroupTask {
  return {
    id,
    groupId: "group-1",
    prompt,
    sharedCodePath: `/ws/shared-code/${id}`,
    status: "completed",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

function node(
  id: string,
  groupTaskId: string,
  overrides: Partial<GroupPlanNode> = {},
): GroupPlanNode {
  return {
    id,
    groupTaskId,
    agentId: "agent-" + id,
    kind: "work",
    nodeRole: "backend",
    dependsOn: [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "completed",
    runId: "run-" + id,
    output: "output of " + id,
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    instruction: "",
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
    agentId: "agent-" + id,
    status: "completed",
    prompt: "p",
    output: "o",
    error: null,
    usage: null,
    traceSummary: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function message(
  seq: number,
  content: string,
  speakerType: "human" | "agent" = "agent",
): GroupMessage {
  return {
    id: `msg-${seq}`,
    groupId: "group-1",
    seq,
    speakerType,
    speakerAgentId: speakerType === "agent" ? "agent-a" : null,
    groupTaskId: "task-1",
    planNodeId: null,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Store seeded with a two-task segment and a five-message transcript. */
async function seededStore(): Promise<JsonStore> {
  const store = await freshStore();
  await store.mutate((db) => {
    db.topicSegments.push(segment());
    db.groupTasks.push(
      task("task-1", "Build the upload feature.", "2026-01-01T00:00:00.000Z"),
      task("task-2", "Add resumable uploads.", "2026-01-01T00:30:00.000Z"),
    );
    db.groupPlanNodes.push(
      node("n1", "task-1"),
      node("n2", "task-1", { dependsOn: ["n1"] }),
      node("n3", "task-2"),
    );
    db.runs.push(run("n1"), run("n2"), run("n3"));
    db.groupMessages.push(
      message(1, "first human prompt", "human"),
      message(2, "backend reply"),
      message(3, "frontend reply"),
      message(4, "second human prompt", "human"),
      message(5, "security reply"),
    );
  });
  return store;
}

describe("SegmentBufferBuilder", () => {
  it("unions node entries across every task in the segment", async () => {
    const store = await seededStore();
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(buffer.entries.map((entry) => entry.planNodeId)).toEqual(["n1", "n2", "n3"]);
  });

  it("collects the segment's task prompts in task order", async () => {
    const store = await seededStore();
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(buffer.prompts).toEqual([
      "Build the upload feature.",
      "Add resumable uploads.",
    ]);
  });

  it("carries the whole group chat transcript in seq order", async () => {
    const store = await seededStore();
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(buffer.transcript.map((line) => line.content)).toEqual([
      "first human prompt",
      "backend reply",
      "frontend reply",
      "second human prompt",
      "security reply",
    ]);
  });

  it("labels each transcript line with its speaker", async () => {
    const store = await seededStore();
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(buffer.transcript[0]?.speakerType).toBe("human");
    expect(buffer.transcript[1]?.speakerType).toBe("agent");
    expect(buffer.transcript[1]?.agentId).toBe("agent-a");
  });

  it("excludes messages outside the segment's seq range", async () => {
    const store = await freshStore();
    await store.mutate((db) => {
      db.topicSegments.push(segment({ startSeq: 2, endSeq: 3, groupTaskIds: ["task-1"] }));
      db.groupTasks.push(task("task-1", "Build it.", "2026-01-01T00:00:00.000Z"));
      db.groupPlanNodes.push(node("n1", "task-1"));
      db.runs.push(run("n1"));
      db.groupMessages.push(
        message(1, "before the segment"),
        message(2, "inside a"),
        message(3, "inside b"),
        message(4, "after the segment"),
      );
    });
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(buffer.transcript.map((line) => line.content)).toEqual(["inside a", "inside b"]);
  });

  it("runs an open segment's transcript to the end of the timeline", async () => {
    const store = await freshStore();
    await store.mutate((db) => {
      db.topicSegments.push(
        segment({ status: "open", startSeq: 1, endSeq: null, groupTaskIds: ["task-1"] }),
      );
      db.groupTasks.push(task("task-1", "Build it.", "2026-01-01T00:00:00.000Z"));
      db.groupPlanNodes.push(node("n1", "task-1"));
      db.runs.push(run("n1"));
      db.groupMessages.push(message(1, "a"), message(2, "b"));
    });
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(buffer.transcript).toHaveLength(2);
  });

  it("drops the OLDEST transcript lines when the transcript exceeds its budget", async () => {
    const store = await freshStore();
    const budget = Math.floor(MAX_SEGMENT_BUFFER_CHARS * TRANSCRIPT_BUDGET_SHARE);
    const big = "x".repeat(Math.floor(budget / 2));
    await store.mutate((db) => {
      db.topicSegments.push(segment({ groupTaskIds: ["task-1"], endSeq: null }));
      db.groupTasks.push(task("task-1", "Build it.", "2026-01-01T00:00:00.000Z"));
      db.groupPlanNodes.push(node("n1", "task-1"));
      db.runs.push(run("n1"));
      db.groupMessages.push(
        message(1, "OLDEST" + big),
        message(2, "MIDDLE" + big),
        message(3, "NEWEST" + big),
      );
    });
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    const kept = buffer.transcript.map((line) => line.content.slice(0, 6));
    expect(kept).not.toContain("OLDEST");
    expect(kept).toContain("NEWEST");
  });

  it("keeps the whole buffer within the overall cap", async () => {
    const store = await freshStore();
    const big = "y".repeat(60_000);
    await store.mutate((db) => {
      db.topicSegments.push(segment({ groupTaskIds: ["task-1", "task-2"], endSeq: null }));
      db.groupTasks.push(
        task("task-1", "Build it.", "2026-01-01T00:00:00.000Z"),
        task("task-2", "Extend it.", "2026-01-01T00:30:00.000Z"),
      );
      db.groupPlanNodes.push(
        node("n1", "task-1", { output: big }),
        node("n2", "task-2", { output: big }),
      );
      db.runs.push(run("n1"), run("n2"));
      db.groupMessages.push(message(1, big), message(2, big), message(3, big));
    });
    const buffer = new SegmentBufferBuilder(store).build({ segmentId: "seg-1" });
    expect(JSON.stringify(buffer).length).toBeLessThanOrEqual(MAX_SEGMENT_BUFFER_CHARS);
  });

  it("throws for a segment that does not exist", async () => {
    const store = await seededStore();
    expect(() => new SegmentBufferBuilder(store).build({ segmentId: "nope" })).toThrow();
  });
});
