# Milestone — Person 2 Build Log

> **The one question this answers: what has Person 2 actually built, and is it done.**
> Scope, ownership and order come from [`PLAN.md`](./PLAN.md).
> Contracts come from [`SPEC.md`](./SPEC.md) and [`DECISIONS.md`](./DECISIONS.md).
> This file adds no design. It tracks execution only.

**Workstream:** Person 2 — Group Runner, Sequential Chain, And Shared Code Setup.

---

## Scope boundary

In scope (from `PLAN.md` § Person 2 + § Ownership Corrections):

```text
apps/server/src/memory/group-runner.ts
apps/server/src/memory/flush-trigger.ts
apps/server/src/workspace.ts
apps/server/src/agent-service.ts
apps/server/src/codex-runner.ts          --add-dir  (A2)
apps/server/src/container-codex-runner.ts nested mount (A2)
```

Explicitly **not** in scope — do not build, even if it looks close:

```text
memory extraction, safety, landing, review, ledger   Person 3
task-buffer / consolidator prompts                   Person 3
frontend                                             Person 4
freshThread (A5), config MEMORY_* keys                Person 1
branch/join DAG, parallel-set validation,
  runtime-lock COLLISION validation                   STRETCH (A4)
```

---

## Pre-flight findings

Recorded before writing code, so later readers know what was true at the start.

- [x] `Database` already carries all 10 group/memory arrays with backfill (`store.ts`) — no store work needed.
- [x] `config.runtimeProvider` and `config.codexHome` already exist — no config work needed.
- [x] `writeInstructions()` regenerates `AGENTS.md` wholesale (`workspace.ts:38`) and `updateAgent()` calls it on every edit (`agent-service.ts:129`). Confirmed hazard; this is the Person 3 blocker.
- [x] `tsconfig.base.json` sets `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — optional fields must be declared `| undefined`, and every index access must be narrowed.
- [x] Person 1's landed layer predates A1–A5. Missing: `members`/`GroupRole`, `RunnerRequest.sharedCodePath`, `AgentLease`. Present but pre-A4: `AgentGroup.memberAgentIds`.

### Resolved contradiction — the memory pipeline entrypoint

`components/GROUP-RUNNER.md` shows GroupRunner building a task buffer and calling
`memoryPipeline.run(buffer)`. `PLAN.md` Bridge 4 and Bridge 5 say the entrypoint is
`runMemoryPipeline(groupTaskId, sinkNodeIds)` and that "GroupRunner should not shape
consolidator prompts directly".

**Bridge 4 wins.** GroupRunner takes no `TaskBufferBuilder` dependency at all; it passes
ids and lets Person 3 read the store. This is the narrower contract and matches the
stated separation.

---

## Placeholder strategy

`apps/server/src/memory/pending-contracts.ts` is the single quarantine file for every
contract Person 1 has not landed yet. Nothing else in the tree defines a duplicate type.

| Delta | Placeholder shape | Cutover when Person 1 lands |
|---|---|---|
| A4 `members: GroupMember[]` | `GovernedGroup = AgentGroup & { members }`, with `memberAgentIds` written as a **derived mirror** so Person 1's type and the existing web DTOs stay valid | drop the mirror + the `readMembers()` fallback |
| A2 `sharedCodePath` | `GroupRunnerRequest extends RunnerRequest` (optional field, so a plain `RunnerRequest` is still assignable) | delete the interface, widen imports to `RunnerRequest` |
| A3 `AgentLease` | interface here, implemented on `AgentService` | move the interface to `types.ts` |

The mirror is what makes this safe: `members` is authoritative, `memberAgentIds` is
recomputed from it on every write, so no consumer breaks during the transition and no
divergent permanent type definition is committed.

---

## Milestones

### M0 — Foundations

- [x] `memory/pending-contracts.ts` — `GroupRole`, `GroupMember`, `GovernedGroup`, `GroupRunnerRequest`, `AgentLease`, `AgentLeaseHolder`, `readMembers()`, `withDerivedMemberIds()`
- [x] `memory/memory-pipeline.ts` — `MemoryPipeline` interface (Bridge 4) + `NoopMemoryPipeline`
- [x] `test-helpers.ts` — shared `FakeRunner` extracted (PLAN § Testing Seams: one exists only as a local class in `agent-service.test.ts`; do not write a second)
- [x] Records what each agent was asked and what `sharedCodePath` it received, so A2 is assertable

### M1 — Flush trigger (`FLUSH-TRIGGER.md`, build order #3)

- [x] `memory/flush-trigger.ts` — `decideFlush()` as a pure function, no store mutation
- [x] Sink detection = nodes no other node depends on
- [x] `flushedAt` guard so a task flushes at most once
- [x] Tests: chain flushes after last node · unfinished node → `not_terminal` · failed+completed → `partial` · all failed → `no_completed_runs` · second call after flush → no second flush

### M2 — Workspace extensions (`WORKSPACE-EXTENSIONS.md`, build order #2)

**This milestone unblocks Person 3. It must land before any governed memory is written.**

- [x] `replaceManagedBlock(existing, markerId, body)` / `removeManagedBlock(existing, markerId)` exported as pure functions, in the arity Person 3 requested
- [x] `markerId` is the FULL block id (`memory:<noteId>` / `group-task:<taskId>`), built by the exported `memoryMarkerId()` / `groupTaskMarkerId()`; a bare id throws rather than writing a block `writeInstructions()` cannot preserve
- [x] `writeInstructions()` **composes** instead of regenerating: base identity, then preserved `group-task` blocks, then preserved `memory` blocks
- [x] `sharedCodePath()`, `createSharedCodeDirectory()`
- [x] `prepareSharedCode()` — the single runtime branch (A2): `container` → mkdir mountpoint, `local-process` → symlink
- [x] Idempotent re-link; conflicting existing `code` target throws 409
- [x] `writeGroupTaskSection()` / `clearGroupTaskSection()`
- [x] Tests: memory block survives an agent edit (the Person 3 hazard) · both runtime branches · idempotency · conflict · governed memory never lands in shared code

### M3 — A2 shared code reaches Codex

- [x] `codex-runner.ts` — `--add-dir <sharedCodePath>` after `-C`, local-process only
- [x] `container-codex-runner.ts` — nested bind mount `src=<shared>,dst=/workspace/code`, ordered after the workspace mount
- [x] No `--add-dir` in container mode (`/workspace/code` is inside cwd, so `workspace-write` covers it)
- [x] Solo runs pass no `sharedCodePath` and are byte-identical to before
- [x] Tests on both arg builders, including the solo no-op case

### M4 — A3 agent lease

- [x] `acquireAgent()` flips `ready → busy` inside one `store.mutate()`, 409 if held
- [x] `releaseAgent()` clears the holder, runs in `finally` on both paths
- [x] `sendMessage()`'s inline busy check replaced by `acquireAgent`, preserving the existing 404/409 messages and the existing test expectations
- [x] `stopAgent()` on a group-held agent → 409 naming the group task
- [x] `initialize()` clears stale leases alongside the existing run reset
- [x] No re-entrancy (A4: the chain is sequential, so an agent's two turns never overlap)
- [x] Tests: solo message during a group node → 409 not 500 · stop during a group node → 409 · backend takes two turns without deadlock

### M5 — Group runner (`GROUP-RUNNER.md`, build order #4)

- [x] `memory/group-chain.ts` — the fixed five-node template, bound by **role** not by agent name or list order
- [x] `createGroup` / `updateGroup` / `getGroup` / `listGroups`, membership frozen while `activeTaskId` is set
- [x] Membership epoch + fresh `groupThreadId` on re-add
- [x] `startGroupTask()` — validates exactly three members one per role (409 with the specified sentence), creates task + shared code + participants + nodes + seq-1 human message, returns immediately
- [x] `memory/group-prompt.ts` — context packet + turn prompt, both pure and unit-tested
- [x] `executeGroupTask()` — plain `for` loop, breaks on failure, still allows partial consolidation
- [x] `runPlanNode()` — lease → node running → context injection persisted **before** Codex → lock rows → run → thread id back to participant → output + group message → terminal status → release in `finally`
- [x] Uses `participant.groupThreadId`, never `Agent.codexThreadId`
- [x] Calls `decideFlush()`, then `runMemoryPipeline()`; pipeline failure never fails the task
- [x] `cancelGroupTask()` — cancels in-flight run, releases leases and lock rows, marks remaining nodes cancelled
- [x] Tests: chain runs in order · backend/frontend take two turns · group thread separate from solo · shared `./code` prepared for every member · locks all released · failure → partial · pipeline throw does not fail the task

### M6 — Wiring

- [x] `AgentService` delegates the group methods to `GroupRunner` (the 501 stubs go away)
- [x] Restart recovery: running/queued tasks → cancelled, `activeTaskId` → null, running/queued nodes → cancelled, open lock rows released
- [x] `app.ts` — A4 membership schema, cancel route (**cross-boundary, see below**)

### M7 — Verification

- [x] `npm run typecheck` clean (server + web)
- [x] `npm run test` green, full suite
- [x] `npm run build` clean
- [x] No `any`, no `@ts-expect-error`, no skipped tests
- [x] Solo-run behaviour unchanged — every pre-existing test still passes untouched

---

## Cross-boundary edits

Files owned by someone else that this workstream had to touch, why, and what to hand back.

| File | Owner | Change | Why unavoidable |
|---|---|---|---|
| `app.ts` `createGroupBody` / `updateGroupBody` | Person 1 | `memberAgentIds` → `members: [{agentId, role}]`, `.length(3)` | A4's contract is unreachable through the API without it; the service layer would be correct but uncallable |
| `app.ts` cancel route | Person 1 | added `POST /api/groups/:id/tasks/:taskId/cancel` | `PLAN.md` assigns the impl to Person 2 and the route to Person 1; the impl is dead code without a route |
| `app.test.ts` group stub test | Person 1 | asserted 501 on `createGroup`; now asserts 201 | implementing `createGroup` necessarily obsoletes its own stub test; leaving the suite red is worse |
| `container-codex-runner.test.ts` codex-home assertion | pre-existing | asserted a literal `/tmp/codex-home` | `config.ts` resolves `CODEX_HOME`, so the test failed on Windows **before any change in this workstream** (verified by stashing and re-running on unmodified HEAD). Now asserts the resolved value and passes on every platform |

None of these change a contract — they land the contract `SPEC.md` already specifies.
Person 1 should review, not re-decide.

---

## Deliberately not done

- Branch/join DAG, join-owner selection, parallel-set validation, runtime-lock collision validation — STRETCH per A4
- `freshThread` (A5), `MEMORY_*` config keys — Person 1
- Any file under `memory/` owned by Person 3 — only the `MemoryPipeline` **interface** and a Noop are defined here, per Bridge 4
- `workspace-memory.ts` — Person 3 owns it and imports M2's helpers

---

## Status

**All seven milestones complete.**

```text
npm run typecheck   clean, server + web
npm run test        84 passed / 84
npm run build       clean
```

Every box above was ticked only after the stated check actually passed.

---

## Verified vs. not verified

Ticking a box means a test asserts it. Three things this workstream depends on
are **not** verified here, and no box above claims they are.

| Claim | Status |
|---|---|
| Arg builders emit `--add-dir` (local-process) and the nested mount (container) | **verified** by unit test on both builders |
| `./code` resolves to the shared tree and writes land there | **verified** on the local-process path, by writing through the link in a test |
| Shared `./code` is writable from inside a **real Codex run**, in **both** runtimes | **NOT verified.** Needs a live `codex exec` and a container. `PLAN.md` lists this in Person 2's Done When; it stays open until the first end-to-end run |
| `codex exec` *fires* a discovered skill (as opposed to discovering it) | **NOT verified**, and not this workstream's -- the residual A1 check, blocked on `ARK_API_KEY` |
| Span capture produces usable spans for a run that writes files | **NOT verified.** The database still holds zero spans (Day-0 checklist). Group nodes persist spans through the same callback path as solo runs, so whatever is true for solo runs is true here |

The two Day-0 blockers are unchanged by this work: the `ARK_API_KEY` returns 401,
and no run has yet produced a span.

---

## Handover

For Person 1 -- the placeholder cutover, smallest diff first:

```text
1. types.ts   add GroupRole, GroupMember; AgentGroup.members replaces
              memberAgentIds; RunnerRequest.sharedCodePath; AgentLease +
              AgentLeaseHolder                    (all already written in
                                                   memory/pending-contracts.ts)
2. rewrite imports from memory/pending-contracts.js to types.js
3. delete memory/pending-contracts.ts and the deriveMemberAgentIds mirror
4. still yours and untouched here: freshThread (A5), MEMORY_* config keys,
   deleteAgent() cascade over groups/participants/notes/grants/landedMemoryFiles
```

For Person 3 -- what is ready to build on:

```text
replaceManagedBlock / removeManagedBlock / extractManagedBlocks  exported from
  workspace.ts. Import them; do not reimplement, and do not edit workspace.ts.

writeInstructions() now COMPOSES, so a <!-- memory:<noteId> --> block survives
  an Agent edit. Verified by test. The hazard that blocked you is closed.

MemoryPipeline.runMemoryPipeline(groupTaskId, sinkNodeIds) is the seam. Replace
  NoopMemoryPipeline by passing your implementation as AgentService's 5th
  constructor argument. It is called once, after a task reaches a terminal
  status, and anything it throws is caught so the group task still completes.
```

For Person 4 -- what the API now returns:

```text
POST /api/groups                            201, body {name, description?, members:[{agentId,role}]}
POST /api/groups/:id/tasks                  202, runs the chain in the background
GET  /api/groups/:id/tasks/:taskId          GroupTaskResponse - poll this one only
POST /api/groups/:id/tasks/:taskId/cancel   202  (new)
```

`contextInjections[].withheldMessageIds` means **already seen by that Agent**,
not denied by policy. Label it that way in the UI, per `DEMO.md`.
