# Integration Manifest — Person 3 (Memory Pipeline)

> **The one question this answers: how to reconcile Person 3's branch with
> Person 1 and Person 2, without reverse-engineering three branches.**
>
> This is a checklist for the integrator (human or agent). Follow it top to
> bottom. Every stub and every wiring point Person 3's branch needs is listed
> here with an exact file, symbol, and signature. Nothing about the memory
> pipeline needs to be inferred from reading the code.
>
> Authority: names that also appear in [`SPEC.md`](./SPEC.md) defer to SPEC.
> Bridge numbers refer to [`PLAN.md`](./PLAN.md) "Bridge Contracts".

---

## 0. TL;DR for the integrator

Person 3's branch is **purely additive**: it only creates files under
`apps/server/src/memory/`. It edits **no** shared file (`types.ts`, `app.ts`,
`store.ts`, `workspace.ts`, `agent-service.ts`, `config.ts`). So:

- **Git merge:** Person 3's branch has ~zero conflict with anyone. The real
  merge work is Person 1 ↔ Person 2 over `app.ts`.
- **Person 3 reconciliation = 2 stub swaps + 3 wiring points.** All listed below.
- **Find every stub:** `grep -rn "STUB SEAM" apps/server/src/memory/`.
- **Verify at every step:** `npm run check` (typecheck + 70 tests + build).
  Person 3's suite is green in isolation *today*; keep it green as you wire.

---

## 1. What Person 3 delivered

All under `apps/server/src/memory/`, all tested, `npm run check` green in
isolation.

| File | Public surface | Consumed by |
|---|---|---|
| `types.ts` | `CandidateMemoryNote`, `SafetyResult`, `TaskBuffer`, `TaskBufferEntry` | internal only |
| `safety.ts` | `evaluateNoteSafety`, `redactSecrets`, `detectQuarantine` | pipeline |
| `task-buffer.ts` | `TaskBufferBuilder`, `MAX_TASK_BUFFER_CHARS` | pipeline |
| `extractor-client.ts` | `createExtractorClient`, `MemoryConfig`, `memoryConfigFromEnv`, `Fake/Off/ArkExtractorClient` | pipeline, config |
| `consolidator.ts` | `Consolidator` | pipeline |
| `workspace-memory.ts` | `WorkspaceMemoryWriter`, `replaceManagedBlock`, `removeManagedBlock`, `noteSlug` | landing |
| `landing.ts` | `LandingService` (`landMemory`, `revokeMemory`, `listAgentMemory`) | review, API |
| `ledger.ts` | `LedgerService` (`listTaskGrants`, `listNoteGrants`, record\*) | review, API |
| `review.ts` | `ReviewService` (`processCandidate`, `applyReview`, `approve`, `edit`, `reject`, `revoke`, `listNotes`) | pipeline, API |
| `pipeline.ts` | `createMemoryPipeline`, `RealMemoryPipeline`, `NoopMemoryPipeline`, `MemoryPipeline` | GroupRunner |

---

## 2. Stub swaps (do these once P1 / P2 have landed)

### STUB A — config keys (Person 1 → `config.ts`)

**Where the stub is:** `apps/server/src/memory/extractor-client.ts` —
`MemoryConfig` interface + `memoryConfigFromEnv()`. Marked `STUB SEAM`.

**Precondition:** Person 1 has added to `config.ts` (envSchema **and** returned
object), exact names:

```ts
// envSchema
MEMORY_EXTRACTOR: z.enum(["ark", "fake", "off"]).default("fake"),
MEMORY_EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
// returned object
memoryExtractor: env.MEMORY_EXTRACTOR,
memoryExtractTimeoutMs: env.MEMORY_EXTRACT_TIMEOUT_MS,
```

**The swap:** nothing to change inside `extractor-client.ts`. `AppConfig` becomes
a structural superset of `MemoryConfig`, so at the call site (see wiring W2) pass
the real `config` object instead of `memoryConfigFromEnv()`. `memoryConfigFromEnv`
may stay as a fallback or be deleted once no caller uses it.

**Verify:** `MEMORY_EXTRACTOR` must default to `fake` so `npm run check` never
hits the network.

### STUB B — managed-block helpers (Person 2 → `workspace.ts`)

**Where the stub is:** `apps/server/src/memory/workspace-memory.ts` — local
`replaceManagedBlock()` and `removeManagedBlock()`. Marked `STUB SEAM`.

**Precondition:** Person 2 has landed and **exported** from `workspace.ts`, exact
signatures:

```ts
export function replaceManagedBlock(existing: string, markerId: string, body: string): string;
export function removeManagedBlock(existing: string, markerId: string): string;
```

and `workspace.ts writeInstructions()` now **preserves** any `<!-- memory:* -->`
blocks instead of regenerating over them (see PLAN "Hard ordering constraint —
WORKSPACE-EXTENSIONS blocks LANDING").

**The swap (Person 3's job, mechanical):**
1. In `workspace-memory.ts`, delete the two local functions under the STUB banner.
2. Replace with: `import { replaceManagedBlock, removeManagedBlock } from "../workspace.js";`
3. `npm run check`. The landing tests assert byte-level file output, so any
   behavioural drift between the two implementations fails loudly here.

**Contract the two implementations must share** (so the swap is safe): a block is
delimited by `<!-- ${markerId} -->` … `<!-- /${markerId} -->`; replace upserts in
place or appends if absent; remove strips the block and its markers; both are
pure and touch nothing else. Person 3 uses `markerId = "memory:<noteId>"`.

---

## 3. Wiring points (connections that no single branch reveals)

### W1 — GroupRunner → memory pipeline (Bridge 4, Person 2 calls Person 3)

**Producer:** Person 2 `GroupRunner`. **Consumer:** `runMemoryPipeline`.

Person 2 currently holds a `NoopMemoryPipeline`. Replace it with the real one and
call it after the flush trigger returns `shouldFlush=true`:

```ts
import { createMemoryPipeline } from "./memory/pipeline.js";

const memory = createMemoryPipeline(store, config); // config optional; see W2
// ... after the task reaches its flush point:
await memory.runMemoryPipeline(groupTaskId, sinkNodeIds);
```

**Preconditions the pipeline relies on** (Bridge 4/5 — Person 2 must guarantee):
completed `GroupPlanNode` rows carry `runId`, `output`, `status`, `completedAt`;
`TraceSpan` rows exist per run; `GroupContextInjection` rows exist per node run;
runtime locks released. **Failure behaviour is already handled:** the pipeline
catches everything and never throws, so a memory failure cannot fail the task.

### W2 — config → pipeline

`createMemoryPipeline(store, config?, options?)`:
- `config` — pass Person 1's real `AppConfig` once STUB A is done. If omitted it
  falls back to `memoryConfigFromEnv()`.
- `options.reviewAllSkills` — wire to Person 1's `REVIEW_ALL_SKILLS` config if
  present (forces every note through human review).

### W3 — API routes → memory services (Bridge 7 + 10, Person 1 wires)

Person 1's route handlers call these service methods (routes stay thin; never
write files or mutate the ledger directly). Construct the services once and hold
them on `AgentService`:

```ts
const ledger  = new LedgerService(store);
const landing = new LandingService(store);
const review  = new ReviewService(store, landing, ledger, config.reviewAllSkills);
```

| Route (SPEC Part 2) | Call |
|---|---|
| `GET  /api/notes?agentId=&status=` | `review.listNotes({ agentId, status })` |
| `POST /api/notes/:id/review` | `review.applyReview(id, body)` — body is the `ReviewNoteInput` union (approve/edit/reject) |
| `POST /api/notes/:id/revoke` | `review.revoke(id, body)` — body `{ reviewerName, reason }` |
| `GET  /api/agents/:id/memory` | `landing.listAgentMemory(id)` |
| `GET  /api/tasks/:id/grants` | `ledger.listTaskGrants(id)` |

Note: `review.applyReview` throws `HttpError(404)` for a missing note and
`HttpError(409)` when approving a note that is not awaiting review — surface those
status codes directly.

---

## 4. Ordering

```
1. Merge Person 1 (types/store/config/routes) and Person 2 (runner/workspace).
   Resolve the P1↔P2 app.ts overlap. Person 3's memory/ files merge cleanly.
2. STUB A: confirm Person 1's config keys exist.               (verify: check)
3. STUB B: swap workspace-memory.ts to import P2's helpers.    (verify: check)
4. W1: GroupRunner calls createMemoryPipeline + runMemoryPipeline.
5. W2: pass real AppConfig into createMemoryPipeline.
6. W3: Person 1 wires the five routes to the services.         (verify: check)
7. Full end-to-end: run a group task with MEMORY_EXTRACTOR=fake and confirm
   notes appear, a clean note lands a file, ledger shows granted + withheld.
```

`MEMORY_EXTRACTOR=fake` keeps the whole path offline and deterministic. Swap to
`ark` only after the fake path runs end to end and a valid `ARK_API_KEY` exists.

---

## 5. Things that are NOT bugs (so nobody "fixes" them)

- **Person 3 never edits `workspace.ts`.** Governed memory is written only by
  `workspace-memory.ts` (`WorkspaceMemoryWriter`). This is deliberate ownership
  (PLAN "Deconflicted"), not an omission.
- **Consolidator labels targetable agents by `agent.name`, and review derives
  task participants from `groupPlanNodes`.** This is intentional so Person 3 does
  not depend on the `memberAgentIds` → `members` (A4) shape. Do not "fix" it to
  read `group.members`.
- **`syntheticGroup()` in `pipeline.ts`** is a fallback for a missing group row;
  the consolidator does not read group fields, so it is harmless.
- **The `fake` extractor parses IDs out of the consolidator prompt.** That
  coupling is intentional — it is what makes fake notes cite real run/span IDs so
  they survive validation and can actually land. If you change the consolidator
  prompt's `## Agents you may target` / `run …; spans …` format, update
  `FakeExtractorClient` to match.

---

## 6. One-line verification at every step

```
npm run check      # typecheck + full test suite + production build
```

Person 3's suite (safety, ledger, task-buffer, extractor, consolidator, landing,
review, pipeline) must stay green throughout. If a swap or wiring step turns one
red, that test names exactly what drifted.
