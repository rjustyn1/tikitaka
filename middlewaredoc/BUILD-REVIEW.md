# Build Review — Governed Cross-Agent Memory

> **The one question this answers: what exists right now, across all four
> workstreams, and which claims are actually proven.**
>
> Per-workstream detail lives in `MILESTONE_PERSON_1/2/4.md`. Design rationale is
> in [`ARCHITECTURE.md`](./ARCHITECTURE.md); contracts are in
> [`SPEC.md`](./SPEC.md). This file adds no design — it is a status snapshot.
>
> Read from the tree at `feat/frontend-qa @ e528493`. Every figure below was
> measured, not recalled.

```text
branch   feat/frontend-qa @ e528493, clean and pushed
gate     npm run check — typecheck · 167 tests · build, all green
```

---

## At a glance

| | |
|---|---|
| Server | **6,089** lines across 28 modules |
| Web | **3,472** lines, 7 new Teams modules |
| Tests | **167** — 145 server + 22 web |
| Routes | **29** — 15 solo, 14 group + memory |
| Store arrays | **15** — 5 original, 10 new |
| Docs | **29** files, one home, one map |

> ⚠️ The test count is **167**, not 145. `npm test -w @launchpad/server` alone
> under-reports — the web suite is real and is wired into the root gate.

---

## What the system does

Agents run in isolated Codex sessions, so anything one works out dies with its
run. This middleware watches a **shared task** — a team of agents working one
goal — captures what each produced, distils it into targeted notes, decides
which other agents may receive each note, and writes those notes into the
recipients' workspaces as memory Codex loads on future runs. A human gates
anything high-impact.

**The claim that makes it governance rather than a memory feature:**

```text
Security   = file placement    deterministic, ours,   enforced at write time
Relevance  = Codex's matcher   model-driven, theirs,  evaluated at read time
```

A note reaches an agent **if and only if** a file was written into that agent's
workspace. We did not reinvent retrieval; we drew a hard line around who may
receive what, and we record every grant *and every denial* with a named reason.

---

## What each workstream delivered

### Person 1 — contracts, store, routes

The layer everyone else imports. Landed first and unblocked the rest.

- All group + memory types; 10 new store arrays with backfill
- Legacy migration: old `memberAgentIds` rows → `members`
- 29 Fastify routes with Zod schemas
- `MEMORY_*` and `REVIEW_ALL_SKILLS` config keys
- A5 `freshThread`; the A3 lease seam

### Person 2 — group runner, workspaces, lease

The execution path, and the file mechanics the memory layer sits on.

- Five-node sequential chain, bound by role
- Shared `./code` per runtime: symlink or nested bind mount
- Managed-block helpers; `writeInstructions()` now **composes** rather than
  regenerates — this is what stops an Agent edit wiping landed memory
- Agent lease, so solo and group runs cannot collide
- Restart recovery; cancel; runtime-lock rows

### Person 3 — memory pipeline

Purely additive under `memory/`. Merged with **zero** conflicts, exactly as its
integration manifest predicted.

- Task buffer, extractor client (`ark` / `fake` / `off`), consolidator
- Safety: secret redaction + quarantine heuristic
- Landing — the single enforcement point
- Review state machine; append-only grant ledger

### Person 4 — frontend, QA, integration

The Teams surface, plus the merge of all four branches.

- Seven panels: plan, transcript, context, review, ledger, workspaces, proof
- Web test setup — the repo had none
- Seed script and the `verify:live` diagnostic
- End-to-end seam test; live governance round-trip

---

## Architecture as built

Module sizes are a rough proxy for where complexity actually landed. The group
runner is the largest single module by a wide margin.

| Module | Owner | Responsibility | Lines |
|---|---|---|---:|
| `memory/group-runner.ts` | P2 | Chain execution, context packets, leases, locks, flush | 834 |
| `codex-runner.ts` | P2 | Codex subprocess, span parsing, `--add-dir` | 637 |
| `agent-service.ts` | P1/P2 | Solo runs, the lease, service facade | 610 |
| `app.ts` | P1 | 29 routes, Zod validation, error handler | 370 |
| `types.ts` | P1 | Every shared contract | 363 |
| `workspace.ts` | P2 | Workspaces, shared code, managed blocks | 356 |
| `container-codex-runner.ts` | P2 | Per-turn disposable container, nested mount | 296 |
| `memory/review.ts` | P3 | Risk gate, approve / edit / reject / revoke | 276 |
| `memory/task-buffer.ts` | P3 | Rebuilds the task transcript for the extractor | 236 |
| `memory/group-chain.ts` | P2 | The five-node template + membership validation | 195 |
| `memory/extractor-client.ts` | P3 | `ark` / `fake` / `off` backends | 191 |
| `memory/consolidator.ts` | P3 | Transcript → candidate notes, validated | 171 |
| `memory/ledger.ts` | P3 | Append-only grants and withholdings | 160 |
| `memory/pipeline.ts` | P3 | Bridge 4 entry point; fails open | 146 |
| `memory/safety.ts` | P3 | Redaction + quarantine | 116 |
| `memory/flush-trigger.ts` | P2 | Is the task terminal and worth consolidating? | 110 |
| `memory/landing.ts` | P3 | **The enforcement point** | 108 |
| `memory/workspace-memory.ts` | P3 | The only writer of governed memory files | 105 |

### Choke points that survived integration

Two rules from the plan held, and both are worth defending in review:

```text
writes into an agent workspace   workspace.ts, memory/workspace-memory.ts
invokes Codex                    agent-service.ts (solo), group-runner.ts (group)
```

Everything else goes through them.

---

## The pipeline, end to end

What happens when a team task finishes. Step 6 is the human gate.

```text
1  Chain executes            group-runner.ts
   Five nodes in role order. Each acquires the agent lease, gets a context
   packet persisted BEFORE Codex runs, writes to shared ./code, releases in
   a finally block.

2  Flush decision            flush-trigger.ts
   Pure function. Sink node terminal and at least one node completed, or
   nothing consolidates. A task flushes at most once.

3  Task buffer               task-buffer.ts
   Reads runs, spans and context injections back out of the store in
   topological order. Filters noisy spans, caps size.

4  Consolidate               consolidator.ts
   One extractor call produces up to five targeted notes. Routing is folded
   in — there is no separate classifier. Every note must cite source run and
   span ids that exist in the buffer.

5  Safety                    safety.ts
   Secret redaction and a quarantine heuristic run BEFORE anything is written.

6  Risk gate — the human     review.ts          <-- the authority point
   severe ∨ redaction-fired ∨ quarantine-hit ∨ fallback-routed goes to a
   person. Everything clean and narrow auto-activates.

7  Land by placement         landing.ts -> workspace-memory.ts
   severe -> AGENTS.md managed block, always loaded
   normal -> .agents/skills/<slug>/SKILL.md, loaded when its description matches

8  Ledger                    ledger.ts
   One append-only row per agent per note: granted with a path, or withheld
   with a named reason. Revoking deletes the file and keeps the record.
```

---

## The five decisions, and where they live

A1–A5 came out of the design review before coding. **All five are implemented;
three were verified against the pinned Codex runtime.**

| # | Decision | Where it lives | Status |
|---|---|---|---|
| A1 | Governed memory lands in `.agents/skills`, never `$CODEX_HOME` | `workspace-memory.ts` | ✅ **verified live** |
| A2 | Shared `./code`: nested bind mount in container, symlink + `--add-dir` local | `container-codex-runner.ts`, `codex-runner.ts` | ⚠️ built, not live-fired |
| A3 | One agent lease shared by solo and group | `agent-service.ts` | ✅ **verified live** |
| A4 | v1 is a fixed five-node sequential chain bound by role; DAG is stretch | `group-chain.ts` | ✅ **verified live** |
| A5 | `freshThread` starts a new Codex thread so landed memory is re-read | `agent-service.ts` | ⚠️ built, not live-fired |

### A1 carries the whole security claim, and it is proven

Against `@openai/codex@0.111.0`:

```text
<workspace>/.agents/skills/<name>/SKILL.md   discovered, scope "repo"
discovery does NOT walk up to parent dirs    isolation holds
a workspace with no skill files              sees none
a git repo                                   not required
$CODEX_HOME/skills/<name>/SKILL.md           scope "user" — GLOBAL to every agent
```

Reproduce with `scripts/verify-codex-skills.sh` — no API key needed.

The counterpart matters as much: this deployment shares one codex-home, so
anything landed there would silently void the claim. Nothing does, and
`verify:live` asserts it.

---

## Proven versus unproven

The honest scoreboard. ✅ means something asserts it — a test, or a reproducible
check against the real runtime.

| Claim | How | Status |
|---|---|---|
| A real group task hands real node output to the real pipeline | `integration-e2e.test.ts` | ✅ proven |
| Landed files sit only in their target agent's workspace | asserted on the filesystem | ✅ proven |
| Approve writes real files; revoke removes them; ledger is append-only | live server round-trip | ✅ proven |
| Codex discovers a landed skill in the granted workspace, not the withheld one | `skills/list` RPC, 0.111.0 | ✅ proven |
| Nothing lands under `$CODEX_HOME` or `shared-code/` | `verify:live` | ✅ proven |
| Production returns 400, not 500, on an invalid body | `app.groups.test.ts` | ✅ proven |
| Solo and group runs never collide on one agent | `agent-service.test.ts` | ✅ proven |
| The Teams UI renders and reads correctly | opened and read by hand | ⚠️ by eye only |
| The five-node chain against **real Codex** | needs `npm run poc` | ❌ unproven |
| Shared `./code` writable from a real `codex exec` | arg builders unit-tested only | ❌ unproven |
| Real Codex spans satisfy the consolidator's validation | fake runner only | ❌ unproven |
| Codex *fires* a discovered skill, rather than merely discovering it | no event exists to observe | ❌ **unprovable** |

### The last row is permanent — say it first

Codex emits **no skill-invocation event**. Confirmed by inspecting the binary:
`skill_invocation` appears only in OpenAI's analytics client, never in the local
`--json` stream. So the audit proves a memory was **available** to one agent and
**withheld** from another. It does not prove the model used it on a given run.

That is why the ledger is written at write time, and why the demo uses explicit
`$skill-name` invocation on stage.

---

## What integration found

Each of these was invisible inside a single workstream and only appeared once
the branches met. They are the argument for integrating early.

**The fake runner emitted zero spans.**
The consolidator requires every note to cite `sourceSpanIds`, and the fake
extractor returns nothing when it finds no span ids. Driven by the fake runner —
the offline demo and test path — the memory pipeline was *structurally incapable
of producing a single note*. Every suite stayed green, because the group-runner
tests assert the hand-off with a recording double and never run the real
pipeline.

**Validation errors returned 500 in production.**
The custom error handler was registered after
`await app.register(fastifyStatic)`, which only runs in production, so it never
took effect there. Every bad input came back as "Internal Server Error" with a
raw ZodError dump. Every existing test builds the app with `NODE_ENV=test` and
skips that path entirely.

**`freshThread` nearly vanished in a merge.**
A5 existed only on Person 1's `agent-service.ts`. Person 2 owns that file and
their version carries the whole group delegation, so the instinctive `--theirs`
resolution drops A5 silently — with the suite still green and the demo's closing
beat quietly dead.

**The seed wrote to the wrong store.**
`loadConfig` only reads `APP_DATA_DIR`; `LOCAL_POC_DATA_ROOT` is a shell-script
concept. So the documented seed command wrote to the repo's `.data/` while the
poc served `~/.volc-agent-launchpad`, and the app showed an empty screen with no
error anywhere.

---

## Deliberately not built

A4 cut these to ship the sequential chain. The **fields** stay in the types so
the upgrade is additive — but the logic is absent, and nobody should describe it
as present.

| Capability | Status | Why |
|---|---|---|
| Branch and join nodes; join-owner selection | stretch | v1 is a straight chain; there are no siblings |
| Parallel-set validation | stretch | One node runs at a time, so nothing can collide |
| Runtime-lock collision validation | stretch | Cannot fire in a sequential chain |
| Runtime-lock **rows** | ✅ built | Kept — legible evidence of file ownership in the UI |

### Two things nobody should claim on stage

```text
"branch context does not leak sibling output"
   Empty. There are no siblings in a sequential chain.

"withheld" in the context viewer
   That field is transcript DE-DUPLICATION, not a governance decision.
   Governance withholding lives in the ledger, where a decision carries a
   reason. The UI labels it "Already seen" for exactly this reason.
```

---

## What tomorrow settles

One real run closes four open claims. **Three fail silently**, which is why the
diagnostic exists.

| Claim | If it fails | Detectable? |
|---|---|---|
| The five-node chain runs against real Codex | Node goes red in the Plan tab | obvious |
| Shared `./code` is writable | Node still says completed; only the directory is empty | **silent** |
| Real spans satisfy the consolidator | Review is empty, exactly as if the feature were broken | **silent** |
| Codex fires a landed skill | The agent answers without the constraint | **silent** |

### The one to watch is the span filter

`shouldIncludeSpan` keeps only `agent_message`, `file_write`, `error`,
**terminal** `reasoning`, and **failed** `command_exec`. If real Codex emits
reasoning spans without `terminal: true`, everything is filtered out, the buffer
has no spans, and you get zero notes with no error anywhere.

`npm run verify:live` names exactly this case, with the counts and the file to
edit. It was validated by **fault injection**, not inspection: four faults were
injected into a healthy store and each produced the correct diagnosis.

### The loop

```bash
# load credentials — ONLY these three, never all of .env
export $(grep -E '^ARK_(API_KEY|MODEL|BASE_URL)=' .env | xargs)

# start; the poc store is already seeded
npm run poc

# run one real task through the UI, then diagnose it
LOCAL_POC_DATA_ROOT=$HOME/.volc-agent-launchpad npm run verify:live
```

`start-local-poc.sh` does **not** read `.env` — only `docker compose` does. And
`.env` carries container paths (`/app/data`, `/app/workspaces`,
`/app/codex-home`) that would send the poc looking for directories that do not
exist on a Mac, which is why only the three Ark variables are exported.

---

## Sources

`ARCHITECTURE.md` · `SPEC.md` · `PLAN.md` · `DECISIONS.md` · `DEMO.md` ·
`MILESTONE_PERSON_1/2/4.md` · `integrationManifestTask2.md` ·
`integrationManifest3.md`

Figures read from the tree at `feat/frontend-qa @ e528493`.
Gate: typecheck · 145 server + 22 web tests · build, all clean.
