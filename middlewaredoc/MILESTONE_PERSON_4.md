# Milestone — Person 4 Build Log

> **The one question this answers: what has Person 4 actually built, and is it done.**
> Scope and ownership come from [`PLAN.md`](./PLAN.md).
> Contracts come from [`SPEC.md`](./SPEC.md) and [`DECISIONS.md`](./DECISIONS.md).
> This file adds no design. It tracks execution only.

**Workstream:** Person 4 — Frontend Demo Experience And End-To-End QA.

---

## Scope boundary

In scope:

```text
apps/web/src/group/**            the Teams surface
apps/web/src/App.tsx             the view switch only
apps/web/src/api.ts              cancelGroupTask (see cross-boundary)
apps/web/src/styles.css
apps/server/src/app.groups.test.ts
apps/server/src/integration-e2e.test.ts
scripts/seed-demo.mjs
```

Explicitly not in scope: types/store/routes (Person 1), group execution and
`workspace.ts` (Person 2), the memory pipeline (Person 3).

---

## Milestones

### M0 — Integration

Person 4 was also the integrator. Four branches merged onto `feat/frontend-qa`
in the order `integrationManifestTask2` §4 specifies.

- [x] Person 1 merged clean
- [x] Person 2 merged; six conflicting files resolved per the PLAN ownership map
- [x] Person 3 merged clean, as `integrationManifest3` predicted
- [x] The `pending-contracts` cutover (manifest §3, "IF Person 1 has landed")
- [x] STUB A, STUB B, W1, W2, W3 — all five swaps and wirings
- [x] Gate green after every merge

**The trap that was caught:** `freshThread` (A5) exists only on Person 1's
`agent-service.ts`. Person 2 owns that file and their version carries the whole
GroupRunner delegation, so resolving with `--theirs` drops A5 silently and the
suite stays green. It was re-applied by hand through
`sendMessage → executeRun → runToTerminal`.

### M1 — End-to-end seam test

- [x] `integration-e2e.test.ts` drives a REAL group task through the REAL
      pipeline and asserts Bridge 5, the transcript, leases, locks, notes,
      grants, and that landed files sit inside their own Agent's workspace

**The bug that found:** `FakeRunner` never called `onSpan`, so it produced zero
spans. The consolidator requires every note to cite `sourceSpanIds`, and
`FakeExtractorClient` returns zero notes when it finds no span ids. Driven by
the fake runner — the offline demo and test path — the memory pipeline was
structurally incapable of producing a single note. No existing test caught it
because the group-runner suite asserts the hand-off with a recording double and
never runs the real pipeline.

### M2 — The Teams surface

- [x] `GroupEditor` — role-bound membership (A4), nothing selected by default,
      submit blocked until all three roles are filled, chain preview
- [x] `ChainPanel`, `TimelinePanel`, `ContextPanel`
- [x] `ReviewPanel` — approve / edit / reject / revoke, with content, severity,
      routing and `description` as the edit levers
- [x] `LedgerPanel` — granted AND withheld, each with a plain-language reason
- [x] `LandedMemoryPanel` — what each workspace actually holds
- [x] `ProofPanel` — the A5 beat, always `freshThread: true`
- [x] Sidebar view switch; the solo Agent flow is untouched
- [x] `TracePanel` hoisted so a group node's trace opens the same panel

### M3 — Web test setup

The repo had none: `npm test` ran the server only, so no component had ever
rendered.

- [x] vitest + jsdom + testing-library for `@launchpad/web`
- [x] Root `npm test` runs BOTH workspaces, so the web suite cannot be skipped
- [x] 21 tests across `GroupEditor`, `useGroupTask`, `panels`

### M4 — Production error handling

- [x] `app.groups.test.ts` runs the app in PRODUCTION mode

**The bug that found:** the custom error handler was registered after
`await app.register(fastifyStatic)`, which only runs in production, so it never
took effect there. Every validation error returned **HTTP 500** carrying the raw
ZodError JSON dump. Every existing test builds the app with `NODE_ENV=test` and
skips that path. Fixed by installing the handler first; the regression test was
confirmed to fail on the old code.

### M5 — Demo fixtures

- [x] `scripts/seed-demo.mjs` (`npm run seed`), idempotent
- [x] Drives the REAL `LandingService` / `ReviewService` / `LedgerService`, so
      every landed file on disk is byte-identical to a live run
- [x] Produces the demo narrative: 1 pending (severe), 2 active, 1 quarantined
      poisoning fixture, 2 files landed, 10 grant decisions

---

### M6 — Live QA and diagnostics

- [x] The full governance loop exercised against a **running server**, not a
      unit test: `POST /notes/:id/review {approve}` moved a severe note
      `pending → active` and wrote a real `<!-- memory:… -->` block into BOTH
      target workspaces; `POST /notes/:id/revoke` removed it from disk; the
      ledger kept every record (`granted 4, withheld 9, revoked 2`)
- [x] Non-targets stayed empty throughout — Security 0 files, Ops 0 files
- [x] `scripts/verify-live.mjs` (`npm run verify:live`), a read-only diagnostic
      for a real task

**Why the diagnostic exists:** three of the four things a live run should prove
fail *silently*. A node reports `completed` while the Agent never wrote to
shared code; an empty Review tab looks identical whether the consolidator
rejected every note or never received a span. Without this the likely outcome is
concluding the memory pipeline is broken when the cause is a span-shape
mismatch.

It runs the **real** `shouldIncludeSpan` imported from `task-buffer.ts`, so the
diagnosis cannot drift from the pipeline. Verified by **fault injection**, not by
inspection — four faults were injected into a healthy store and each produced the
correct diagnosis:

```text
reasoning spans without terminal:true  names the filter, the counts (0/10),
                                       and the file to fix
no spans at all                        "the runner never called onSpan"
empty shared-code                      "A2 is unproven", plus whether the
                                       ./code link exists at all
a skill under CODEX_HOME               "that path is GLOBAL to every Agent"
```

### M7 — Three bugs the tooling found in itself

Each was found by pointing a tool at real state rather than a scratch directory,
and each would have surfaced on demo morning.

- [x] **The seed described work it never did.** It claimed five nodes that wrote
      code while `shared-code/` stayed empty and no `./code` link existed. It now
      calls the real `prepareSharedCode` and leaves the artefacts the chain says
      it produced. Found by `verify-live`.
- [x] **The seed wrote to the wrong store.** `loadConfig` only reads
      `APP_DATA_DIR`; `LOCAL_POC_DATA_ROOT` is a `start-local-poc.sh` concept. So
      the command both this file and `DEMO.md` recommend wrote to the repo's
      `.data/` while the poc served `~/.volc-agent-launchpad`, and the app showed
      an empty Teams screen with no error.
- [x] **Reseeding threw 409.** Each reseed mints a new taskId and
      `prepareSharedCode` rightly refuses to repoint a live `./code` link. The
      guard is correct; the seed now calls `releaseSharedCode` first. Only
      visible once the previous bug was fixed.

---

## Verified vs. not verified

Ticking a box means something asserts it. What is not verified says so.

| Claim | Status |
|---|---|
| `npm run check` — typecheck, 145 server + 21 web tests, build | **verified** |
| A real group task hands real node output to the real pipeline | **verified** by `integration-e2e.test.ts` |
| Landed files sit only in their target Agent's workspace | **verified**, asserted on the filesystem |
| Real Codex **discovers** a seeded skill in the granted workspace and nothing in the withheld one | **verified** against `@openai/codex@0.111.0` via `skills/list` |
| Nothing lands under `$CODEX_HOME` or `shared-code/` | **verified** |
| Production returns 400, not 500, for an invalid body | **verified**, and the regression test fails on the old code |
| Approve writes real files; revoke removes them; the ledger stays append-only | **verified** against a running server |
| The Teams UI renders correctly **in a browser** | **verified by eye** — the surface was opened and read. Layout is not asserted by any test |
| The five-node chain against **real Codex** | **NOT verified.** Needs `npm run poc` |
| Shared `./code` writable from a **real** `codex exec` | **NOT verified.** Still open from Person 2's list |
| Real Codex spans satisfy the consolidator's validation | **NOT verified.** The fix made the *fake* runner emit spans; the real stream is unexamined |
| `codex exec` **fires** a discovered skill | **NOT verified.** The residual A1 check |

### Correction to an earlier claim

The Day-0 blocker "`ARK_API_KEY` returns 401" was **wrong, and it was my error.**
The key is valid. It was tested against the default `ark.cn-beijing.volces.com`
while `.env` sets `ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3`.
Verified HTTP 200 against the configured endpoint.

Note that `scripts/start-local-poc.sh` does **not** read `.env` — only
`docker compose` does. For the poc, export them first:

```bash
set -a; . ./.env; set +a
npm run poc
```

---

## Cross-boundary edits

| File | Owner | Change | Why unavoidable |
|---|---|---|---|
| `apps/web/src/api.ts` | Person 1 | added `cancelGroupTask` | The route is in SPEC Part 2 with no client method; a five-node chain at `CODEX_TIMEOUT_MS` each needs an escape hatch |
| `apps/server/src/app.ts` | Person 1 | moved `setErrorHandler` before the static plugin; readable ZodError summary | Every validation error was a 500 in production. The UI displays `error`, so this lands on the frontend |
| `apps/server/src/test-helpers.ts` | Person 2 | `FakeRunner` emits spans; added `RecordingMemoryPipeline` | Without spans the memory pipeline cannot produce a note at all |
| `apps/server/src/types.ts` | Person 1 | `sharedCodePath?: string \| undefined` | Matches the convention every other optional field in that file uses; required by `exactOptionalPropertyTypes` |

None changes a contract. Owners should review, not re-decide.

---

## Handover

To see everything without waiting on Codex:

```bash
npm run seed            # build + populate the demo dataset
npm run dev             # or: set -a; . ./.env; set +a; npm run poc
```

Then switch to **Teams** and pick *Upload Feature Team*. Review, Ledger,
Workspaces and Proof all have real data.

Still open, in priority order:

```text
1. Look at the UI in a browser. Nobody has.
2. npm run poc with a real key: the five-node chain, shared ./code writes, and
   whether real spans satisfy the consolidator.
3. The residual A1 check -- does codex exec FIRE a landed skill.
4. DEMO.md timings are budgets, not measurements. Re-time against the build.
```
