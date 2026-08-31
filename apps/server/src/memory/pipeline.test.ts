import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent, GroupPlanNode, GroupTask, TraceSpan } from "../types.js";
import { FakeExtractorClient, type ExtractorClient } from "./extractor-client.js";
import { LandingService } from "./landing.js";
import {
  createMemoryPipeline,
  NoopMemoryPipeline,
  RealMemoryPipeline,
} from "./pipeline.js";
import type { NoteRecognizer } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "33333333-3333-4333-8333-333333333333";
const SPAN_A = "22222222-2222-4222-8222-222222222222";
const SPAN_B = "44444444-4444-4444-8444-444444444444";

async function seededStore() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-pipeline-test-"));
  temporaryDirectories.push(root);
  const agentA = agentAt(AGENT_A, path.join(root, "a"));
  const agentB = agentAt(AGENT_B, path.join(root, "b"));
  for (const agent of [agentA, agentB]) {
    await mkdir(agent.workspacePath, { recursive: true });
  }

  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((db) => {
    db.agents.push(agentA, agentB);
    db.groups.push({
      id: "group-1",
      name: "Upload Team",
      description: "",
      // Post-backfill shape. store.initialize() migrates legacy memberAgentIds
      // to members, so anything reading a group sees this form.
      members: [
        { agentId: AGENT_A, role: "backend" },
        { agentId: AGENT_B, role: "frontend" },
      ],
      activeTaskId: "task-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    db.groupTasks.push(task());
    db.topicSegments.push({
      id: "seg-1",
      groupId: "group-1",
      status: "closed",
      startSeq: 1,
      endSeq: 9,
      groupTaskIds: ["task-1"],
      closeReason: "topic_shift",
      driftScore: 0.95,
      flushedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      closedAt: "2026-01-01T01:00:00.000Z",
    });
    db.groupPlanNodes.push(
      planNode("n1", AGENT_A, RUN_A),
      planNode("n2", AGENT_B, RUN_B),
    );
    db.spans.push(
      messageSpan(SPAN_A, RUN_A, AGENT_A),
      messageSpan(SPAN_B, RUN_B, AGENT_B),
    );
  });
  return { store, root };
}

function task(): GroupTask {
  return {
    id: "task-1",
    groupId: "group-1",
    prompt: "Build the upload feature.",
    sharedCodePath: "/ws/shared/task-1",
    status: "completed",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
  };
}

function agentAt(id: string, workspacePath: string): Agent {
  return {
    id,
    name: id === AGENT_A ? "Backend" : "Frontend",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function planNode(id: string, agentId: string, runId: string): GroupPlanNode {
  return {
    id,
    groupTaskId: "task-1",
    agentId,
    kind: "work",
    nodeRole: agentId === AGENT_A ? "backend" : "frontend",
    dependsOn: id === "n2" ? ["n1"] : [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "completed",
    runId,
    output: "did the work",
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    instruction: "",
    expectedOutput: "",
    attempts: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: id === "n1" ? "2026-01-01T00:03:00.000Z" : "2026-01-01T00:05:00.000Z",
  };
}

function messageSpan(id: string, runId: string, agentId: string): TraceSpan {
  return {
    id,
    runId,
    agentId,
    seq: 1,
    type: "agent_message",
    parentId: null,
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    payload: { kind: "agent_message", text: "the endpoint caps uploads at 10MB" },
    itemId: null,
  };
}

describe("RealMemoryPipeline", () => {
  it("runs end to end: fake notes are created, a clean note lands, ledger records grants", async () => {
    const { store } = await seededStore();
    const recognizer: NoteRecognizer = {
      async recognizeAgents(_noteText, members) {
        return {
          threshold: 0.5,
          matches: [
            { agentId: members[0]!.id, score: 0.9, matchKind: "threshold" },
          ],
        };
      },
    };
    const pipeline = new RealMemoryPipeline(store, new FakeExtractorClient(), {
      recognizer,
    });

    await pipeline.runMemoryPipeline("seg-1");

    const db = store.snapshot();
    // Fake emits one severe (parked pending) + one normal (auto-active).
    expect(db.notes.length).toBeGreaterThanOrEqual(2);
    expect(db.notes.some((n) => n.status === "active")).toBe(true);
    expect(db.notes.some((n) => n.status === "pending")).toBe(true);

    // At least one file landed. (flushedAt is stamped by the GroupRunner, not
    // the pipeline, so it is asserted in group-runner.test.ts.)
    const active = db.landedMemoryFiles.filter((f) => f.removedAt === null);
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(await exists(active[0]!.path)).toBe(true);
    expect(db.grants.some((g) => g.decision === "granted")).toBe(true);
    expect(db.grants.some((g) => g.decision === "withheld")).toBe(true);
  });

  it("never throws or fails the task when the extractor blows up", async () => {
    const { store } = await seededStore();
    const throwing: ExtractorClient = {
      async extract() {
        throw new Error("boom");
      },
    };
    const errors: string[] = [];
    const pipeline = new RealMemoryPipeline(store, throwing, {
      onError: (message) => errors.push(message),
    });

    await expect(
      pipeline.runMemoryPipeline("seg-1"),
    ).resolves.toBeUndefined();

    // Consolidator swallows the extractor error itself, so zero notes and no
    // pipeline-level error — the task is untouched, never failed.
    expect(store.snapshot().notes).toHaveLength(0);
    expect(store.snapshot().groupTasks[0]!.status).toBe("completed");
  });

  it("uses recognizer routing and reviews fallback matches", async () => {
    const { store } = await seededStore();
    const recognizer: NoteRecognizer = {
      async recognizeAgents(_noteText, members) {
        return {
          threshold: 0.9,
          matches: [
            {
              agentId: members[1]!.id,
              score: 0.31,
              matchKind: "fallback",
            },
          ],
        };
      },
    };
    const pipeline = new RealMemoryPipeline(store, new FakeExtractorClient(), {
      recognizer,
    });

    // KL_Divergence re-keyed the pipeline from groupTaskId to segmentId.
    // seg-1 is the fixture segment covering task-1.
    await pipeline.runMemoryPipeline("seg-1");

    const notes = store.snapshot().notes;
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.every((note) => note.targetAgentIds.length > 0)).toBe(true);
    expect(notes.every((note) => note.targetAgentIds.length === 1)).toBe(true);
    expect(notes.every((note) => note.targetAgentIds[0] === AGENT_B)).toBe(true);
    expect(notes.every((note) => note.recognitionMatchKind === "fallback")).toBe(true);
    expect(notes.every((note) => note.recognitionScores?.[AGENT_B] === 0.31)).toBe(true);
    expect(notes.every((note) => note.status === "pending")).toBe(true);
  });

  it("logs and swallows when the task cannot be found", async () => {
    const { store } = await seededStore();
    const errors: string[] = [];
    const pipeline = new RealMemoryPipeline(store, new FakeExtractorClient(), {
      onError: (message) => errors.push(message),
    });

    await pipeline.runMemoryPipeline("does-not-exist");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("does-not-exist");
  });
});

describe("createMemoryPipeline", () => {
  it("does not initialize governed memory when the master switch is off", async () => {
    const { store } = await seededStore();
    const pipeline = createMemoryPipeline(store, {
      memoryEnabled: false,
      memoryExtractor: "ark",
      memoryExtractTimeoutMs: 30_000,
      arkApiKey: "",
      arkModel: "",
      arkBaseUrl: "https://example.test",
    });

    expect(pipeline).toBeInstanceOf(NoopMemoryPipeline);
    await pipeline.runMemoryPipeline("seg-1");
    expect(store.snapshot().notes).toEqual([]);
  });

  it("fails clearly instead of replacing an unavailable SBERT runtime with fake", async () => {
    const { store, root } = await seededStore();

    expect(() =>
      createMemoryPipeline(store, {
        memoryExtractor: "fake",
        memoryExtractTimeoutMs: 30_000,
        arkApiKey: "",
        arkModel: "",
        arkBaseUrl: "https://example.test",
        memoryRecognizer: "sbert",
        memorySbertPython: "python3",
        memorySbertModelDir: path.join(root, "missing-model"),
        memorySbertBridge: path.join(root, "missing-bridge.py"),
      }),
    ).toThrow("No automatic fake fallback is configured");
  });
});

describe("RealMemoryPipeline.resetAutoNotes", () => {
  it("removes auto notes + files but keeps human-decided notes", async () => {
    const { store } = await seededStore();
    const landing = new LandingService(store);

    const autoNote = memoryNote("auto");
    const humanNote = memoryNote("human");

    // Land both so each has a real SKILL.md on disk + a landedMemoryFiles row.
    await landing.landMemory(autoNote);
    await landing.landMemory(humanNote);
    await store.mutate((db) => {
      db.notes.push(autoNote, humanNote);
      // autoNote: only an automatic grant (null reviewer). humanNote: a human
      // stamped a reviewerName, marking it human-decided.
      db.grants.push(
        {
          id: "g-auto",
          groupTaskId: "task-1",
          noteId: autoNote.id,
          agentId: AGENT_A,
          decision: "granted",
          reason: "granted",
          filePath: "x",
          reviewerName: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "g-human",
          groupTaskId: "task-1",
          noteId: humanNote.id,
          agentId: AGENT_A,
          decision: "granted",
          reason: "granted",
          filePath: "y",
          reviewerName: "Lionel",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      );
    });

    const autoFile = store
      .snapshot()
      .landedMemoryFiles.find((f) => f.noteId === autoNote.id)!.path;
    const humanFile = store
      .snapshot()
      .landedMemoryFiles.find((f) => f.noteId === humanNote.id)!.path;
    expect(await exists(autoFile)).toBe(true);

    const pipeline = new RealMemoryPipeline(store, new FakeExtractorClient());
    await pipeline.resetAutoNotes("task-1");

    const db = store.snapshot();
    // Auto note: gone from every table, file deleted.
    expect(db.notes.some((n) => n.id === autoNote.id)).toBe(false);
    expect(db.grants.some((g) => g.noteId === autoNote.id)).toBe(false);
    expect(db.landedMemoryFiles.some((f) => f.noteId === autoNote.id)).toBe(false);
    expect(await exists(autoFile)).toBe(false);
    // Human-decided note: untouched.
    expect(db.notes.some((n) => n.id === humanNote.id)).toBe(true);
    expect(db.grants.some((g) => g.noteId === humanNote.id)).toBe(true);
    expect(await exists(humanFile)).toBe(true);
  });
});

function memoryNote(kind: string): import("../types.js").MemoryNote {
  return {
    id: `${kind}-11111111-1111-4111-8111-11111111111${kind === "auto" ? "1" : "2"}`,
    groupTaskId: "task-1",
    groupId: "group-1",
    content: `A durable fact (${kind}).`,
    severity: "normal",
    status: "active",
    targetAgentIds: [AGENT_A],
    description: `${kind} note`,
    sourceRunIds: [RUN_A],
    sourceSpanIds: [SPAN_A],
    rationale: "",
    redactionFired: false,
    quarantineHit: false,
    safetyReasons: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
