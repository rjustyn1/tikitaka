/**
 * Topic segment lifecycle -- see
 * `docs/superpowers/specs/2026-08-30-topic-segment-consolidation-design.md`.
 *
 * A segment is a run of consecutive group tasks that stayed on one subject. It
 * is the unit memory consolidates over: the chat accumulates while the subject
 * holds, and the whole segment is extracted once when it changes.
 *
 * Everything here is pure. Nothing reads the store or the clock -- callers pass
 * the rows and the timestamp in, which keeps the boundary rules testable
 * without a database and lets the whole decision run inside the caller's
 * existing `store.mutate` transaction.
 */

import { randomUUID } from "node:crypto";
import type {
  GroupMessage,
  GroupTask,
  SegmentCloseReason,
  TopicSegment,
} from "../types.js";
import { scoreDrift } from "./topic-drift.js";

export interface SegmentPolicy {
  /** JS drift above this opens a new segment. */
  driftThreshold: number;
  /** Close after this many tasks regardless of subject. */
  maxTasks: number;
  /** Close once the segment's transcript reaches this many characters. */
  maxChars: number;
  /** Close a silent segment after this long, checked lazily on group reads. */
  idleMs: number;
}

/**
 * CALIBRATED, NOT GUESSED. Measured against the worked prompts in
 * `middlewaredoc/GROUP-CHAT-DESIGN.md` (see `topic-drift.test.ts` for the
 * fixtures):
 *
 *   same-subject follow-ups   0.55 - 0.83
 *   subject changes           1.00  (no shared vocabulary at all)
 *
 * 0.90 sits in that gap. An earlier draft used 0.82, which sat BELOW a
 * legitimate same-subject follow-up ("review the upload validation and auth
 * boundaries" scored 0.832) and would have split it.
 *
 * KNOWN LIMITATION -- this detector resolves hard subject changes, not soft
 * ones. A shift that still shares a word or two with the segment scores around
 * 0.74-0.78, which overlaps the range same-subject follow-ups occupy while a
 * segment is short. Those go uncaught until `maxTasks` or `maxChars` closes the
 * segment. Raising sensitivity to catch them would start splitting genuine
 * follow-ups, which is the more expensive error: a missed split costs one
 * oversized consolidation, while a false split costs a topic torn in half.
 */
export const DEFAULT_SEGMENT_POLICY: SegmentPolicy = {
  driftThreshold: 0.9,
  maxTasks: 8,
  maxChars: 120_000,
  idleMs: 30 * 60 * 1000,
};

export type SegmentBoundary =
  | { kind: "continue" }
  | {
      kind: "close";
      reason: SegmentCloseReason;
      /** The score that closed it; null unless reason is "topic_shift". */
      driftScore: number | null;
    };

export interface SegmentBoundaryInput {
  segment: TopicSegment;
  /** The segment's human prompts, pooled by the scorer. Agent turns excluded. */
  segmentPrompts: readonly string[];
  segmentChars: number;
  incomingPrompt: string;
  policy: SegmentPolicy;
}

/** The single open segment for a group, if it has one. */
export function findOpenSegment(
  segments: readonly TopicSegment[],
  groupId: string,
): TopicSegment | undefined {
  return segments.find(
    (segment) => segment.groupId === groupId && segment.status === "open",
  );
}

/**
 * The segment's human prompts, in task order.
 *
 * Each group task carries exactly one human prompt, so the task rows ARE the
 * human side of the conversation -- no need to filter the message timeline by
 * speaker. This is the only text the drift scorer sees; see `topic-drift.ts`
 * for why agent turns are excluded.
 */
export function humanPromptsIn(
  segment: TopicSegment,
  tasks: readonly GroupTask[],
): string[] {
  return tasksIn(segment, tasks).map((task) => task.prompt);
}

/**
 * The segment's task rows, in the order they were attached. Shared with the
 * buffer builder so prompt order and entry order cannot drift apart.
 */
export function tasksIn(
  segment: TopicSegment,
  tasks: readonly GroupTask[],
): GroupTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return segment.groupTaskIds
    .map((id) => byId.get(id))
    .filter((task): task is GroupTask => task !== undefined);
}

/** Total transcript size inside the segment's seq range. */
export function transcriptCharsIn(
  segment: TopicSegment,
  messages: readonly GroupMessage[],
): number {
  return messagesIn(segment, messages).reduce(
    (total, message) => total + message.content.length,
    0,
  );
}

/** Messages inside the segment's range, in seq order. An open segment runs to the end. */
export function messagesIn(
  segment: TopicSegment,
  messages: readonly GroupMessage[],
): GroupMessage[] {
  return messages
    .filter(
      (message) =>
        message.groupId === segment.groupId &&
        message.seq >= segment.startSeq &&
        (segment.endSeq === null || message.seq <= segment.endSeq),
    )
    .sort((left, right) => left.seq - right.seq);
}

/**
 * Should the open segment keep accumulating this prompt, or close first?
 *
 * Caps are checked before drift: they are cheaper and unconditional, and a
 * segment at its cap closes whatever the subject is.
 */
export function decideSegmentBoundary(
  input: SegmentBoundaryInput,
): SegmentBoundary {
  const { segment, policy } = input;

  if (
    segment.groupTaskIds.length >= policy.maxTasks ||
    input.segmentChars >= policy.maxChars
  ) {
    return { kind: "close", reason: "size_cap", driftScore: null };
  }

  // Returns 0 when either side lacks the evidence to judge, which reads as
  // "keep accumulating" -- the recoverable direction.
  const drift = scoreDrift(input.segmentPrompts, input.incomingPrompt);
  if (drift > policy.driftThreshold) {
    return { kind: "close", reason: "topic_shift", driftScore: drift };
  }

  return { kind: "continue" };
}

export function createSegment(
  groupId: string,
  startSeq: number,
  at: string,
): TopicSegment {
  return {
    id: randomUUID(),
    groupId,
    status: "open",
    startSeq,
    endSeq: null,
    groupTaskIds: [],
    closeReason: null,
    driftScore: null,
    flushedAt: null,
    createdAt: at,
    closedAt: null,
  };
}

export interface CloseSegmentInput {
  reason: SegmentCloseReason;
  driftScore: number | null;
  endSeq: number;
  at: string;
}

/**
 * Mark a segment closed. Deliberately does NOT touch `flushedAt`: closing is a
 * store mutation, consolidating is an async pipeline run that may fail, and
 * keeping them separate means a failed extraction can be retried against a
 * segment that is already correctly bounded.
 */
export function closeSegmentInPlace(
  segment: TopicSegment,
  input: CloseSegmentInput,
): void {
  segment.status = "closed";
  segment.closeReason = input.reason;
  segment.driftScore = input.driftScore;
  segment.endSeq = input.endSeq;
  segment.closedAt = input.at;
}

/**
 * The group's open segment if it has gone quiet past `idleMs`, else undefined.
 *
 * Ages on the NEWEST message: a segment is idle when nothing has happened
 * recently, not when it happens to contain something old.
 */
export function findIdleSegment(
  segments: readonly TopicSegment[],
  messages: readonly GroupMessage[],
  groupId: string,
  idleMs: number,
  nowMs: number,
): TopicSegment | undefined {
  const open = findOpenSegment(segments, groupId);
  if (!open) return undefined;

  const contained = messagesIn(open, messages);
  if (contained.length === 0) return undefined;

  const newest = contained.reduce(
    (latest, message) =>
      Math.max(latest, new Date(message.createdAt).getTime()),
    0,
  );
  return nowMs - newest > idleMs ? open : undefined;
}
