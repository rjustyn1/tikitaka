# Diagram Spec — two figures

> Text-first spec so the layout is settled before anything is drawn.
> Nothing here is design. It fixes **what each figure claims**, **every box and
> its exact label**, and **every arrow and its exact label**.
>
> Decisions taken: two distinct bands (orchestration / memory middleware);
> Diagram 1 is a layer stack with the happy path threaded through it; Diagram 2
> is the full memory pipeline with the data shape at every hop; primary reader
> is an engineer-literate hackathon judge.

---

## The boundary, settled

`docs/HACKATHON_EXTENSION_GUIDE.md` is explicit about what was handed to us:

> **Provided baseline** — browser Agent CRUD and Playground · persistent
> workspaces and Codex sessions · one-line Docker/Colima/Podman Runtime ·
> Volcengine Ark model connection · optional ECS deployment.
> *"Rebuilding the UI, control plane, local Runtime, or ECS setup is out of scope."*

So there are **three** categories, not two. The previous diagram collapsed them
and put the Agent runtime inside the middleware band, which was wrong.

| Category | Contents | Drawn as |
|---|---|---|
| **Given** | Web UI shell, Fastify control plane, AgentService, JsonStore, Codex CLI + container runtime, Ark connection | grey, dashed, desaturated |
| **Ours — orchestration** | `AgentGroup` (Teams), `TaskPlanner`, `GroupRunner`, Teams UI surfaces | accent **outline** band, tag `WE BUILT` |
| **Ours — memory middleware** | pre-run context hook, post-run capture hook, topic segmentation, the governed pipeline, landing, ledger | accent **filled** band, tag `THE TRACK` |

The Agent runtime sits **below** both bands and is explicitly labelled unchanged.
That is the point: the middleware brackets the runtime, it does not contain it.

### The two injection mechanisms — keep these separate

This is the distinction the first attempt blurred, and it matters:

| | In-band context packet | Governed memory |
|---|---|---|
| What | group messages + dependency outputs for **this node** | a durable note from a **past** segment |
| Mechanism | built into the turn prompt | a **file written into the workspace** |
| Where | `memory/group-prompt.ts::buildContextPacket()` | `memory/workspace-memory.ts` via `LandingService` |
| Lifetime | one attempt | until revoked (= until the file is deleted) |
| Recorded as | `GroupContextInjection` — `injectedMessageIds` **and** `withheldMessageIds` | `LandedMemoryFile` + `GrantRecord` |
| Who decides relevance | we do, deterministically | Codex's native skill matcher, at read time |

Diagram 1 must show both, as two visually different arrows into the runtime.

---

## Diagram 1 — Where the middleware sits

**Claim (the figcaption, one sentence):**
*One prompt crosses five layers; the two banded layers are what we built, and
the Agent runtime underneath them is untouched.*

**Canvas:** landscape, roughly 1400 × 820. Layers are full-width horizontal
bands; the happy path is a single route with numbered stops crossing them.

### Layout sketch

```
                    ①                                              ⑧
  L0  OPERATOR      │  Web UI shell (given) + Teams surface (ours)  │
  ══════════════════┼═══════════════════════════════════════════════┼════════
                    ▼                                               │
  L1  ORCHESTRATION ┌──────────┐   ┌─────────────┐         ┌────────┴──┐
      [WE BUILT]    │ Teams    │──▶│ TaskPlanner │──▶ ③ ──▶│GroupRunner│──▶ Done
                    │AgentGroup│ ② │ validated   │         │ ready-set │
                    └──────────┘   │ DAG         │         └─────┬─────┘
                                   └─────────────┘               │
  ══════════════════════════════════════════════════════════╪════╪═════════
  L2  MEMORY             ┌──── ④ PRE-RUN HOOK ────┐    ┌─ ⑥ POST-RUN HOOK ─┐
      MIDDLEWARE         │ build context packet   │    │ capture output,   │
      [THE TRACK]        │ record given+withheld  │    │ spans, run rows   │
                         └───────────┬────────────┘    └─────────┬─────────┘
                                     │                           │
                         ┌───────────┴───────────────────────────┴────────┐
                         │  ⑦ TOPIC SEGMENTATION → GOVERNED PIPELINE      │
                         │     ▸ detail in Diagram 2                      │
                         └───────────────────────┬───────────────────────-┘
                                     │           │ ⑧ land file
  ═══════════════════════════════════╪═══════════╪══════════════════════════
  L3  AGENT RUNTIME       ⑤ ┌────────▼───────────▼─────────┐
      (given, UNCHANGED)     │ Backend │ Frontend │ Security│   shared ./code
                             │  each: isolated Codex thread │◀──────────────
                             │  + private workspace         │
                             └──────────────────────────────┘
  ══════════════════════════════════════════════════════════════════════════
  L4  EVIDENCE (JsonStore, given)
      AgentRun · TraceSpan · GroupPlanNode · GroupContextInjection · MemoryNote
      · LandedMemoryFile · GrantRecord
```

### The numbered route — exact arrow labels

| # | From → To | Label on the arrow |
|---|---|---|
| ① | User → Teams | `one prompt to the team` |
| ② | TaskPlanner | `1 model call → validated DAG` (sub: `cycle-checked · indices resolved server-side`) |
| ③ | Planner → GroupRunner | `ready-set · ≤ 4 parallel · lease + lock globs` |
| ④ | GroupRunner → pre-run hook → Agent | `context packet: what it gets, what it is denied` |
| ⑤ | Agent runs | `isolated Codex session` |
| ⑥ | Agent → post-run hook | `output · spans · one run row per attempt` |
| ⑦ | hook → pipeline | `on segment close, or on mid-DAG topic drift` |
| ⑧ | pipeline → workspace | `writes a file — loaded on that Agent's next run` |
| — | GroupRunner → Done | `task settles: completed / partial` |

### Rules for this figure

- **`Done` is fed by the orchestration layer, not by the pipeline.** Memory
  landing happens after and beside the task. If extraction or landing fails the
  task keeps its own outcome. Drawing `⑧ → Done` would state the opposite.
- **Two different arrow styles into the runtime.** ④ is a solid in-band arrow
  (this turn's prompt). ⑧ is a distinct arrow into the *workspace*, labelled as
  a file write, arriving from below/side — not into the same port as ④.
- **L3 carries the tag `given · unchanged`** in the same grey as L1's baseline
  chrome, so the eye reads it as not-ours without needing the legend.
- **The pipeline box in L2 is deliberately one box** with a `▸ Diagram 2`
  pointer. All its internals belong to figure two.
- **Three-key legend, top right:** `given` (grey dashed) · `we built` (accent
  outline) · `the track` (accent filled).

### Excluded from Diagram 1, on purpose

Recognizer thresholds · safety patterns · review policy · ledger fields ·
retry semantics · JS-divergence numbers. All of it lives in Diagram 2 or in the
page prose. If a label needs a number to make sense here, it is at the wrong
altitude.

---

## Diagram 2 — Inside the governed pipeline

**Claim (the figcaption, one sentence):**
*A note starts as extracted text with no recipient and only becomes memory in
one Agent's workspace after routing, redaction, and — in the default
configuration — a human; every stage that drops a note records why.*

**Canvas:** portrait-ish, roughly 1100 × 1400. A single vertical spine down the
centre, a **data-shape gutter** on the right, and **drop-out branches** to the
left. One spine, no folds.

### Layout sketch

```
   TRIGGERS  ┌ mid-DAG: node-level embedding drift  ┐
             │   runMemoryPipeline(segId, nodeIds)  │
             │ segment close: JS-div ≥ 0.9 · 8 tasks│
             │   · 120k chars · idle sweep          │
             └───────────────────┬──────────────────┘
                                 ▼
  drop-outs ◀───┐   ┌─────────────────────────┐   ┌─ data shape ────────────┐
                │   │ 1  SegmentBufferBuilder │   │ SegmentBuffer{          │
                │   │    replays the store    │──▶│  prompts[], messages[], │
                │   │    no 2nd transcript    │   │  nodeOutputs[], runIds[]│
                │   └────────────┬────────────┘   │  spans[], injections[] }│
                │                ▼                └─────────────────────────┘
  no durable    │   ┌─────────────────────────┐   ┌─────────────────────────┐
  notes /       │   │ 2  Consolidator         │   │ CandidateNote{          │
  invalid JSON ◀┼───│    1 extractor call     │──▶│  content ≤2000, severity│
  / timeout     │   │    ≤ 8 declarative notes│   │  skillKey, description, │
                │   └────────────┬────────────┘   │  srcRunIdx[], srcSpanIdx│
                │                │                │  [], rationale }        │
                │                │  1-based indices → real ids, server-side │
                │                ▼                └─────────────────────────┘
  recognizer    │   ┌─────────────────────────┐   ┌─────────────────────────┐
  error →       ◀───│ 3  Recognizer — agents  │──▶│ + recipients[], scores[]│
  WITHHELD      │   │    cosine ≥ 0.35        │   │   matchKind: direct|    │
  (never guess) │   │    else 1 top = fallback│   │   fallback              │
                │   └────────────┬────────────┘   └─────────────────────────┘
                │                ▼
  key collides  │   ┌─────────────────────────┐   ┌─────────────────────────┐
  with unrelated◀───│ 4  Recognizer — skills  │──▶│ MemorySkillAssignment   │
  skill →       │   │    per recipient, reads │   │  { existing | proposed }│
  WITHHELD      │   │    only THEIR skill dir │   └─────────────────────────┘
                │   │    ≥ 0.45 → existing    │
                │   └────────────┬────────────┘
                │                ▼
                │   ┌─────────────────────────┐   ┌─────────────────────────┐
                │   │ 5  Safety               │──▶│ redacted note +         │
                │   │    redact → quarantine  │   │ SafetyFinding[]         │
                │   │    error ⇒ quarantine   │   └─────────────────────────┘
                │   └────────────┬────────────┘
                │                ▼
  REJECTED ◀────┤   ┌─────────────────────────┐   ┌─────────────────────────┐
  PENDING  ◀────┼───│ 6  ReviewService        │──▶│ status: active |        │
  QUARANTINED ◀─┘   │    persist, then gate   │   │ pending | quarantined   │
                    └────────────┬────────────┘   └─────────────────────────┘
                                 ▼
                    ┌─────────────────────────┐   ┌─────────────────────────┐
                    │ 7  LandingService       │──▶│ LandedMemoryFile        │
                    │    the ONLY writer      │   │  path + managed block   │
                    └────────────┬────────────┘   └─────────────────────────┘
                                 ▼
                    ┌─────────────────────────┐   ┌─────────────────────────┐
                    │ 8  Ledger (append-only) │──▶│ GrantRecord{ grantedTo, │
                    └────────────┬────────────┘   │ withheldFrom + reason,  │
                                 │                │ humanDecision }         │
                                 ▼                └─────────────────────────┘
                    ══ file on disk in ONE workspace ══
                                 │
                                 ▼  read time, next run
                    Codex's own matcher decides if it applies
```

### Stage cards — exact content

**1 · SegmentBufferBuilder.** Reads back from `JsonStore`: ordered task prompts,
human and Agent group messages over the segment's sequence range, completed plan
node outputs in execution order, run ids, trace spans, persisted
context-injection metadata. *Callout:* `reconstructed from persisted state —
there is no second live transcript store.`

**2 · Consolidator.** One extractor call per closed segment, at most eight
declarative durable notes. Fields as in the gutter. *The critical mechanic to
draw:* the model emits **1-based short indices**, never UUIDs; the server
resolves them to real `sourceRunIds` / `sourceSpanIds` and **drops bad or
duplicate citations**. Drop-out: timeout, invalid JSON, or no durable notes →
no memory for this segment, and the task outcome is untouched.

**3 · Recognizer, agent routing.** Sole recipient-selection authority. Embeds
`description + content`, compares against every Agent that participated anywhere
in the segment, profile = `name + description + instructions`. Takes all at or
above `MEMORY_RECOGNITION_AGENT_THRESHOLD` (0.35). If none cross, exactly one
top scorer as a declared **fallback** — and a fallback forces human review
downstream, so draw that as a marked edge into stage 6, not just a note.
Drop-out: recognizer error → withheld, never guessed.

**4 · Recognizer, skill routing.** Per recipient, reads **only that Agent's own**
`.agents/skills/*/SKILL.md` metadata. `≥ 0.45` → append as a managed block to
that existing skill; otherwise propose a new skill from the consolidator's
`skillKey` + `description` — and a proposed new skill also forces review.
Drop-out: proposed key collides with an unrelated existing skill → withheld
rather than implicitly merged. *Callout:* `never searches another Agent's skill
directory in order to place a memory.`

**5 · Safety.** Runs before review and before any filesystem write. Redaction
replaces bearer tokens, private keys, database URLs, env assignments and long
key-shaped tokens with `[REDACTED_SECRET]`, in both content and description.
Quarantine flags instruction override, hidden-prompt / secret requests, safety
disablement, and exfiltration shapes. *Callout:* `if safety itself errors, the
note is quarantined — it never fails open.`

**6 · ReviewService.** Persists every candidate, then activates or parks it.
Draw the six review triggers as a small stacked list feeding the gate, because
this is the governance claim:
`severe` · `redaction fired` · `quarantine fired` · `fallback routing` ·
`any recipient needs a new skill` · `REVIEW_ALL_SKILLS=true`.
Plus the configuration fact: `MEMORY_RECOGNIZER=sbert` is review-first unless
`MEMORY_AUTO_GRANT_ENABLED=true`. Human actions: approve · edit · reject ·
revoke. **Recipient boundary, drawn as a hard edge on the edit path:** an edit
may narrow routing or move it between members; it can never widen outside the
note's own group — enforced twice, before an edit is persisted and again at
activation.

**7 · LandingService.** Exactly one module writes governed memory to disk.
`severe → <workspace>/AGENTS.md` (managed block, always in context).
`normal → <workspace>/.agents/skills/<skillKey>/SKILL.md` (managed block, loaded
when relevant). Revocation deletes the block or the placement.

**8 · Ledger.** Append-only. Per note: granted-to, **withheld-from with a named
reason**, and the human decision. The withheld list is the part nothing else
shows — give it visual weight equal to the grant.

### Two side panels

**Panel A — the trust split** (small, bottom-left, two rows):

| | enforced by | when | nature |
|---|---|---|---|
| who may receive | file placement | write time | deterministic, ours |
| when it applies | Codex skill matching on `description` | read time | model-driven, Codex's |

**Panel B — the resume path** (small, bottom-right, one arrow):
`resetAutoNotes(groupTaskId)` → revokes this segment's auto notes, **retains
human decisions**, reopens the segment so the fuller later result is
consolidated instead. Draw it as a dashed return arrow from stage 8 back to the
trigger block.

### Rules for this figure

- Every drop-out branch exits **left** and terminates in a labelled outcome
  chip; no drop-out is left as a dangling arrow.
- The right gutter is a fixed-width column; every stage has exactly one gutter
  entry, so the eye can read the data transformation as a column on its own.
- Thresholds appear as literal numbers (`0.35`, `0.45`, `≤ 8`, `≤ 2000`), not as
  prose. This is the figure where numbers belong.
- Real type names are used in the gutter (`SegmentBuffer`, `CandidateNote`,
  `MemorySkillAssignment`, `LandedMemoryFile`, `GrantRecord`); stage titles stay
  plain-language so a judge can read the spine without the gutter.

### Excluded from Diagram 2, on purpose

Planner and runner internals · parallelism, leases, locks, retries · the shared
`./code` tree · the UI surfaces. All of that is Diagram 1's altitude.

---

## Source of truth for every claim above

| Claim | File |
|---|---|
| context packet + given/withheld record | `memory/group-prompt.ts:34`, `memory/group-runner.ts:729` |
| two pipeline triggers | `memory/group-runner.ts:1091` (mid-DAG, `nodeIds`), `:1153` (segment close) |
| pipeline order | `memory/pipeline.ts:113` → `routeCandidate` → `assignSkills` → safety → `review.processCandidate` |
| governed memory is a file, not a prompt | `memory/workspace-memory.ts` — *"the ONLY place governed memory is written to disk"* |
| thresholds and caps | `config.ts:45,51,52,53,83,84,87` |
| resume path | `memory/pipeline.ts:232` `resetAutoNotes` |
| baseline vs ours | `docs/HACKATHON_EXTENSION_GUIDE.md` §"Provided baseline" |
