import { describe, expect, it } from "vitest";
import type { Agent, AgentGroup } from "../types.js";
import { Consolidator } from "./consolidator.js";
import { FakeExtractorClient, type ExtractorClient } from "./extractor-client.js";
import type { TaskBuffer, TaskBufferEntry } from "./types.js";

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

const taskBuffer: TaskBuffer = {
  groupTaskId: "task-1",
  groupId: "group-1",
  prompt: "Build the upload feature.",
  status: "completed",
  orderedNodeIds: ["n1", "n2"],
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
const input = { taskBuffer, group, members };

function noteJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    notes: [
      {
        content: "The upload endpoint caps files at 10MB.",
        severity: "severe",
        targetAgentIds: [AGENT_A],
        description: "Upload size limit.",
        sourceRunIds: [RUN_A],
        sourceSpanIds: [SPAN_A],
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
      expect(note.groupTaskId).toBe("task-1");
      expect(note.id).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it("rejects notes targeting out-of-group Agents", async () => {
    const notes = await new Consolidator(
      new StubExtractor(noteJson({ targetAgentIds: [OUTSIDER] })),
    ).consolidate(input);
    expect(notes).toEqual([]);
  });

  it("rejects notes citing source span IDs not present in the buffer", async () => {
    const notes = await new Consolidator(
      new StubExtractor(
        noteJson({ sourceSpanIds: ["99999999-9999-4999-8999-999999999999"] }),
      ),
    ).consolidate(input);
    expect(notes).toEqual([]);
  });

  it("caps the result at five notes", async () => {
    const many = {
      notes: Array.from({ length: 8 }, () => ({
        content: "A durable constraint.",
        severity: "normal",
        targetAgentIds: [AGENT_A],
        description: "desc",
        sourceRunIds: [RUN_A],
        sourceSpanIds: [SPAN_A],
        rationale: "",
      })),
    };
    const notes = await new Consolidator(
      new StubExtractor(JSON.stringify(many)),
    ).consolidate(input);
    expect(notes).toHaveLength(5);
  });

  it("returns zero notes on malformed extractor output", async () => {
    const notes = await new Consolidator(
      new StubExtractor("this is not json {{{"),
    ).consolidate(input);
    expect(notes).toEqual([]);
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
