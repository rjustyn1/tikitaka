# Milestone — DAG Execution

> **The one question this answers: what does the DAG actually do now when
> something goes wrong, and how much of it is real.**
> Design context: [`ARCHITECTURE.md`](./ARCHITECTURE.md) §9, and
> [`components/PLANNER.md`](./components/PLANNER.md) for the planner contract.
> This file adds no design. It tracks execution only.

**Workstream:** DAG failure handling, retries, and parallel execution.
**Baseline:** the two problems raised on 2026-08-30 — *what happens when a node
fails*, and *when to hand a task to the notetaker*. **Only the first is done.**

---

## Scope boundary

In scope:

```text
apps/server/src/memory/group-runner.ts     the executor
apps/server/src/memory/flush-trigger.ts    the shared "is this node blocked" rule
apps/server/src/memory/planner.ts          join marking, group-description input
apps/server/src/types.ts                   GroupPlanNode.attempts
apps/server/src/config.ts                  GROUP_MAX_PARALLEL_NODES
apps/web/src/group/                        rendering the graph and its failures
scripts/seed-demo.mjs                      seeded data that matches the planner
```

Explicitly **not** in this milestone:

```text
Problem 2 — when to consolidate (the watermark)     NOT STARTED
plan preview / dry-run endpoint                     declined: "no approval needed"
plannerSource persisted for the UI                  declined
```

---

## Pre-flight findings

Recorded before writing code, so later readers know what was true at the start.

- [x] `executeGroupTask()` was a linear `for` loop that `break`s on any failure.
      Correct while every node depended on the previous one; wrong the moment
      the planner could emit fan-out.
- [x] The rule for "can this node still run" already existed —
      `flush-trigger.ts`'s `isUnreachable()` — and the executor did not use it.
- [x] `chainFor()` sorted by `createdAt`, but `buildPlanNodes()` stamps every
      node of a task with the SAME timestamp. Execution order survived only on
      V8's stable sort. Correct by accident.
- [x] No retries anywhere, despite a comment in `runPlanNode()`'s catch saying
      the thread id is preserved "so a retry resumes rather than restarts".
- [x] `GroupPlanNodeKind = "work" | "join"` existed and nothing ever set
      `"join"`.
- [x] `scripts/seed-demo.mjs` hand-wrote a five-node straight chain with no
      `instruction`, bypassing the planner entirely.

---

## Milestones

### M1 — Failure containment (`7a1001b`)

- [x] `executeGroupTask()` no longer breaks on failure; it skips only nodes with
      a failed transitive ancestor
- [x] `findFailedAncestor()` exported from `flush-trigger.ts` and shared with the
      executor, so the runner and the flush trigger cannot disagree about which
      nodes a failure blocks
- [x] A skipped node records **which** node blocked it, replacing the blanket
      "an earlier node in the chain did not complete" — false for a node on an
      unrelated branch
- [x] Status stays `cancelled`; a `blocked` value would ripple into
      `NODE_TERMINAL`, the DTO, the web mirror type and every status pill
- [x] `orderForExecution()` — Kahn's algorithm tie-broken on the planner's own
      order, replacing the accidental `createdAt` sort. Deliberately not
      `task-buffer.ts`'s `topologicalSort()`, which tie-breaks on `completedAt`
      then id and would order a fresh run by UUID
- [x] Dependency gate in `runPlanNode()`: a node cannot run before its
      dependencies complete
- [x] Tests: a sibling branch survives a failure · a genuinely blocked node is
      skipped and names its blocker · the traversal survives a cycle and a
      dangling dependency

### M2 — Blocked is not dead (`2dca2eb`)

- [x] Resume re-runs branches that were BLOCKED, not just the node that failed
- [x] The blocked reason is cleared, not left on a now-successful node
- [x] Closes a real gap: the pre-existing resume test failed a **leaf**, so no
      node was ever blocked in it

### M3 — Honest seeds and offline runs (`21e0ec3`)

- [x] `seed-demo.mjs` builds its plan through the production
      `buildPlanNodes()` / `deriveOwnership()`, so seeded rows cannot drift from
      planner output again
- [x] The seeded plan is a real DAG with a join, and every node has an
      `instruction`
- [x] `index.ts` decides ONCE at boot whether Ark is usable, warns with what
      changes and how to fix it, and selects the offline planner and extractor
      explicitly — instead of both failing soft on every task
- [x] `kind: "join"` is set for fan-in nodes
- [x] `docker-compose.yml` states `MEMORY_EXTRACTOR` explicitly and gains a
      `seed` profile; the Dockerfile ships `scripts/`; `npm run poc` seeds on
      `SEED_DEMO=1`

### M4 — Retries (`8d6b37d`)

- [x] `GroupPlanNode.attempts`, persisted **before** each dispatch, so a restart
      resumes the count rather than restarting it
- [x] Every attempt is its own run row, with its own spans and context
      injection — two attempts are two real runs and the audit says so
- [x] `isRetryableFailure()` defaults to NOT retrying. Retried: timeouts, an
      agent still holding an active process, connection resets, non-zero exits.
      Not retried: a run that answered badly, output-size overflow, `ENOENT`
- [x] A human resume clears `attempts`, so an exhausted node can run again
- [x] Cap: `MAX_NODE_ATTEMPTS = 2`

### M5 — Parallel execution (`c2c622e`)

Deferred twice on three grounds. Each is now **enforced**, not avoided.

- [x] Ready-set scheduler replaces the sequential loop
- [x] **Agent**: two nodes for the same Agent never overlap (the A3 lease is not
      re-entrant, and the planner may give one Agent several nodes)
- [x] **Locks**: `locksConflict()` implements the runtime-lock COLLISION
      validation `ARCHITECTURE.md` defers as STRETCH. Lock keys are globs, so
      string equality is not enough — `code/**` contains `code/apps/server/**`.
      Both reduce to a directory prefix and are compared for containment either
      way. Read-only nodes declare no locks and never block
- [x] **Width**: `GROUP_MAX_PARALLEL_NODES` (default 4); `1` restores strictly
      sequential execution
- [x] Containment is unchanged under parallelism
- [x] Tested with a probe recording **peak in-flight runs** — counting
      cumulative requests cannot tell "ran together" from "ran one after the
      other", and produced three false passes before the probe replaced it.
      Disjoint areas peak at 2, overlapping locks at 1, same-Agent at 1,
      cap-of-1 at 1

### M6 — Planner input (`4519b08`)

- [x] `AgentGroup.description` reaches the planner as `# Team context` above the
      task. **Additive** — the task prompt is still what is planned; a group with
      no description emits no heading at all
- [x] Planning remains a single model call; role and Agent assignment are
      decided together

### M7 — The UI tells the truth about the DAG (`2b27ad8`, `0dfe675`, `b24fbdd`, `aa12578`, `15f969a`)

- [x] `ChainPanel` renders the graph, not a numbered list: each step says what
      it waits on, a fan-in carries a `join` badge, a branching plan says so
- [x] `attempts` added to the web mirror type and shown as an `attempt N` pill —
      it also warns that Trace opens the LAST attempt
- [x] `LiveTerminal` merges every running node's run instead of the first one,
      and counts the live Agents. The merge sorts by **timestamp**: `seq`
      restarts per run, so ordering a merged feed by it would interleave two
      Agents as 1,1,2,2
- [x] A failing trace no longer blanks the feed — each run is settled
      independently
- [x] Checkbox reset: the global `input { width: 100% }` rule was written for
      text fields and a checkbox inherited all of it, so it stretched and the
      browser painted the tick box centred inside that stretch — a different
      position on every row
- [x] Member counter counts against the Agents available, not the cap, and no
      longer treats fewer than three members as incomplete

---

## Cross-boundary edits

| File | Change | Why unavoidable |
|---|---|---|
| five `*.test.ts` fixtures | added `instruction`, then `attempts` | both fields are required on `GroupPlanNode`; leaving the suite red for a type-only reason is worse |
| `apps/web/src/styles.css` | checkbox reset, plan-graph and terminal styles | the checkbox bug is in a global rule; nothing else could fix it |
| `LiveTerminal.tsx` header comment | rewritten | it claimed "a group task runs one node at a time … when the parallel executor lands, this becomes a merge". That landed in `c2c622e`; a stale claim in the code is the same failure mode as the seed data |

---

## Status

**M1–M7 complete.**

```text
npm run check   clean
                server  22 files / 235 tests
                web     12 files /  75 tests
                build   both workspaces
```

Every box above was ticked only after the stated check actually passed.

---

## Verified vs not verified

Ticking a box means a test asserts it. Three things are **not** verified, and no
box claims they are.

| Claim | Status |
|---|---|
| A failure blocks only its transitive descendants | **verified** — sibling-survives and blocked-named tests |
| Independent branches genuinely overlap | **verified** — peak-concurrency probe, not a request count |
| Lock collision serialises overlapping areas | **verified** — peak 1 for `code/**` vs `code/**` |
| Retry keeps both attempts as separate runs | **verified** — two run rows, one failed, one completed |
| Parallel execution against a **real** Codex runtime | **NOT verified.** Every test uses `FakeRunner`. Concurrent writers on one shared `./code` tree have never been exercised by real `codex exec` processes |
| The retry classifier against **real** Codex failures | **NOT verified.** The strings it matches were read from `codex-runner.ts`, not observed in a live failure |
| Plans from a **real** Ark planner | **NOT verified.** Every planner test uses `FakePlannerClient` or a stub. Note `FakePlannerClient` puts every write node in area `all`, so its branches always collide on locks and serialise — offline runs cannot demonstrate parallelism |

---

## Deliberately not done

- **Problem 2 — when to consolidate.** Untouched. `kind: "join"` is in place as
  the boundary a watermark would fire on, and `resetAutoNotes()` already exists
  as the supersede primitive an incremental flush needs.
- **Plan preview / dry-run endpoint.** Planning and execution are the same call:
  `startGroupTask()` plans, persists, and starts running before it returns. The
  full DAG is persisted as `queued` before anything runs, so the UI usually sees
  the whole shape immediately — but that is a race, not a guarantee.
- **`plannerSource` persisted.** The UI cannot distinguish a real plan from the
  deterministic fallback. Declined deliberately.
- **A migration for stored role labels.** Editing a team re-derives them; teams
  never edited keep whatever they had.

---

## Open decisions

1. **The role dropdown.** Built, then derived, then restored as a closed
   three-option list. Still undecided whether it should exist at all: the
   planner reads each Agent's `description` and never reads the label.
2. **Retry exhaustion.** A node that runs out of attempts blocks its descendants,
   like any other failure. Pausing the task for a human instead would need a
   `blocked`-style status, which M1 argues against.
3. **Per-task note cap.** `MAX_NODE_ATTEMPTS` is bounded; `MAX_NOTES = 5` is
   per flush, not per task. Only matters once Problem 2 lands.
