# manifest_KL — Topic-Segment Memory Consolidation (Jensen–Shannon divergence)

**Branch:** `KL_Divergence`
**Single commit:** `d78b3a9` — *feat: consolidate memory per topic segment instead of per task*
**Base:** `abc5e0b` (local `main` at time of branching)
**Author:** Jehantoro
**Handoff date:** 2026-08-31
**Design spec (shipped with the branch):** `docs/superpowers/specs/2026-08-30-topic-segment-consolidation-design.md`

**Status:** Implemented, typechecked, fully tested. **Not yet merged.** `origin/main` has
advanced 9 commits past this branch's base; a trial merge was performed and is documented
in [§11 Integration Guide](#11-integration-guide--merging-into-main).

| Check | Result |
|---|---|
| `tsc --noEmit` (apps/server) | **clean** |
| `vitest run` (apps/server), this branch | **249 passed / 249**, 24 files |
| Same on base `main` | 199 passed, 21 files → **+50 tests, +3 test files** |
| Trial merge `KL_Divergence` ← `origin/main` | 2 conflicts, both trivial import blocks; after resolution **typecheck clean, 285/285 server tests pass** |
| Public HTTP API surface | **unchanged** — no new routes, no DTO changes |
| Frontend (`apps/web`) | **untouched** by this branch |

---

## 1. TL;DR for the integrator

Memory consolidation used to be keyed to a single `GroupTask`. This branch re-keys it to a
new persisted entity — a **`TopicSegment`**: a run of *consecutive* group tasks that stayed
on one subject. The chat accumulates while the subject holds; when the subject changes, the
whole segment (full chat transcript + every plan node's output across every task in it) is
extracted **once**.

Segment boundaries are detected with **Jensen–Shannon divergence** over unigram term
distributions of the *human prompts only*. JS is built out of KL — that is where the branch
name comes from — but raw KL is deliberately **not** used; see [§5](#5-the-detector--topic-driftts).

Three things an integrator must internalise before touching this code:

1. **`MemoryPipeline.runMemoryPipeline` changed signature.** It now takes a `segmentId`
   (one argument), not `(groupTaskId, sinkNodeIds)`. Any stub, fake, or caller must change.
2. **`GroupTask.flushedAt` changed meaning.** It now means *"this task was accounted for by
   segment bookkeeping"*, **not** *"its memory was extracted"*. The authoritative
   once-only extraction guard is now `TopicSegment.flushedAt`.
3. **`Database` gained `topicSegments: TopicSegment[]`.** It defaults to `[]` and old stores
   load fine — see [§9 Migration](#9-persistence--migration).

---

## 2. The problem this solves

The group chat timeline is **per group** and persists across tasks (`GroupMessage.groupId`,
ordered by `seq`). Memory consolidation was **per task**: `decideFlush` fired when one
`GroupTask` reached a terminal state, and everything downstream keyed off `groupTaskId`.

That mismatch produced two failures:

- **Over-splitting.** Four consecutive tasks on one subject produced four separate
  extractions, each seeing a quarter of the picture. Durable facts that only emerge *across*
  tasks were never captured at all.
- **Context bleed.** `buildContextPacket` injects every message since `lastSeenSeq` with no
  semantic filter, so a subject change still hands the new task's agents the entire prior
  transcript. *(This half is explicitly **out of scope** here — see [§12](#12-known-gaps-and-follow-ups).)*

---

## 3. Architecture

### 3.1 Module map

```
apps/server/src/
├── types.ts                      [MOD] + TopicSegment, + SegmentCloseReason,
│                                        + Database.topicSegments
├── store.ts                      [MOD] + topicSegments in emptyDatabase() and
│                                        the defensive array re-init on load
├── config.ts                     [MOD] + 4 env vars -> AppConfig.segmentPolicy
├── app.ts                        [MOD] + lazy idle sweep on 2 group read routes
├── agent-service.ts              [MOD] + sweepIdleSegments(groupId) passthrough
├── test-helpers.ts               [MOD]   RecordingMemoryPipeline now records segmentIds
├── integration-manifest-task1.ts [MOD] + "topicSegments" in the store-keys contract
└── memory/
    ├── topic-drift.ts            [NEW] 170 LOC — the JS/KL scorer. PURE.
    ├── topic-segment.ts          [NEW] 242 LOC — segment lifecycle rules. PURE.
    ├── group-runner.ts           [MOD] +221 — owns segment assignment, close,
    │                                     consolidate, idle sweep
    ├── task-buffer.ts            [MOD]   TaskBufferBuilder -> SegmentBufferBuilder
    ├── pipeline.ts               [MOD]   keyed on segmentId; resetAutoNotes reopens
    ├── consolidator.ts           [MOD]   takes SegmentBuffer; prompt gains transcript
    ├── flush-trigger.ts          [MOD] + ignoreFlushMark; - FlushDecision.sinkNodeIds
    └── types.ts                  [MOD]   TaskBuffer -> SegmentBuffer;
                                          + SegmentTranscriptLine;
                                          CandidateMemoryNote gains segmentId
```

`topic-drift.ts` and `topic-segment.ts` are **pure**: no store access, no I/O, no clock.
Callers pass rows and timestamps in. That is what lets the entire boundary decision run
*inside* the caller's existing `store.mutate` transaction, and what makes the threshold
tunable against recorded transcripts without a database.

### 3.2 Layering

```
                         ┌─────────────────────────────────────────┐
   HTTP (app.ts)  ──────▶│ AgentService.sweepIdleSegments()        │  fire-and-forget
                         └────────────────┬────────────────────────┘
                                          ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ GroupRunner                          (owns lifecycle + the store)        │
   │   startGroupTask ──▶ assignTaskToSegment ──┐                             │
   │   finalize ──▶ maybeFlush ─────────────────┼──▶ consolidateSegment(id)   │
   │   sweepIdleSegments ───────────────────────┘            │                │
   └─────────────────────────────────────────────────────────┼────────────────┘
                                                             ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ pure decision layer     topic-segment.ts  ──uses──▶  topic-drift.ts       │
   │   decideSegmentBoundary / findOpenSegment / findIdleSegment /             │
   │   closeSegmentInPlace / messagesIn / tasksIn / humanPromptsIn             │
   │                                          scoreDrift / jsDivergence /      │
   │                                          termDistribution                 │
   └──────────────────────────────────────────────────────────────────────────┘
                                                             │
                                                             ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ RealMemoryPipeline.runMemoryPipeline(segmentId)                           │
   │   SegmentBufferBuilder.build({segmentId})  ──▶ SegmentBuffer              │
   │   Consolidator.consolidate({segmentBuffer,…}) ──▶ CandidateMemoryNote[]   │
   │   evaluateNoteSafety ──▶ ReviewService.processCandidate ──▶ Landing/Ledger│
   └──────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Data model

New persisted type, `apps/server/src/types.ts`:

```ts
/** Why a topic segment stopped accumulating. */
export type SegmentCloseReason = "topic_shift" | "size_cap" | "idle";

export interface TopicSegment {
  id: string;
  groupId: string;
  status: "open" | "closed";
  /** First groupMessage.seq belonging to this segment. */
  startSeq: number;
  /** Last groupMessage.seq, set on close. */
  endSeq: number | null;
  groupTaskIds: string[];
  closeReason: SegmentCloseReason | null;
  /** The JS score that closed it. Null unless closeReason is "topic_shift". */
  driftScore: number | null;
  flushedAt: string | null;
  createdAt: string;
  closedAt: string | null;
}
```

Added to `Database` as `topicSegments: TopicSegment[]`.

**Invariant: at most one segment with `status: "open"` per `groupId`.** It is enforced
inside the single `store.mutate` that creates a task, and asserted directly in
`topic-segment.test.ts` and `group-runner.test.ts`.

A segment is bounded two ways at once, and both are load-bearing:

- by **`groupTaskIds`** — which tasks' plan nodes contribute `entries` (provenance);
- by **`[startSeq, endSeq]`** — which chat messages contribute `transcript` (relevance).

---

## 4. Full runtime flow

### 4.1 Happy path — a new prompt arrives

```
POST /api/groups/:id/tasks   →   GroupRunner.startGroupTask(groupId, prompt)
  │
  ├─ 409 if group.activeTaskId is set   ◀── this is the concurrency guarantee below
  │
  └─ store.mutate(db => {                      ── ONE transaction ──
       seq = nextSeq(db, groupId)
       db.groupMessages.push({ speakerType:"human", seq, content: prompt, … })

       closedSegmentId = assignTaskToSegment(db, groupId, taskId, prompt, seq, ts)
         │
         ├─ open = findOpenSegment(db.topicSegments, groupId)
         │
         ├─ if (!open)                 → createSegment(groupId, seq, ts)
         │                               attach task; NO SCORING (nothing to compare to)
         │                               return null
         │
         └─ else decideSegmentBoundary({
              segment: open,
              segmentPrompts: humanPromptsIn(open, db.groupTasks),   // HUMAN ONLY
              segmentChars:   transcriptCharsIn(open, db.groupMessages),
              incomingPrompt: prompt,
              policy: config.segmentPolicy })
              │
              ├─ caps first (cheap, unconditional):
              │     groupTaskIds.length >= maxTasks || segmentChars >= maxChars
              │       → { close, reason:"size_cap", driftScore:null }
              │
              ├─ drift = scoreDrift(segmentPrompts, incomingPrompt)
              │     drift > driftThreshold
              │       → { close, reason:"topic_shift", driftScore:drift }
              │
              └─ else { continue } → open.groupTaskIds.push(taskId); return null
              │
              on close: closeSegmentInPlace(open, { reason, driftScore, endSeq: seq-1, at })
                        next = createSegment(groupId, seq, ts); attach task
                        return open.id

       group.activeTaskId = taskId
     })                                        ── transaction commits ──
  │
  ├─ if (closedSegmentId) void consolidateSegment(closedSegmentId)   ← fire-and-forget
  └─ void executeGroupTask(taskId)                                   ← the new task runs
```

### 4.2 The two timing guarantees (do not conflate them)

- **The boundary is sealed synchronously.** `assignTaskToSegment` closes the old segment
  *inside the same `store.mutate`* that writes the off-topic prompt. By the time
  `startGroupTask` returns, the prior chat is durably bounded at a fixed `endSeq`. There is
  no crash window in which a topic boundary can be lost.
- **Extraction is asynchronous and fails open.** `void consolidateSegment(...)` involves a
  real model call, so notes land seconds later. A slow extractor must never block the next
  task from starting.

Because `endSeq` is frozen at close time, the *new* task can run concurrently with the old
segment's consolidation without contaminating it: the new task's messages carry higher
`seq`s and `messagesIn` filters them out. This is pinned by the group-runner test
*"captures the prior chat, and only the prior chat"*.

### 4.3 Why no lock is needed

`startGroupTask` returns **409** when the group already has a running task. A new human
prompt can therefore only arrive when the group is idle — which means **every task in the
closing segment is already terminal**. There is nothing to wait for.

`consolidateSegment` nonetheless *verifies* rather than assumes: it re-runs `decideFlush`
over every task in the segment with `ignoreFlushMark: true`. If any task is somehow
unsettled, the segment stays **closed but unflushed** and is retried at the next close
attempt.

### 4.4 The four ways a segment closes

| # | Trigger | Where | `closeReason` | `endSeq` | Consolidation |
|---|---|---|---|---|---|
| 1 | Incoming prompt diverges (`JS > τ`) | `assignTaskToSegment`, inside `startGroupTask`'s mutate | `topic_shift` | `seq - 1` (just before the new prompt) | `void` — not awaited |
| 2 | Cap hit **when the next prompt arrives** | same as #1 | `size_cap` | `seq - 1` | `void` — not awaited |
| 3 | Cap hit **when a task settles** | `maybeFlush`, called from `finalize` | `size_cap` | current max `seq` in the group | **`await`ed** inside `maybeFlush` |
| 4 | Group has gone quiet past `idleMs` | `sweepIdleSegments`, called from group read routes | `idle` | current max `seq` in the group | `await`ed inside the sweep, but the sweep itself is `void`ed by the caller |

Path #3 exists so a *long-running single subject* still consolidates without waiting for a
prompt that may never come. Path #4 exists so a user's **last** segment is not stranded
forever.

> Path #3 is the one asymmetry in the design: it awaits the extractor on the task-settle
> path. `finalize` clears `group.activeTaskId` *before* calling `maybeFlush` and is itself
> `void`ed by `executeGroupTask`, so no HTTP response and no subsequent task is blocked —
> but be aware of it if you ever move `maybeFlush` onto a request path.

### 4.5 Idle sweep

`sweepIdleSegments(groupId)` is called lazily from group read paths — no timer, no
background loop, nothing to start, stop, or stub in tests:

```ts
// app.ts
app.get("/api/groups/:id",       …) { service.sweepIdleSegments(id);  … }
app.get("/api/groups/:id/tasks", …) { service.sweepIdleSegments(id);  … }
```

It is **deliberately not awaited** — reads must never block on memory. Consequences the UI
owner should know:

- The sweep's effects (a closed segment, new notes) become visible on the **next** poll,
  not the response that triggered it.
- `findIdleSegment` ages on the **newest** message in the segment — a segment is idle when
  nothing has happened recently, not when it happens to contain something old.
- The sweep **refuses to run while `group.activeTaskId` is set**, so it can never close a
  segment out from under a running task.
- **Accepted limitation:** a group nobody ever revisits stays unconsolidated indefinitely.
  This was chosen over a background sweep timer, whose lifecycle cost was judged higher.

### 4.6 Resume path

`RealMemoryPipeline.resetAutoNotes(groupTaskId)` still takes a **task** id (the resume path
only has one), but now:

1. resolves the owning segment via `topicSegments.find(s => s.groupTaskIds.includes(id))`;
2. deletes the **auto-generated** notes for that *whole segment* (human-decided notes — a
   review decision was recorded — are preserved, exactly as before), plus their grants and
   landed files;
3. **reopens** the segment: `status:"open"`, `endSeq:null`, `closeReason:null`,
   `driftScore:null`, `closedAt:null`, `flushedAt:null` — *always*, even when there was
   nothing to clean up, so the segment can consolidate again after the resume.

If no segment owns the task (pre-migration data), it falls back to today's per-task
behaviour.

This is why `consolidateSegment` checks `status === "closed"` and **not just** `flushedAt`:
a segment reopened by a resume is unflushed but still accumulating, and must not be
extracted mid-flight.

---

## 5. The detector — `topic-drift.ts`

### 5.1 Why Jensen–Shannon and not raw KL

JS *is* KL — it is `0.5·KL(P‖M) + 0.5·KL(Q‖M)` over the midpoint `M = (P+Q)/2`. Running KL
against the midpoint rather than against `Q` directly buys two properties that matter at
chat-message scale:

1. **No infinities, therefore no smoothing constant.** `KL(P‖Q)` is infinite for any term
   the new prompt has and the segment lacks — which at this length is *most* terms.
   Avoiding that requires additive smoothing, and on texts this short the resulting score
   tracks the smoothing constant more than it tracks the topic. `M` has mass wherever
   either side does, so every term is finite by construction.
2. **Symmetry and a bound.** Raw KL is order-dependent and unbounded. JS is neither: with
   log base 2 it lands in `[0, 1]`. **That bound is the only reason a fixed threshold means
   anything.**

`jsDivergence` computes over the union vocabulary, takes `0·log0` as `0`, applies **no
smoothing**, and clamps to `[0, 1]` because floating-point error can push a fully disjoint
pair a hair past 1.

### 5.2 What is compared — and why agent messages are excluded

This is the core of the design, not an optimisation.

In a role-based group chat, vocabulary tracks the **speaker's specialty** far more strongly
than the subject. On the worked example in `middlewaredoc/GROUP-CHAT-DESIGN.md`, the Backend
turn (*"define POST /uploads and the storage flow"*) and the Security turn (*"review
validation, auth, and secret boundaries"*) share **zero** content words while discussing one
topic — whereas a genuine change to *"add rate limiting to the auth endpoints"* shares more.
A scorer fed agent turns therefore ranks the same-topic handoff as **more** divergent than
the real boundary.

`scoreDrift` is fed **human prompts only**, so both sides of the comparison come from one
speaker and specialty vocabulary cannot rotate underneath the score. This removes the
confound rather than tuning around it. `topic-drift.test.ts` pins **both halves** of that
claim — including the inversion that would occur if agent turns were included.

Each group task carries exactly one human prompt, so the `GroupTask` rows *are* the human
side of the conversation — `humanPromptsIn` reads them directly and never has to filter the
message timeline by speaker.

> Agent messages still enter the consolidator **buffer** in full. The restriction is on
> *scoring*, not on what gets remembered.

### 5.3 Pipeline

```
text → lowercase
     → replace /[^a-z0-9]+/g with space, split
     → drop tokens shorter than 3 chars
     → drop stopwords (small inline English list; no new dependency)
     → stem: strip first matching suffix from
             ["ation","tion","ing","ies","es","ed","s","e"]   (longest-first,
             never below MIN_STEM_LENGTH = 3)
     → count → normalise to a probability distribution (Map<string, number>)
```

Longest-first ordering is why `uploading → upload` rather than `uploadin`. The stemmer is
crude on purpose: its only job is to stop `upload`/`uploads`/`uploading` being counted as
three unrelated terms and inflating the divergence.

**Exported surface (all pure, all unit-tested):**

```ts
export const MIN_EVIDENCE_TERMS = 8;
export function termDistribution(text: string): Map<string, number>;
export function jsDivergence(p: Map<string, number>, q: Map<string, number>): number;
export function scoreDrift(segmentPrompts: readonly string[], incoming: string): number;
```

**Minimum-evidence guard.** If the pooled segment distribution has fewer than
`MIN_EVIDENCE_TERMS` (8) distinct content terms, `scoreDrift` returns `0` — "no drift". Two
short prompts share almost no vocabulary whatever their subject, so scoring them yields
noise. Returning 0 keeps the segment accumulating until there is enough text to judge.
`scoreDrift` also returns `0` when the incoming prompt has no content terms. **Failing
toward "same topic" is the recoverable direction.**

### 5.4 Calibration — the threshold is measured, not guessed

Measured against the worked prompts in `middlewaredoc/GROUP-CHAT-DESIGN.md`; fixtures live
in `topic-drift.test.ts`:

| Prompt relationship | Measured JS |
|---|---|
| Same-subject follow-ups | **0.55 – 0.83** |
| Hard subject changes (no shared vocabulary) | **1.00** |
| **Default threshold `τ`** | **0.90** |

An earlier draft used `τ = 0.82`. That sat **below** a legitimate same-subject follow-up —
*"review the upload validation and auth boundaries"* scored **0.832** — and would have split
it. `0.90` sits inside the measured gap.

### 5.5 Known limitation — stated plainly

**This detector resolves *hard* subject changes, not *soft* ones.** A shift that still
shares a word or two with the segment scores around **0.74–0.78**, which overlaps the range
genuine same-subject follow-ups occupy while a segment is short. Those go **uncaught** until
`maxTasks` or `maxChars` closes the segment.

That is a deliberate trade, based on failure asymmetry:

- A **false split** costs one topic torn in half — expensive, and invisible until someone
  reads the memory.
- A **missed split** costs one oversized consolidation — cheap, and self-limiting because
  the size caps bound it.

Raising sensitivity to catch soft shifts would start splitting genuine follow-ups.

**Floor guarantee:** the degenerate behaviour of an over-eager detector is *one segment per
task*, which is exactly the pre-branch behaviour. **This feature cannot perform worse than
the status quo.**

---

## 6. Buffer — `TaskBuffer` → `SegmentBuffer`

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
  /** Every task prompt in the segment, in task order. Survives transcript trimming. */
  prompts: string[];
  groupTaskIds: string[];
  /** The full group chat over [startSeq, endSeq], oldest first. */
  transcript: SegmentTranscriptLine[];
  /** Every node across the segment's tasks, in execution order. */
  entries: TaskBufferEntry[];
}
```

`TaskBufferEntry` is **unchanged**, so the `sourceRunIndices` / `sourceSpanIndices`
provenance-index scheme from Manifest 3 keeps working exactly as before.

**Removed as dead weight:** `TaskBuffer.orderedNodeIds` (it is exactly
`entries.map(e => e.planNodeId)`), `TaskBuffer.status` (nothing read it), and
`FlushDecision.sinkNodeIds` (the pipeline stopped taking it when consolidation moved to
segments).

### 6.1 Ordering

`entries` is the union across every task in the segment, ordered by **task attachment
order**, then by the existing `topologicalSort` **within** each task. A segment's tasks are
sequential by construction (the group rejects a new task while one runs), so there is no
cross-task DAG to sort.

### 6.2 Budget — 120k chars, split ~60/40, trimmed in opposite directions

`MAX_TASK_BUFFER_CHARS` (40k) → **`MAX_SEGMENT_BUFFER_CHARS` (120k)**, with
`TRANSCRIPT_BUDGET_SHARE = 0.6`.

- **Transcript trims from the OLDEST end** (`trimTranscript`) — in a chat, recency is what
  matters, so an over-long segment should lose its beginning.
- **Entries trim from the NEWEST end** (`enforceBufferCap`), keeping the earliest fullest,
  exactly as before — because entry order carries **provenance** and a cited run index must
  still resolve.

**The opposite directions are intentional and must be preserved.**

The envelope (ids, prompts, task ids) is measured exactly and subtracted *first*, then what
remains is split. Unspent transcript budget is handed to entries rather than wasted, so a
short chat does not starve provenance it has room for.

**Prompts are carried outside the trimmed transcript, and that is load-bearing.**
Oldest-first trimming would otherwise drop the very prompt that defined the topic, leaving
the consolidator to infer the subject from the tail of the conversation.
`SegmentBuffer.prompts` holds every human prompt verbatim in the envelope, so the topic
survives any amount of transcript pressure.

### 6.3 Two implementation details worth not re-breaking

- **`enforceBufferCap` no longer reserves a magic 200 chars** for the entry skeleton in its
  truncation branch. It now measures the empty-output skeleton — the fixed guess overflowed
  the cap whenever ids and role names ran long, which is precisely when the budget is
  already tight.
- **`SegmentBufferBuilder.build` converges on the real serialized size** instead of
  predicting JSON framing overhead. Two budgets, nested arrays, and per-entry truncation
  suffixes made an exact formula brittle. It re-runs `enforceBufferCap` with a reduced
  budget until the measured size fits — bounded at 4 passes, settles in one or two.
  `enforceBufferCap` shrinks monotonically with its budget, so the loop bound is a guard,
  not the mechanism.

---

## 7. Consolidator changes

- `ConsolidateInput.taskBuffer` → **`ConsolidateInput.segmentBuffer`**.
- `MAX_NOTES` raised **5 → 8** (a segment covers more ground than a single task). The system
  prompt's *"Return at most 5 notes"* line was updated in lockstep — **keep these two in
  sync.**
- The extractor prompt was restructured:

```
# Topic
These requests were all part of one continuous topic:
1. <prompt 1>
2. <prompt 2>
…

## Agents you may target
- <uuid>  (<name>)

## Group chat transcript
The conversation to extract from. Not citable as provenance.
User: …
Agent <id>: …

## Node outputs
Cite provenance from here, by the run and span numbers shown.
…
```

The headings explicitly say which block is citable, so the model does not try to cite a chat
line as a run index. Speaker labels are resolved the way `group-prompt.ts` already resolves
them.

- `CandidateMemoryNote` gains **`segmentId`** (the real owner) and **keeps `groupTaskId`**,
  populated with the segment's **last** task id, so review, ledger, landing, and every
  existing per-task query keep resolving unchanged. See [§12](#12-known-gaps-and-follow-ups)
  for the one place this leaks.

---

## 8. Configuration

Four new env vars, validated by the existing zod schema in `config.ts`, surfaced as
`AppConfig.segmentPolicy` (shape: `SegmentPolicy` from `topic-segment.ts`):

| Env var | Zod constraint | Default | Meaning |
|---|---|---|---|
| `MEMORY_TOPIC_DRIFT_THRESHOLD` | `number`, `[0, 1]` | `0.90` | JS strictly above this opens a new segment |
| `MEMORY_SEGMENT_MAX_TASKS` | `int`, `>= 1` | `8` | Hard task cap; closes with `size_cap` |
| `MEMORY_SEGMENT_MAX_CHARS` | `int`, `>= 1000` | `120000` | Transcript char cap; closes with `size_cap` |
| `MEMORY_SEGMENT_IDLE_MS` | `int`, `>= 1000` | `1800000` | Idle close window (30 min) |

```ts
// config.ts — the shape handed to GroupRunner
segmentPolicy: {
  driftThreshold: env.MEMORY_TOPIC_DRIFT_THRESHOLD,
  maxTasks:       env.MEMORY_SEGMENT_MAX_TASKS,
  maxChars:       env.MEMORY_SEGMENT_MAX_CHARS,
  idleMs:         env.MEMORY_SEGMENT_IDLE_MS,
}
```

> ⚠️ **These four vars were NOT added to `.env.example`.** All four have working defaults, so
> nothing breaks — but the file is the project's documented config surface and is now
> incomplete. See [§12, item 1](#12-known-gaps-and-follow-ups). `DEFAULT_SEGMENT_POLICY` in
> `topic-segment.ts` carries the same defaults for pure-function callers and tests.

**Tuning guidance for whoever operates this:**

- Lower `driftThreshold` → more splits, smaller consolidations, higher risk of tearing a
  topic in half. Do not go below ~0.84 without re-running the `topic-drift.test.ts`
  fixtures; **0.832 is a measured same-topic follow-up.**
- `maxTasks` / `maxChars` are the safety net that catches the soft shifts the detector
  misses. Do not disable them.

---

## 9. Persistence & migration

- **Store:** `topicSegments: []` added to `emptyDatabase()` and to the defensive
  `if (!Array.isArray(parsed.X)) parsed.X = []` re-init on load. **An existing `db.json`
  loads without any migration step.**
- **First run after upgrade:** a group with no open segment gets one created on its next
  `startGroupTask`, with `startSeq` = that prompt's `seq` (i.e. the group's current max
  `seq + 1`), and **no scoring** — there is nothing to compare against.
- **Historical data is left alone.** Messages are not retroactively segmented; historical
  per-task notes are not touched or re-keyed.
- **`integration-manifest-task1.ts`** — the store-keys contract — gained `"topicSegments"`
  in the correct position. If another workstream asserts against that list, it must pick up
  this change.
- No note or grant row was reshaped, so nothing on disk under the governed-memory tree
  changes format.

---

## 10. Verification evidence

All commands run on branch `KL_Divergence` at `d78b3a9`.

```
$ npx tsc -p apps/server/tsconfig.json --noEmit
(no output — clean)

$ cd apps/server && npx vitest run
 Test Files  24 passed (24)
      Tests  249 passed (249)
```

Baseline, same commands at merge-base `main` (`abc5e0b`): **199 tests, 21 files** — so this
branch adds **50 tests and 3 test files**, and breaks none.

| Test file | Count | Covers |
|---|---:|---|
| `memory/topic-drift.test.ts` **(new)** | 15 | JS symmetric, bounded `[0,1]`, `js(p,p)===0`; same-topic pairs below τ and cross-topic pairs above, using the `GROUP-CHAT-DESIGN.md` example as fixture; **the agent-turn inversion**; min-evidence guard returns 0; empty input safe |
| `memory/topic-segment.test.ts` **(new)** | 20 | Segment lifecycle; one-open-per-group invariant; each close reason; idle-sweep aging |
| `memory/segment-buffer.test.ts` **(new)** | 9 | Multi-task entry union and ordering; transcript assembly over `[startSeq, endSeq]`; 60/40 budget split; the opposite trim directions |
| `memory/group-runner.test.ts` (extended) | 30 | Task attaches to open segment; high-drift prompt closes and opens a new one; pipeline invoked exactly once per closed segment; *"captures the prior chat, and only the prior chat"*; idle sweep closes a quiet segment and leaves an active one alone; a throwing pipeline never fails a completed task; 409 path unaffected |
| `pipeline.test.ts`, `consolidator.test.ts`, `task-buffer.test.ts`, `flush-trigger.test.ts` | updated | Re-keyed to `segmentId`; `resetAutoNotes` reopens the segment and preserves human-decided notes; `ignoreFlushMark` semantics |

**Note for anyone reading `group-runner.test.ts`:** the harness sets
`MEMORY_SEGMENT_MAX_CHARS: "100000000"`. That is not a hack around the cap — `FakeRunner`
echoes the injected transcript back as its output, so message content compounds run over run
and a few nodes blow the real 120k cap on their own. Raising it there lets the segment tests
exercise *topic drift*; the cap itself is covered by `topic-segment.test.ts`.

---

## 11. Integration guide — merging into `main`

### 11.1 Situation

`KL_Divergence` is **1 commit ahead** of the local `main` it branched from, but `origin/main`
has since advanced **9 commits** — including work that touches the same files:

```
4519b08 feat(planner): plan against the group's description, not only the task
c2c622e feat(runner): run independent DAG branches in parallel
8d6b37d feat(runner): retry transient node failures, one run row per attempt
2b27ad8 feat(web): render the plan as a graph, not a numbered list
2dca2eb test(runner): prove a blocked branch re-runs on resume
21e0ec3 feat: make seeded and offline runs honest about the planner
7a1001b fix(runner): contain a node failure to its own branch
c83b5ee Merge pull request #3 from rjustyn1/feat/ui-revamp
b148651 feat(web): command-center Teams UI revamp
```

Overlapping files: `memory/group-runner.ts`, `memory/flush-trigger.ts`, `config.ts`,
`types.ts`, and several test files.

### 11.2 Trial merge result — already performed and verified

A trial merge of `origin/main` into `KL_Divergence` was run in a throwaway worktree. Result:

- **Auto-merged cleanly:** `config.ts`, `types.ts`, `flush-trigger.ts`,
  `flush-trigger.test.ts`, `pipeline.test.ts`, `task-buffer.test.ts`.
- **2 conflicts, both trivial and additive** (details below).
- After resolving them: **`tsc --noEmit` clean, 285/285 server tests pass.**

> The only failure observed in the trial worktree was
> `app.groups.test.ts > still serves the SPA…`, which asserts `GET /` returns the built SPA.
> It fails because the throwaway worktree had no `apps/web/dist`. It **fails identically on
> `origin/main` alone**, so it is a worktree artifact, not a merge defect. Run
> `npm run build -w @launchpad/web` before the suite and it passes.

### 11.3 The two conflicts and their exact resolutions

**Conflict 1 — `apps/server/src/memory/group-runner.ts`, import block (~line 40).**
`origin/main` added `findFailedAncestor` to the `flush-trigger` import; this branch added the
`topic-segment` import block next to it. **Keep both:**

```ts
import { decideFlush, findFailedAncestor } from "./flush-trigger.js";
import {
  closeSegmentInPlace,
  createSegment,
  decideSegmentBoundary,
  findIdleSegment,
  findOpenSegment,
  humanPromptsIn,
  transcriptCharsIn,
} from "./topic-segment.js";
```

**Conflict 2 — `apps/server/src/memory/group-runner.test.ts`, harness `loadConfig({...})` (~line 68).**
`origin/main` added a conditional `GROUP_MAX_PARALLEL_NODES` key; this branch added
`MEMORY_SEGMENT_MAX_CHARS`. **Keep both:**

```ts
    MEMORY_SEGMENT_MAX_CHARS: "100000000",
    ...(extra.maxParallel === undefined
      ? {}
      : { GROUP_MAX_PARALLEL_NODES: String(extra.maxParallel) }),
```

Nothing else requires manual intervention.

### 11.4 Semantic compatibility with `origin/main`'s runner work — verified

`origin/main` reworked `group-runner.ts` heavily (parallel DAG branches, per-attempt retry
rows, `findFailedAncestor`). After the merge I confirmed **all segment hooks survive intact
and in the right places**:

| Hook | Present after merge |
|---|---|
| `assignTaskToSegment` called inside `startGroupTask`'s mutate | ✅ |
| `void consolidateSegment(closedSegmentId)` after commit | ✅ |
| `decideFlush({ …, ignoreFlushMark: true })` in `consolidateSegment` | ✅ |
| size-cap close + `await consolidateSegment` in `maybeFlush` | ✅ |
| `sweepIdleSegments` + `await consolidateSegment` | ✅ |
| `flush-trigger.ts` keeps `ignoreFlushMark` alongside `findFailedAncestor` | ✅ |
| `config.ts` carries both `segmentPolicy` and `groupMaxParallelNodes` | ✅ |

Parallel node execution is **orthogonal** to segmentation: segments are keyed on *tasks* and
message `seq`s, and `SegmentBufferBuilder` sorts nodes topologically *within* each task, so
wider execution changes nothing about ordering or boundaries.

### 11.5 Recommended merge procedure

```bash
git fetch origin
git checkout KL_Divergence
git merge origin/main            # expect the 2 conflicts in §11.3
# resolve both by keeping BOTH sides, as shown above
git add apps/server/src/memory/group-runner.ts \
        apps/server/src/memory/group-runner.test.ts
git commit

npm run build -w @launchpad/web  # required, or the SPA test fails on a missing dist
npm run typecheck                # expect clean
npm run test                     # expect server 285/285 + the web suite
```

Then open the PR into `main`. Do **not** squash the design rationale out of the commit
message — the calibration numbers in it are the record of why `τ = 0.90`.

### 11.6 Breaking-change checklist for other workstreams

| If your code… | You must… |
|---|---|
| implements or stubs `MemoryPipeline` | change `runMemoryPipeline(groupTaskId, sinkNodeIds)` → `runMemoryPipeline(segmentId)` |
| reads `FlushDecision.sinkNodeIds` | it is **removed**; the pipeline no longer takes it |
| treats `GroupTask.flushedAt` as *"memory was extracted"* | it now means *"accounted for by segment bookkeeping"*; use `TopicSegment.flushedAt` |
| imports `TaskBuffer` / `TaskBufferBuilder` / `MAX_TASK_BUFFER_CHARS` | → `SegmentBuffer` / `SegmentBufferBuilder` / `MAX_SEGMENT_BUFFER_CHARS` |
| constructs a `Database` literal | add `topicSegments: []` |
| asserts on `integrationManifestTask1.storeKeys` | expects `"topicSegments"` after `"groupMessages"` |
| calls `Consolidator.consolidate` | `taskBuffer:` → `segmentBuffer:` |

Verified: **no other file in `apps/server/src` or `apps/web/src` still references the old
names.** The HTTP API and all frontend DTOs are unchanged.

---

## 12. Known gaps and follow-ups

Ordered by how much they should worry you. None of these are regressions; items 1–3 are new
surface this branch introduced, 4–6 are documented design boundaries.

1. **`.env.example` is missing the four new vars.** *(small — do it at merge time)*
   All four have defaults so nothing breaks, but the documented config surface is now
   incomplete. Add, next to the existing `MEMORY_*` block:
   ```
   MEMORY_TOPIC_DRIFT_THRESHOLD=0.90
   MEMORY_SEGMENT_MAX_TASKS=8
   MEMORY_SEGMENT_MAX_CHARS=120000
   MEMORY_SEGMENT_IDLE_MS=1800000
   ```

2. **`segmentId` is produced but not persisted.** `CandidateMemoryNote.segmentId` is set by
   the consolidator, but `MemoryNote` (the persisted row in `types.ts`) has no `segmentId`
   field, so `ReviewService.processCandidate` drops it when promoting the candidate. Notes
   are therefore still only queryable by `groupTaskId` (the segment's *last* task).
   Consequence: you cannot currently ask *"which notes came from this segment?"* Adding
   `segmentId?: string` to `MemoryNote` and copying it through in `review.ts` is a small,
   additive change — deliberately not bundled here to keep Person 4's DTOs untouched.

3. **"Withheld" ledger rows are scoped to the last task only.** `ReviewService.activate`
   computes withheld-audit rows from `taskParticipants(note.groupTaskId)` — the plan nodes
   of the segment's **last** task. An agent that participated in an *earlier* task of the
   segment and was not targeted gets no `not_targeted` audit row.
   **Grants themselves are correct** — `targetAgentIds` is validated in the pipeline against
   members computed across *every* task in the segment. This affects audit completeness, not
   routing or safety.

4. **`buildContextPacket` is still unsegmented — explicitly out of scope.** The "context
   bleed" half of the original problem ([§2](#2-the-problem-this-solves)) is untouched:
   injection still spans the whole timeline since `lastSeenSeq`. Scoping it to the open
   segment is the natural follow-up, but it changes agent *prompting* behaviour and was
   deliberately not bundled with a memory change.

5. **Soft topic shifts are not detected.** See [§5.5](#55-known-limitation--stated-plainly).
   They are caught by `maxTasks` / `maxChars`, not by the scorer.

6. **A group nobody revisits is never consolidated.** The idle close is a lazy check on
   group reads, not a background sweep. See [§4.5](#45-idle-sweep).

**Explicitly rejected — do not "fix" without a discussion:** embedding-based or LLM-judge
boundary detection (cost + latency on the hot path), and retroactive segmentation of
historical messages.

---

## 13. Rollback / kill switch

There is no dedicated feature flag, but three levers exist, from softest to hardest:

1. **`MEMORY_TOPIC_DRIFT_THRESHOLD=0` + `MEMORY_SEGMENT_MAX_TASKS=1`** — every task becomes
   its own segment. This reproduces the **pre-branch per-task consolidation behaviour**
   exactly, with the new code paths still running.
2. **`MEMORY_ENABLED=false` / `MEMORY_EXTRACTOR=off`** — the pre-existing switches. Segments
   still open and close (cheap, pure, in-transaction); nothing is extracted.
3. **`git revert d78b3a9`** — clean, since the branch is a single commit. Leftover
   `topicSegments` rows in `db.json` become inert; the reverted `store.ts` ignores the key
   and `JSON.parse` keeps it harmlessly.

Runtime risk is low by construction: every consolidation path is wrapped in try/catch,
logs (outside `NODE_ENV=test`), and **fails open** — a failing extractor never fails a
completed group task. `group-runner.test.ts` pins this with an intentionally throwing
pipeline.

---

## 14. Suggested reading order for the reviewer

1. `docs/superpowers/specs/2026-08-30-topic-segment-consolidation-design.md` — the design,
   with post-implementation deviations marked **[revised]**.
2. `apps/server/src/memory/topic-drift.ts` — 170 LOC, pure, and the module comment carries
   the full JS-vs-KL argument.
3. `apps/server/src/memory/topic-segment.ts` — the lifecycle rules and the calibrated
   `DEFAULT_SEGMENT_POLICY`.
4. `apps/server/src/memory/group-runner.ts` → `assignTaskToSegment`, `consolidateSegment`,
   `maybeFlush`, `sweepIdleSegments` — where purity meets the store.
5. `apps/server/src/memory/task-buffer.ts` → `SegmentBufferBuilder.build` — the budget split
   and the convergence loop.
6. `apps/server/src/memory/topic-drift.test.ts` — the calibration fixtures. **Read this
   before changing the threshold.**

---

*Prepared as an implementation handoff. It does not replace `TODO.md`, `middlewaredoc/PLAN.md`,
`middlewaredoc/SPEC.md`, or the design spec in `docs/superpowers/specs/`.*
