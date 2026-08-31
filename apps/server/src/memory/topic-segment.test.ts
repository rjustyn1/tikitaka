import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGMENT_POLICY,
  closeSegmentInPlace,
  createSegment,
  decideSegmentBoundary,
  findIdleSegment,
  findOpenSegment,
  humanPromptsIn,
  transcriptCharsIn,
} from "./topic-segment.js";
import type { GroupMessage, GroupTask, TopicSegment } from "../types.js";

const AT = "2026-08-30T12:00:00.000Z";

function makeSegment(overrides: Partial<TopicSegment> = {}): TopicSegment {
  return {
    id: "seg-1",
    groupId: "group-1",
    status: "open",
    startSeq: 1,
    endSeq: null,
    groupTaskIds: ["task-1"],
    closeReason: null,
    driftScore: null,
    flushedAt: null,
    createdAt: AT,
    closedAt: null,
    ...overrides,
  };
}

function makeTask(id: string, prompt: string): GroupTask {
  return {
    id,
    groupId: "group-1",
    prompt,
    sharedCodePath: `/tmp/shared/${id}`,
    status: "completed",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt: AT,
    startedAt: AT,
    completedAt: AT,
  };
}

function makeMessage(seq: number, content: string, createdAt = AT): GroupMessage {
  return {
    id: `msg-${seq}`,
    groupId: "group-1",
    seq,
    speakerType: "agent",
    speakerAgentId: "agent-1",
    groupTaskId: "task-1",
    planNodeId: null,
    content,
    createdAt,
  };
}

// A segment whose pooled prompts clear MIN_EVIDENCE_TERMS, so drift scoring is
// actually exercised rather than short-circuited by the evidence guard.
const UPLOAD_PROMPTS = [
  "Plan and implement an upload feature with storage and a public contract.",
  "Add resumable upload support to the storage endpoint we defined.",
];

describe("findOpenSegment", () => {
  it("finds the open segment for the group", () => {
    const segments = [
      makeSegment({ id: "seg-closed", status: "closed" }),
      makeSegment({ id: "seg-open" }),
    ];
    expect(findOpenSegment(segments, "group-1")?.id).toBe("seg-open");
  });

  it("ignores open segments belonging to another group", () => {
    const segments = [makeSegment({ id: "seg-other", groupId: "group-2" })];
    expect(findOpenSegment(segments, "group-1")).toBeUndefined();
  });

  it("returns undefined when the group has never had a segment", () => {
    expect(findOpenSegment([], "group-1")).toBeUndefined();
  });
});

describe("humanPromptsIn", () => {
  it("collects the prompts of the segment's tasks in order", () => {
    const segment = makeSegment({ groupTaskIds: ["task-1", "task-2"] });
    const tasks = [makeTask("task-2", "second"), makeTask("task-1", "first")];
    expect(humanPromptsIn(segment, tasks)).toEqual(["first", "second"]);
  });

  it("skips task ids with no matching task row", () => {
    const segment = makeSegment({ groupTaskIds: ["task-1", "missing"] });
    expect(humanPromptsIn(segment, [makeTask("task-1", "first")])).toEqual(["first"]);
  });
});

describe("transcriptCharsIn", () => {
  it("counts only messages inside the segment's seq range", () => {
    const segment = makeSegment({ startSeq: 2, endSeq: 3 });
    const messages = [
      makeMessage(1, "before"),
      makeMessage(2, "abc"),
      makeMessage(3, "de"),
      makeMessage(4, "after"),
    ];
    expect(transcriptCharsIn(segment, messages)).toBe(5);
  });

  it("counts to the end of the timeline while the segment is open", () => {
    const segment = makeSegment({ startSeq: 1, endSeq: null });
    expect(transcriptCharsIn(segment, [makeMessage(1, "ab"), makeMessage(9, "cd")])).toBe(4);
  });
});

describe("decideSegmentBoundary", () => {
  const base = {
    segment: makeSegment(),
    segmentPrompts: UPLOAD_PROMPTS,
    segmentChars: 100,
    policy: DEFAULT_SEGMENT_POLICY,
  };

  it("continues when the incoming prompt stays on subject", () => {
    const decision = decideSegmentBoundary({
      ...base,
      incomingPrompt: "Harden the upload storage contract and its validation.",
    });
    expect(decision.kind).toBe("continue");
  });

  it("closes on topic shift and reports the score that caused it", () => {
    const decision = decideSegmentBoundary({
      ...base,
      incomingPrompt: "Configure Kubernetes cluster autoscaling for production.",
    });
    expect(decision.kind).toBe("close");
    if (decision.kind !== "close") throw new Error("expected close");
    expect(decision.reason).toBe("topic_shift");
    expect(decision.driftScore).toBeGreaterThan(DEFAULT_SEGMENT_POLICY.driftThreshold);
  });

  it("closes on the task cap even when the subject has not changed", () => {
    const decision = decideSegmentBoundary({
      ...base,
      segment: makeSegment({
        groupTaskIds: Array.from({ length: DEFAULT_SEGMENT_POLICY.maxTasks }, (_, i) => `task-${i}`),
      }),
      incomingPrompt: "Harden the upload storage contract and its validation.",
    });
    expect(decision.kind).toBe("close");
    if (decision.kind !== "close") throw new Error("expected close");
    expect(decision.reason).toBe("size_cap");
    expect(decision.driftScore).toBeNull();
  });

  it("closes on the transcript char cap", () => {
    const decision = decideSegmentBoundary({
      ...base,
      segmentChars: DEFAULT_SEGMENT_POLICY.maxChars,
      incomingPrompt: "Harden the upload storage contract and its validation.",
    });
    expect(decision.kind).toBe("close");
    if (decision.kind !== "close") throw new Error("expected close");
    expect(decision.reason).toBe("size_cap");
  });

  it("continues on the very first follow-up, before there is evidence to judge", () => {
    const decision = decideSegmentBoundary({
      ...base,
      segmentPrompts: ["Fix it."],
      incomingPrompt: "Configure Kubernetes cluster autoscaling for production.",
    });
    expect(decision.kind).toBe("continue");
  });
});

describe("createSegment", () => {
  it("opens a segment that starts at the given seq and owns no tasks yet", () => {
    const segment = createSegment("group-1", 7, AT);
    expect(segment.groupId).toBe("group-1");
    expect(segment.status).toBe("open");
    expect(segment.startSeq).toBe(7);
    expect(segment.endSeq).toBeNull();
    expect(segment.groupTaskIds).toEqual([]);
    expect(segment.flushedAt).toBeNull();
  });

  it("gives each segment a distinct id", () => {
    expect(createSegment("group-1", 1, AT).id).not.toBe(createSegment("group-1", 1, AT).id);
  });
});

describe("closeSegmentInPlace", () => {
  it("stamps status, reason, boundary and time", () => {
    const segment = makeSegment();
    closeSegmentInPlace(segment, {
      reason: "topic_shift",
      driftScore: 0.97,
      endSeq: 12,
      at: AT,
    });
    expect(segment.status).toBe("closed");
    expect(segment.closeReason).toBe("topic_shift");
    expect(segment.driftScore).toBe(0.97);
    expect(segment.endSeq).toBe(12);
    expect(segment.closedAt).toBe(AT);
  });

  it("leaves flushedAt alone so closing and consolidating stay separate steps", () => {
    const segment = makeSegment();
    closeSegmentInPlace(segment, { reason: "idle", driftScore: null, endSeq: 3, at: AT });
    expect(segment.flushedAt).toBeNull();
  });
});

describe("findIdleSegment", () => {
  const idleMs = DEFAULT_SEGMENT_POLICY.idleMs;
  const now = new Date("2026-08-30T13:00:00.000Z").getTime();

  it("returns the open segment when its newest message is older than the window", () => {
    const stale = new Date(now - idleMs - 1000).toISOString();
    const segments = [makeSegment()];
    const messages = [makeMessage(1, "old", stale)];
    expect(findIdleSegment(segments, messages, "group-1", idleMs, now)?.id).toBe("seg-1");
  });

  it("returns undefined while the segment is still active", () => {
    const fresh = new Date(now - 1000).toISOString();
    const segments = [makeSegment()];
    const messages = [makeMessage(1, "recent", fresh)];
    expect(findIdleSegment(segments, messages, "group-1", idleMs, now)).toBeUndefined();
  });

  it("returns undefined when the segment has no messages to age", () => {
    expect(findIdleSegment([makeSegment()], [], "group-1", idleMs, now)).toBeUndefined();
  });

  it("ages on the newest message, not the oldest", () => {
    const stale = new Date(now - idleMs - 1000).toISOString();
    const fresh = new Date(now - 1000).toISOString();
    const segments = [makeSegment()];
    const messages = [makeMessage(1, "old", stale), makeMessage(2, "new", fresh)];
    expect(findIdleSegment(segments, messages, "group-1", idleMs, now)).toBeUndefined();
  });
});
