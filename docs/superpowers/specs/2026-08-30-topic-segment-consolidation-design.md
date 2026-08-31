# Topic-Segment Consolidation

**Date:** 2026-08-30
**Status:** Implemented. Deviations from the original design are marked **[revised]**.
**Extends:** `middlewaredoc/components/FLUSH-TRIGGER.md`, `middlewaredoc/components/TASK-BUFFER.md`

## Problem

A group chat timeline is per-group and persists across group tasks
(`GroupMessage.groupId`, ordered by `seq`). Memory consolidation is per-*task*:
`decideFlush` fires when one `GroupTask` is terminal, and everything downstream
keys off `groupTaskId`.

That mismatch causes two failures:

1. **Over-splitting.** Four consecutive tasks on one subject produce four
   separate consolidations, each seeing a quarter of the picture. Durable facts
   that only emerge across tasks are never extracted.
2. **Context bleed.** `buildContextPacket` (`group-prompt.ts:36`) injects every
   message since `lastSeenSeq` with no semantic filter. When the user changes
   subject, the new task's agents still receive the whole prior transcript.

We want consolidation keyed to a **topic**, not a task: accumulate the chat while
the subject holds, and flush the whole accumulated transcript when it changes.

## Detection approach and its known limitation

The boundary detector is **Jensen-Shannon divergence over unigram term
distributions**. This was chosen deliberately over an LLM judge and over
embedding cosine distance, with the tradeoff understood and accepted.

**The known weakness.** In a role-based group chat, lexical vocabulary tracks the
*speaker's* specialty more strongly than it tracks the subject. On the worked
example in `middlewaredoc/GROUP-CHAT-DESIGN.md`, the Backend agent's turn
("define POST /uploads and the storage flow") and the Security agent's turn
("review validation, auth, and secret boundaries") share zero content words
despite being one topic — while a genuine subject change to "add rate limiting to
the auth endpoints" shares more. A naive word-level divergence ranks the
same-topic handoff as *more* divergent than the real boundary.

**The mitigation, and it is the core of this design.** The scorer compares the
incoming human prompt against the pooled distribution of the segment's **prior
human prompts only**. Agent messages never enter the scorer. Both sides of the
comparison then come from a single speaker, so specialty vocabulary cannot rotate
underneath the score and the inversion above cannot occur. Agent messages still
enter the consolidator *buffer* in full — the restriction is on scoring, not on
what gets remembered.

**Why JS and not KL.** KL is asymmetric, unbounded, and infinite wherever the
reference distribution has zero mass — so it requires a smoothing constant, and
on texts this short the resulting score tracks that constant more than it tracks
the topic. JS's mixture `M = (P+Q)/2` has support wherever either side does, so
every term is finite by construction. No smoothing constant exists to dominate
the result. JS is also symmetric and bounded in `[0, 1]` with log base 2, which
makes a fixed threshold meaningful.

**Failure asymmetry, and how the threshold is biased.** A false split costs two
smaller consolidations with some redundancy — cheap. A missed split feeds the
consolidator two subjects at once and it writes muddled notes — expensive, and
invisible until someone reads the memory. So the threshold is biased toward
over-splitting. The degenerate case of an over-eager detector is one segment per
task, which is exactly today's behaviour: **this feature cannot perform worse
than the status quo.**

## Data model

New persisted type in `apps/server/src/types.ts`:

```ts
export interface TopicSegment {
  id: string;
  groupId: string;
  status: "open" | "closed";
  /** First groupMessage.seq belonging to this segment. */
  startSeq: number;
  /** Last groupMessage.seq, set on close. */
  endSeq: number | null;
  groupTaskIds: string[];
  closeReason: "topic_shift" | "size_cap" | "idle" | null;
  /** The JS score that closed it. Null unless closeReason is "topic_shift". */
  driftScore: number | null;
  flushedAt: string | null;
  createdAt: string;
  closedAt: string | null;
}
```

Added to `Database` as `topicSegments: TopicSegment[]`, with the same defensive
array init used at `store.ts:41`.

**Invariant: at most one segment with `status: "open"` per `groupId`.** Enforced
inside the single `store.mutate` that creates a task; asserted in tests.

## Control flow

The boundary decision fires inside the existing `store.mutate` in
`GroupRunner.startGroupTask` (`group-runner.ts:302`) — the same transaction that
pushes the `GroupTask` and the human `GroupMessage`, so a segment can never be
half-assigned.

```text
startGroupTask(groupId, prompt)
  |
  +- store.mutate:
  |    open = topicSegments.find(s => s.groupId === groupId && s.status === "open")
  |
  |    if (!open)
  |        create segment, attach task, NO SCORING
  |        (nothing to compare against on the first prompt)
  |
  |    else
  |        js  = scoreDrift(humanPromptsOf(open), prompt)
  |        cap = open.groupTaskIds.length >= MAX_TASKS
  |           || transcriptChars(open) >= MAX_CHARS
  |
  |        if (js > TAU || cap)
  |            close(open, reason, driftScore: js)
  |            create new segment, attach task to the NEW segment
  |        else
  |            attach task to open segment
  |
  +- (after commit) if a segment closed:
       void runMemoryPipeline(closedSegmentId)   // fire-and-forget, fails open
```

**Why the flush needs no coordination.** `startGroupTask` returns 409 when the
group already has a running task (`group-runner.ts:308`). A new human prompt can
therefore only arrive when the group is idle, which means **every task in the
closing segment is already terminal**. The pipeline runs concurrently with the
new task starting; there is nothing to wait for and no lock to take.

`decideFlush` is reused to assert this rather than assume it. If any task in a
closing segment is somehow unsettled, the segment closes but does not flush, and
the flush is retried on the next close attempt.

**[revised]** That reuse needed a new `ignoreFlushMark` option on
`FlushTriggerInput`. `GroupTask.flushedAt` is now stamped by segment bookkeeping
on every settled task, so `decideFlush`'s once-only guard would have reported
every task unsettled and **no segment could ever have consolidated**. The flag
separates the two questions: `flushedAt` marks that a task has been accounted
for; `TopicSegment.flushedAt` marks that its memory was extracted.

## The scorer — `apps/server/src/memory/topic-drift.ts`

Pure, no I/O, no store access. Fully unit-testable.

```ts
export function termDistribution(text: string): Map<string, number>;
export function jsDivergence(p: Map<string, number>, q: Map<string, number>): number;
export function scoreDrift(segmentPrompts: readonly string[], incoming: string): number;
```

Pipeline: lowercase, strip non-alphanumeric, split on whitespace, drop tokens
shorter than 3 characters, drop stopwords (a small inline English list — no new
dependency), strip light suffixes (`ing|ed|es|s|tion`), count, normalize to a
probability distribution.

`jsDivergence` computes over the union vocabulary with log base 2, returning a
value in `[0, 1]`. No smoothing.

`scoreDrift` pools all `segmentPrompts` into one distribution and returns
`jsDivergence(pooled, termDistribution(incoming))`.

**Minimum-evidence guard** (`MIN_EVIDENCE_TERMS = 8`). If the pooled segment
distribution has fewer than 8 distinct content terms, `scoreDrift` returns `0`. Two short prompts share almost
no vocabulary regardless of subject, so scoring them produces noise; returning 0
means the segment simply keeps accumulating until there is enough text to judge.

## Configuration

Added to `AppConfig` alongside the existing `memory*` keys:

| Env var | Default | Meaning |
|---|---|---|
| `MEMORY_TOPIC_DRIFT_THRESHOLD` | `0.90` **[revised]** | JS above this opens a new segment |
| `MEMORY_SEGMENT_MAX_TASKS` | `8` | Hard cap; closes with `size_cap` |
| `MEMORY_SEGMENT_MAX_CHARS` | `120000` | Transcript char cap; closes with `size_cap` |
| `MEMORY_SEGMENT_IDLE_MS` | `1800000` | Idle close window (30 min) |

## Idle close

A segment only closes when the *next* prompt arrives, so a user who stops working
would leave their final segment unconsolidated.

Resolution: a **lazy check on group reads**. Any group-scoped read path calls
`sweepIdleSegments(groupId)`, which closes and flushes any open segment whose
newest message is older than `MEMORY_SEGMENT_IDLE_MS`, with
`closeReason: "idle"`. No timers, no background loop, no new lifecycle to start,
stop, or stub in tests.

Accepted limitation: a group nobody ever revisits stays unconsolidated
indefinitely. This is deliberate — the alternative is a background sweep timer,
whose lifecycle cost was judged higher than the cost of this gap.

## Buffer — `TaskBuffer` becomes `SegmentBuffer`

`apps/server/src/memory/types.ts`:

```ts
export interface SegmentTranscriptLine {
  seq: number;
  speakerType: "human" | "agent";
  agentId: string | null;
  content: string;
}

export interface SegmentBuffer {
  segmentId: string;
  groupId: string;
  /** Every task prompt in the segment, in order. Survives transcript trimming. */
  prompts: string[];
  groupTaskIds: string[];
  /** The full group chat over [startSeq, endSeq]. */
  transcript: SegmentTranscriptLine[];
  /** Every node across the segment's tasks, in execution order. */
  entries: TaskBufferEntry[];
}
```

`entries` is the union across every task in the segment, ordered by attachment
order then by the existing `topologicalSort` within each task. **[revised]** The
original design also carried `orderedNodeIds` and `status`; both were dropped as
dead weight -- nothing read `status`, and `orderedNodeIds` is exactly
`entries.map(e => e.planNodeId)`. `FlushDecision.sinkNodeIds` went the same way:
the pipeline stopped taking it when consolidation moved to segments, leaving
only its own tests to exercise it. `TaskBufferEntry` is
unchanged, so `sourceRunIndices` / `sourceSpanIndices` provenance numbering keeps
working exactly as it does today.

**Budget split.** `MAX_TASK_BUFFER_CHARS` (40k) is replaced by
`MAX_SEGMENT_BUFFER_CHARS` (120k), split ~60/40 between transcript and entries.

- **Transcript trims from the oldest end** — recency is what matters in chat.
- **Entries trim from the newest end**, keeping the earliest fullest, exactly as
  `enforceBufferCap` does today (`task-buffer.ts:165`).

The opposite directions are intentional and must be preserved: entry order
carries provenance, transcript order carries relevance.

**Prompts are carried outside the trimmed transcript, and that is load-bearing.**
Oldest-first trimming would otherwise drop the very prompt that defined the
topic, leaving the consolidator to infer the subject from the tail of the
conversation. `SegmentBuffer.prompts` holds every human prompt verbatim in the
envelope, so the topic survives any amount of transcript pressure. Pinned by
"captures the prior chat, and only the prior chat" in `group-runner.test.ts`.

## Timing guarantees

Two distinct moments, often conflated:

- **The boundary is sealed synchronously.** `assignTaskToSegment` closes the old
  segment inside the same `store.mutate` that writes the off-topic prompt, so by
  the time `startGroupTask` returns, the prior chat is durably bounded at a
  fixed `endSeq`. No crash window.
- **Extraction is asynchronous.** `void consolidateSegment(...)` is
  fire-and-forget and involves a real model call, so memory files land seconds
  later. A slow extraction must never block the next task from starting.

Because `endSeq` is fixed at close time, the new task runs concurrently with the
old segment's consolidation without contaminating it: its messages carry higher
seqs and `messagesIn` filters them out.

## Consolidator

`ConsolidateInput.taskBuffer` becomes `segmentBuffer`. The prompt gains a
`Group chat transcript` block rendered above the existing `Node outputs` block,
with speaker labels resolved the way `group-prompt.ts:74` already resolves them.

The system prompt gains one instruction: the transcript is the conversation the
notes are about; `Node outputs` remain the citable provenance. `MAX_NOTES` rises
from 5 to 8, since a segment covers more ground than a single task.

## Provenance and resume

- `CandidateMemoryNote` keeps `groupTaskId`, populated with the segment's **last**
  task id so review, ledger, landing, and every existing query keep working
  unchanged. It gains `segmentId` alongside.
- `TopicSegment.flushedAt` becomes the authoritative once-only guard.
  `GroupTask.flushedAt` is retained and still stamped, but is now informational.
- `resetAutoNotes` keeps its `groupTaskId` parameter — the resume path only has a
  task id — and resolves the owning segment via
  `topicSegments.find(s => s.groupTaskIds.includes(groupTaskId))`. It then removes
  the auto-generated notes for that whole segment and reopens it (`status: "open"`,
  `flushedAt: null`, `endSeq: null`, `closeReason: null`) so the resumed task
  rejoins it and the eventual re-flush covers the full segment. Human-decided
  notes are kept, as today. If no segment owns the task (pre-migration data), it
  falls back to today's per-task behaviour.

## Migration

`topicSegments` defaults to `[]` for an existing store. On the first
`startGroupTask` after upgrade, a group with no open segment gets one created
with `startSeq` set to the group's current max `seq + 1`. Historical messages are
not retroactively segmented, and historical per-task notes are left alone.

## Implementation notes

Three things surfaced during the build that the design did not anticipate:

- **`consolidateSegment` must check `status === "closed"`, not just
  `flushedAt`.** A segment reopened by a resume is unflushed but still
  accumulating, and must not be extracted mid-flight.
- **`enforceBufferCap` reserved a magic 200 chars** for the entry skeleton in its
  truncation branch, which overflowed the cap whenever ids and role names ran
  long. It now measures the empty-output skeleton instead.
- **The buffer converges on its real serialized size** rather than predicting
  JSON framing overhead. Two budgets, nested arrays and per-entry truncation
  suffixes made an exact formula brittle; `SegmentBufferBuilder.build` now
  re-runs `enforceBufferCap` with a reduced budget until the measured size fits
  (bounded at 4 passes, settles in one or two).

## Testing

| File | Covers |
|---|---|
| `topic-drift.test.ts` (16 tests) | JS symmetric, bounded `[0,1]`, `js(p,p) === 0`; same-topic prompt pairs score below τ and cross-topic pairs above, using the `GROUP-CHAT-DESIGN.md` example as a fixture; minimum-evidence guard returns 0; empty input safe |
| `topic-segment.test.ts` (20 tests) | Segment lifecycle; one-open-per-group invariant; each close reason; idle sweep |
| `group-runner.test.ts` (extend) | Task attaches to open segment; high-drift prompt closes and opens a new one; pipeline invoked exactly once per closed segment; 409 path unaffected |
| `segment-buffer.test.ts` (9 tests) + `task-buffer.test.ts` | Multi-task entry union and ordering; transcript assembly over `[startSeq, endSeq]`; 60/40 budget split; opposite trim directions |
| `pipeline.test.ts` (extend) | `resetAutoNotes(segmentId)` reopens the segment and preserves human-decided notes |

## Out of scope

- Filtering `buildContextPacket` by segment. Injection currently spans the whole
  timeline; scoping it to the open segment is a natural follow-up, but it is a
  behaviour change to agent prompting and is deliberately not bundled here.
- Any embedding-based or LLM-judge detector.
- Retroactive segmentation of historical messages.
