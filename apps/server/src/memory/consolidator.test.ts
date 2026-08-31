import { describe, expect, it } from "vitest";
import type { Agent, AgentGroup } from "../types.js";
import { Consolidator } from "./consolidator.js";
import { FakeExtractorClient, type ExtractorClient } from "./extractor-client.js";
import type { SegmentBuffer, TaskBufferEntry } from "./types.js";

const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const SPAN_A = "22222222-2222-4222-8222-222222222222";
const RUN_B = "33333333-3333-4333-8333-333333333333";
const SPAN_B = "44444444-4444-4444-8444-444444444444";

class StubExtractor implements ExtractorClient {
  constructor(private readonly raw: string) {}
  async extract() {
    return { rawText: this.raw };
  }
}

function entry(
  planNodeId: string,
  agentId: string,
  runId: string,
  spanId: string,
): TaskBufferEntry {
  return {
    planNodeId,
    agentId,
    nodeRole: "backend",
    runId,
    output: "did the work",
    spans: [
      {
        id: spanId,
        runId,
        agentId,
        seq: 1,
        type: "agent_message",
        parentId: null,
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        payload: { kind: "agent_message", text: "the endpoint caps at 10MB" },
        itemId: null,
      },
    ],
    injectedMessageIds: [],
    injectedDependencyNodeIds: [],
  };
}

const segmentBuffer: SegmentBuffer = {
  segmentId: "seg-1",
  groupId: "group-1",
  prompts: ["Build the upload feature.", "Add resumable uploads."],
  groupTaskIds: ["task-1", "task-2"],
  transcript: [
    { seq: 1, speakerType: "human", agentId: null, content: "Build the upload feature." },
    { seq: 2, speakerType: "agent", agentId: AGENT_A, content: "Defined POST /uploads." },
    { seq: 3, speakerType: "human", agentId: null, content: "Add resumable uploads." },
  ],
  entries: [
    entry("n1", AGENT_A, RUN_A, SPAN_A),
    entry("n2", AGENT_B, RUN_B, SPAN_B),
  ],
};

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/ws/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const group: AgentGroup = {
  id: "group-1",
  name: "Upload Team",
  description: "",
  memberAgentIds: [AGENT_A, AGENT_B],
  activeTaskId: "task-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const members = [agent(AGENT_A, "Backend"), agent(AGENT_B, "Frontend")];
const input = { segmentBuffer, group, members };

function noteJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    notes: [
      {
        content: "The upload endpoint caps files at 10MB.",
        severity: "severe",
        targetAgentIds: [AGENT_A],
        description: "Upload size limit.",
        // 1-based indices: run 1 -> RUN_A, span 1 -> SPAN_A (first entry).
        sourceRunIndices: [1],
        sourceSpanIndices: [1],
        rationale: "Decided during the task.",
        ...overrides,
      },
    ],
  });
}

describe("Consolidator", () => {
  it("extracts multiple targeted notes from a fixture buffer via the fake extractor", async () => {
    const notes = await new Consolidator(new FakeExtractorClient()).consolidate(
      input,
    );
    expect(notes.length).toBeGreaterThanOrEqual(2);
    for (const note of notes) {
      expect([AGENT_A, AGENT_B]).toContain(note.targetAgentIds[0]);
      expect([SPAN_A, SPAN_B]).toContain(note.sourceSpanIds[0]);
      expect(note.segmentId).toBe("seg-1");
      // The segment's LAST task, so per-task queries downstream still resolve.
      expect(note.groupTaskId).toBe("task-2");
      expect(note.id).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it("rejects notes targeting out-of-group Agents", async () => {
    const notes = await new Consolidator(
      new StubExtractor(noteJson({ targetAgentIds: [OUTSIDER] })),
    ).consolidate(input);
    expect(notes).toEqual([]);
  });

  it("drops out-of-range source span indices but keeps the note", async () => {
    const notes = await new Consolidator(
      new StubExtractor(noteJson({ sourceSpanIndices: [99] })),
    ).consolidate(input);
    // The bad index resolves to nothing; the note survives (models cite loosely).
    expect(notes).toHaveLength(1);
    expect(notes[0]!.sourceSpanIds).toEqual([]);
  });

  it("defaults missing severity/targets/description instead of dropping the note", async () => {
    // A minimal note like the real Ark model returned: only content + sources.
    const minimal = JSON.stringify({
      notes: [
        {
          content: "All API datetimes are UTC; the frontend localizes for display.",
          sourceRunIndices: [1],
          sourceSpanIndices: [1],
        },
      ],
    });
    const notes = await new Consolidator(new StubExtractor(minimal)).consolidate(
      input,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.severity).toBe("normal");
    // No targets given -> defaults to the whole group.
    expect(notes[0]!.targetAgentIds.sort()).toEqual([AGENT_A, AGENT_B].sort());
    expect(notes[0]!.description.length).toBeGreaterThan(0);
  });

  it("caps the result at eight notes", async () => {
    const many = {
      notes: Array.from({ length: 12 }, () => ({
        content: "A durable constraint.",
        severity: "normal",
        targetAgentIds: [AGENT_A],
        description: "desc",
        sourceRunIndices: [1],
        sourceSpanIndices: [1],
        rationale: "",
      })),
    };
    const notes = await new Consolidator(
      new StubExtractor(JSON.stringify(many)),
    ).consolidate(input);
    expect(notes).toHaveLength(8);
  });

  it("returns zero notes on malformed extractor output", async () => {
    const notes = await new Consolidator(
      new StubExtractor("this is not json {{{"),
    ).consolidate(input);
    expect(notes).toEqual([]);
  });

  it("threads the configured timeout through to the extractor request", async () => {
    let seenTimeout = 0;
    const capturing: ExtractorClient = {
      async extract(request) {
        seenTimeout = request.timeoutMs;
        return { rawText: '{"notes":[]}' };
      },
    };
    await new Consolidator(capturing, 4242).consolidate(input);
    expect(seenTimeout).toBe(4242);
  });

  it("returns zero notes when the extractor throws", async () => {
    const throwing: ExtractorClient = {
      async extract() {
        throw new Error("network down");
      },
    };
    const notes = await new Consolidator(throwing).consolidate(input);
    expect(notes).toEqual([]);
  });
});
