# TIKI-TAKA — Governed Cross-Agent Memory

### Agents pass what they learn. Nothing passes unwatched.

---

> **09:14** — Your Security Agent tells the team: *"The frontend only needs the
> public API contract. Do not expose backend env values."*
>
> **09:41** — Different task. Different session. A user asks the Backend Agent to
> help the frontend integrate an upload endpoint.
>
> **09:41** — The Backend Agent has never heard of that rule. It never will.
> It hands over the `.env` block.

Every multi-Agent platform on the market has this bug. It isn't a model failure —
the Security Agent was right, and it said so clearly. It's an **infrastructure**
failure. There was no path for that sentence to travel, and no one was ever going
to notice it hadn't.

TIKI-TAKA builds that path — and puts a customs desk on it.

---

## Inspiration

### The bug that every agent platform ships with

The Starter Kit gives every Agent its own Codex session, its own workspace, its
own thread. That is a *good* default — isolation is why one Agent's mess doesn't
become everyone's mess. It's also why nothing an Agent learns ever escapes.

Carryover *inside* one Agent is free: its thread resumes every turn. Carryover
*across* Agents is impossible, because no shared path exists. Every team of
Agents is really a room full of brilliant specialists with their ears covered.

### Why the obvious fix is worse than the problem

"Just share the transcript." We thought it through. It fails three ways at once:

| The naive fix | What actually happens |
|---|---|
| Dump the group transcript into every Agent | **Scope leak** — the Security Agent's incident notes land in the intern-tier Agent's context |
| Give everyone everything, always | **Role drift** — a Frontend Agent that has read every backend debate starts writing backend opinions |
| Keep appending | **Unbounded prompt** — cost and latency grow with team history, forever |

And it still answers the wrong question. The gap is not *memory*. Plenty of
products do memory. The gap is **governed** memory:

- **capture** with provenance — which run, which spans
- **decide** who may receive what
- **land** it where the Agent will actually use it
- **prove** both the grant *and the denial*

### The question nobody else answers

| Category | Answers | Doesn't answer |
|---|---|---|
| Observability / tracing | *What did the agent do?* | who was allowed to know what |
| Consumer memory products | *What does this user's assistant remember?* | every chat sees everything — no way to grant to one agent and withhold from another |
| RAG over a team wiki | *What's relevant to this query?* | relevance ≠ permission; retrieval has no idea who is asking or whether they should be |
| **TIKI-TAKA** | **What did this Agent know, what was it denied knowing, and why?** | |

That last row is the whole product. We could not find it anywhere else, and once
you have agents acting on each other's conclusions, you cannot ship without it.

---

## What it does

Put 2–8 Agents on one goal over one shared `./code` tree. TIKI-TAKA sits between
the orchestrator and the runtime and does six things.

**1 · Plans.** One model call turns your prompt into a validated dependency
graph — who does what, in what order, over which files. Not a chain. A real DAG
with fan-out and joins.

**2 · Schedules.** Independent branches run *in parallel*, under Agent leases and
directory locks, so two Agents never fight over the same tree. A failure blocks
only its own descendants; sibling branches finish.

**3 · Injects.** Before each node runs, TIKI-TAKA builds precisely the slice of
conversation that node hasn't seen — and persists that window **before** Codex
starts, so a crash mid-run still leaves a record of what the Agent was about to
be shown.

**4 · Captures.** Every trace span streams to the store as it happens. Each retry
is its own run row, so two attempts read as two real runs in the audit — not one
blurred entry.

**5 · Governs.** When a *topic segment* closes, the pipeline extracts durable
notes, decides which Agents may receive each one, redacts secrets, routes
anything risky to a human, and writes the approved note into the chosen Agent's
private workspace.

**6 · Proves.** A ledger records who received it, **who was denied and why**, and
the human decision.

### Back to 09:41

Now the Security Agent's rule is a note. Recognition scores it against every
Agent that was in the room and routes it to Backend — and *only* Backend. Safety
redacts anything secret-shaped. A human approves it. Landing writes it into
`workspaces/backend/.agents/skills/api-contract-boundaries/SKILL.md`.

At 09:41 the Backend Agent loads that skill because Codex's own matcher decides
it's relevant, and answers with the public contract. The Frontend Agent, which
scored below threshold, never received the file — and the ledger says so, with a
reason.

**The Agent behaves as if it learned from a meeting it wasn't in. Nothing was
fine-tuned. Nothing leaked.**

### The idea that makes it defensible

Most "agent permissions" demos are a prompt that says *please don't share this*.
That is not a boundary; that is a wish. Ours splits into two questions with two
different mechanisms:

|  | Enforced by | When | Nature |
|---|---|---|---|
| **Who may receive a memory** | file placement | write time | deterministic — **ours** |
| **When a memory applies** | Codex's own skill matching | read time | model-driven — **Codex's** |

Exactly one module writes governed memory into a workspace. Severe notes become a
managed block in that Agent's `AGENTS.md`; normal notes a managed block in a
private `.agents/skills/<key>/SKILL.md`.

> **If landing never wrote the file, Codex cannot load it. The file is not there.**

There is no clever prompt to jailbreak, because there is no prompt. Because
there's one choke point, live grant state isn't a database claim — it's the set
of files on disk, inspectable at any moment. Revoking a memory means deleting a
file.

### And we verified it instead of asserting it

Against the pinned runtime `@openai/codex@0.111.0`:

- ✅ a skill written to `<workspace>/.agents/skills/` is discovered at `scope: "repo"`
- ✅ discovery does **not** walk up to parent directories
- ✅ a workspace with no skill files sees **none**

```bash
./scripts/verify-codex-skills.sh     # reproduces all three · no API key needed
```

Run it at our booth. It takes seconds and it needs nothing from us.

---

## How we built it

**Stack.** TypeScript end to end. Fastify control plane, React + Vite operator
UI, Codex CLI in a disposable container per turn, Volcengine Ark for planning and
extraction, a local 87 MB SBERT checkpoint for routing, JSON store for evidence.

**Shape.** Five layers. The middleware *brackets* the Agent runtime rather than
containing it — the Agents themselves are the platform's, untouched.

```
Operator        User ──▶ Web UI                                       given
──────────────────────────────────────────────────────────────────────────────
Orchestration   Teams ──▶ Planner ──▶ Runner ──▶ Settle ──▶ Done     we built
──────────────────────────────────────────────────────────────────────────────
Memory          Inject context    Capture   ──▶   Memory pipeline    THE TRACK
middleware            │              ▲                    │
─────────────────────  │ ──────────── │ ─────────────────  │ ─────────────────
Agent runtime   Codex CLI + Docker ───┘          Workspaces ◀┘         given
                (isolated session per Agent)      ✓ granted · ✕ withheld
──────────────────────────────────────────────────────────────────────────────
Evidence        JsonStore — runs · spans · plan nodes · injections    given
                · notes · landed files · grants
```

Two arrows reach the runtime and they are **deliberately different**: the context
packet is in-band and lasts one turn; a landed note is a *file on disk* that
Codex loads on a later run and that survives until revoked. Conflating them is
the mistake we spent the most effort not making.

### Planning — never trust a model with an identifier

The planner emits up to eight nodes using *small integer indices* for Agents and
dependencies. Never UUIDs. Never file paths. Each node carries an Agent index,
dependency indices, an instruction, an expected output, a work area and a write
intent — and the server resolves and rejects before anything is persisted:

| Rejected | Why it matters |
|---|---|
| empty instruction | a node with nothing to do burns an Agent lease |
| unknown Agent index | the model inventing a teammate |
| invalid / duplicate / self dependency | silent graph corruption |
| any cycle | the scheduler would deadlock |
| out-of-range node count | unbounded fan-out |

Work areas map through a **server-owned allowlist** into file-ownership hints and
runtime locks, so the model proposes *intent* and the platform decides *paths*.
An `AgentGroup.description` reaches the planner as a `# Team context` heading
above the task — additive, so a group with no description emits no heading at
all. Role assignment and Agent assignment are decided together, in that same
single call.

If planning fails or returns something invalid, the runtime falls back to a
deterministic sequential plan — one node per member. A bad model response
degrades the plan; it does not break the run.

### Execution — parallelism you can actually trust

A ready-set scheduler walks the DAG. Three separate mechanisms hold under
concurrency, and each one was added because the naive version was wrong:

**Ordering.** Kahn's algorithm, tie-broken on the planner's own ordering. We
deliberately did *not* reuse `task-buffer.ts`'s `topologicalSort()`, which
tie-breaks on `completedAt` then id — on a fresh run nothing has completed, so it
would order the graph by UUID.

**Agent safety.** Two nodes for the same Agent never overlap. The lease is not
re-entrant, and the planner may legitimately hand one Agent several nodes.

**File safety.** Lock keys are *globs*, so string equality isn't enough:
`code/**` contains `code/apps/server/**`. Both sides reduce to a directory prefix
and are compared for containment in **either** direction. Read-only nodes declare
no locks and never block. This implements the runtime-lock collision validation
the original architecture deferred as a stretch goal.

**Width.** `GROUP_MAX_PARALLEL_NODES`, default 4. Set it to 1 and you get
strictly sequential execution with zero code change.

**Failure containment.** A failing node blocks only nodes with a failed
*transitive ancestor*. Sibling branches keep running. A skipped node records
**which** node blocked it, replacing a blanket "an earlier node did not complete"
that was simply false for a node on an unrelated branch. Crucially,
`findFailedAncestor()` is exported and shared with the flush trigger, so the
runner and the memory trigger *cannot disagree* about which nodes a failure
blocks. We kept the status as `cancelled` rather than adding `blocked`, because a
new terminal value would have rippled into the terminal-status set, the DTO, the
web mirror type and every status pill.

**Retries.** `attempts` is persisted **before** each dispatch, so a restart
resumes the count rather than restarting it. Every attempt is its own run row
with its own spans and its own context injection. `isRetryableFailure()` defaults
to **not** retrying:

| Retried | Not retried |
|---|---|
| timeouts · connection resets · non-zero exits · an Agent still holding an active process | a run that answered badly · output-size overflow · `ENOENT` |

Cap is 2. A human-triggered resume clears `attempts`, so an exhausted node can
run again — and resume re-runs branches that were *blocked*, not just the node
that failed, clearing the blocked reason rather than leaving it stale on a
now-successful node.

### Context injection — a window, not a filter

Every group message carries a `seq`. When a node becomes runnable the runner
freezes an upper bound, `contextSnapshotSeq`. The node then receives exactly

```
lastSeenSeq  <  seq  ≤  contextSnapshotSeq
```

plus its dependencies' outputs, plus whatever governed memory already sits in its
workspace. The whole window is persisted as a `GroupContextInjection` —
`fromSeqExclusive`, `toSeqInclusive`, `injectedMessageIds`,
`injectedDependencyNodeIds`, `withheldMessageIds` — **before Codex starts**, so a
crash mid-run still leaves an auditable record of what the Agent was about to be
shown.

One subtlety we got right on the second try: the node's *role* travels in the
per-turn prompt, not in `AGENTS.md`. A resumed Codex thread may never re-read a
changed instructions file, so identity for **this turn** has to ride with the
prompt. The stable Agent identity is never overwritten — an Agent is *given* a
node role; it does not *become* a different Agent.

### Capture — live, not post-mortem

An `onSpan` callback pushes each trace span into the store as it happens, so the
UI follows a run in flight. On settle, the run row closes with the output and a
computed trace summary. The live terminal merges every running node's feed and
sorts by **timestamp**, not `seq` — because `seq` restarts per run, and ordering
a merged feed by it would interleave two Agents as 1,1,2,2.

### Segmentation — consolidate threads of work, not turns

The unit of consolidation is a **TopicSegment**: consecutive tasks for one team
while the subject holds. It closes on one of four boundaries:

| Boundary | Trigger |
|---|---|
| `topic_shift` | Jensen–Shannon divergence over prompt topics exceeds the threshold (0.90) |
| `size_cap` | 8 tasks, or 120 000 characters |
| `idle` | no activity for 30 minutes — swept lazily on the next group read |
| mid-DAG | node-level embedding drift inside a single task consolidates the accumulated nodes early |

Only a **closed, unflushed** segment whose contained tasks have all **settled**
enters memory processing. That gives the extractor a whole thread of work instead
of one turn, without keeping a permanent team transcript.

`SegmentBufferBuilder` then reconstructs the input entirely from persisted state —
ordered prompts, human and Agent messages over the segment's sequence range,
completed node outputs in execution order, run ids, trace spans, context-injection
metadata. There is no second live transcript store to drift out of sync.

### Consolidation — the note contract

One extractor call per closed segment, at most eight declarative durable notes:

| Field | Meaning |
|---|---|
| `content` | reusable fact, decision, constraint or lesson · max 2 000 characters |
| `severity` | `normal` or `severe` — severe is always-on once approved |
| `skillKey` | kebab-case topic key · **never** treated as a filesystem path |
| `description` | the future-task relevance trigger Codex will match against |
| `sourceRunIndices` / `sourceSpanIndices` | **1-based short integers**, not UUIDs |
| `rationale` | why this is worth retaining |

The model is never asked to copy an identifier. The server resolves those small
indices to real `sourceRunIds` and `sourceSpanIds`, dropping bad or duplicate
citations rather than accepting arbitrary strings. Timeout, invalid JSON or no
durable notes ⇒ no memory this segment — and the task outcome is untouched.

### Recognition — two-stage routing, and the only routing authority

**Stage one, who.** Build an Agent profile from name, description and
instructions. Embed the note's `description + content`. Score against every Agent
that participated *anywhere* in the segment. Take everyone at or above the
calibrated threshold. If nobody clears it, take exactly one top scorer and mark
`matchKind: fallback` — which forces human review downstream. A recognizer error
withholds the note; it never guesses.

**Stage two, where.** Per recipient, read **only that Agent's own**
`.agents/skills/*/SKILL.md` metadata. At or above the skill threshold the note
joins that existing skill as a managed block; otherwise it proposes a new skill
from the consolidator's `skillKey` and `description` — which also forces review.
A proposed key that collides with an *unrelated* existing skill is withheld
rather than implicitly merged. The system never searches a different Agent's
skill directory in order to place a memory.

Providers are `sbert | ark | fake | off`, and SBERT is **not** silently replaced:
if the checkpoint directory, the Python bridge or the weights are missing —
including an un-pulled LFS pointer — startup fails with a configuration error.
The runtime never downloads a model and never makes an implicit network call.

### Safety — fails closed, on purpose

Redaction rewrites bearer tokens, private keys, database URLs, environment
assignments and long key-shaped tokens to `[REDACTED_SECRET]`, in both content
and description. The quarantine heuristic flags instruction override,
hidden-prompt and secret requests, safety disablement, exfiltration and
suspicious shell shapes. Both run **before review and before any filesystem
write**. If safety itself throws, the note is quarantined. There is no path where
an error results in a write.

### Review — six triggers, and a boundary enforced twice

A candidate requires a human when **any** of these hold:

`severe` · `redaction fired` · `quarantine fired` · `routing used a fallback` ·
`any recipient needs a new skill` · `REVIEW_ALL_SKILLS=true`

On top of that, startup forces review-first whenever a real recognizer is active,
unless `MEMORY_AUTO_GRANT_ENABLED=true` — because a checkpoint calibrated on
synthetic labels has no business granting memory unattended.

The operator can approve, edit, reject or revoke. **An edit may narrow routing or
move it between members; it can never widen it outside the note's own group.**
That is enforced in two places — against the proposed recipients before an edit
is persisted, and again at activation, which every landing path crosses. A
refused edit is never stored, so a later plain approve cannot quietly pick it up.

### Landing and the ledger

Severe → a managed block in the recipient's `AGENTS.md`. Normal → a managed block
in a private `SKILL.md`. Managed-block helpers are shared with the workspace
writer, so regenerating an Agent's instructions preserves governed memory
byte-for-byte. Revocation removes that note's specific block or placement and
records the revocation.

The filesystem *is* the availability state: a note is injected only while its
active landing record's file still contains the note's managed block. The ledger
proves this middleware granted, withheld, rejected or revoked a note — one
append-only `GrantRecord` per note, carrying who received it, who was denied and
**why**, and the human decision.

### Resume, and not lying about it

Resuming partial work calls `resetAutoNotes()`: it revokes the segment's
*automatic* notes, **retains every human decision**, and reopens the segment so
the fuller later result is consolidated instead of a stale partial one.

### Persistence

`JsonStore` writes a versioned `launchpad.json` through serialized mutation,
temp-file write and atomic rename. Persisted records: `Agent`, `Message`,
`AgentRun`, `TraceSpan`, `AgentGroup`, `GroupTask`, `GroupParticipantState`,
`GroupPlanNode`, `GroupMessage`, `GroupContextInjection`, `GroupRuntimeLock`,
`TopicSegment`, `MemoryNote`, `MemorySkillAssignment`, `LandedMemoryFile`,
`GrantRecord`. Shared code is keyed by **group**, not task, so a team's codebase
persists across prompts — task two continues what task one left, instead of an
Agent reading that it had built something while `./code` sat empty.

---

## Challenges we ran into

**Tests that passed for the wrong reason.** Our first parallelism test counted
cumulative requests — which cannot distinguish "ran together" from "ran one after
the other." It gave us **three false passes** before we replaced it with a probe
recording *peak in-flight runs*. Disjoint areas peak at 2; overlapping locks at
1; same-Agent at 1; a cap of 1 at 1. We had shipped-feeling confidence in a
feature that wasn't proven.

**Code that was correct by accident.** Execution order came from a `createdAt`
sort — but the planner stamps every node of a task with the *same* timestamp. The
order survived only because V8's sort happens to be stable. It would have broken
silently on another engine.

**A distinction we nearly got wrong in our own diagram.** `withheldMessageIds`
means *already seen by this Agent, or not yet visible* — transcript
deduplication. It is **not** a policy denial. We caught ourselves labelling it as
one in an architecture diagram. Governance withholding lives in the ledger with a
named reason, and conflating the two would have misrepresented the entire system
to anyone reading the picture. The code now carries a comment forbidding it.

**Knowing when to stop trusting the model.** Early on we asked the extractor to
name its own recipients. It is fluent, confident, and wrong often enough to
matter — and a wrong recipient is a leak, not a typo. Splitting extraction from
routing, and making routing an embedding comparison against real Agent profiles,
is the single change that turned this from a demo into something defensible.

**Calibrating a recognizer on synthetic data.** Our checkpoint was trained on
synthetic labels, so its threshold isn't transferable and its confidence isn't
trustworthy alone. We could have shipped a number and hoped. Instead the system
forces review-first whenever a real recognizer is active, and auto-grant sits
behind a flag that stays off until someone recalibrates against human labels.
**The measured shortfall is why the gate exists.**

**Seeded data that lied.** Our demo seed hand-wrote a five-node straight chain
with no instructions, bypassing the planner entirely — so the demo showed a
system that did not exist. The seed now builds its plan through the *production*
planner functions, so seeded rows cannot drift from planner output again.

**A CSS bug that took longer than the scheduler.** A global `input { width: 100% }`
written for text fields was inherited by checkboxes, which stretched, and the
browser painted the tick centred inside that stretch — a different position on
every row. Distributed systems are hard; CSS is harder.

---

## Accomplishments that we're proud of

- **A security boundary that is inspectable, not asserted.** Live grant state is a
  set of files, and a script proves the runtime honours it. No trust required.
- **An audit that records denials with named reasons**, not just grants. This is
  the part nothing else we found shows — and the part an auditor asks for first.
- **Real parallel DAG execution** with lease safety, glob-lock containment,
  transitive failure blocking and resumable retries — proven by a peak-concurrency
  probe rather than a hopeful assertion.
- **One writer, one boundary.** Every governed byte on disk went through a single
  module, which is why "who can know what" is answerable at all.
- **Non-fatal by construction.** Extraction, routing, redaction and landing can
  every one of them fail, and the group task still keeps the outcome it earned.
- **A team that shipped its own limitations**, written down before anyone asked.
- `npm run check` clean: **235 server tests / 22 files · 75 web tests / 12 files**,
  plus builds for both workspaces.

---

## What we learned

**Extracting is not granting.** Two different questions deserve two different
mechanisms, and the moment we stopped letting one model answer both, the design
got simpler and the claims got smaller and truer.

**Placement beats permission strings.** The instinct is to build a policy engine.
The better answer was to make the filesystem *be* the policy — a file that was
never written cannot be read, no matter what any prompt says.

**Sharing a rule beats sharing a check.** The runner and the flush trigger once
had their own opinions about which nodes a failure blocks. Exporting one function
and using it in both places removed an entire category of bug we would otherwise
have discovered in a demo.

**Honesty is a feature.** So we'll say plainly what we don't claim: we cannot
prove a memory *fired* on a given run, because Codex emits no skill-invocation
event — the audit proves a note was *available* to one Agent and *withheld* from
another, not that the model used it. Revocation takes effect on the next run, not
inside a live thread. Redaction is pattern-based and cannot catch every shape of
secret. Review records attribution, not authentication, because the platform is
single-user with no identity system. On Docker Desktop for Mac the Landlock
sandbox is unavailable, so we do not claim OS-enforced isolation between Agents.
And the JSON store is not a transaction database for concurrent instances.

Writing that list was more useful than any feature we shipped — it's also the
roadmap.

---

## What's next for TIKI-TAKA

**Near term — close the gaps we named.**

- A human-labelled evaluation holdout and a documented model-promotion policy, so
  automatic grants can be switched on with evidence instead of optimism.
- Transactional database persistence and a durable queue, replacing the
  single-writer JSON store.
- Authenticated reviewer identity and immutable audit storage, so the ledger
  records who *did* approve rather than who *claims* to have.
- Redaction and quarantine promoted from heuristics into a tested policy service
  with telemetry and an incident workflow.

**Where this goes.** Every organisation deploying agents is about to discover that
agents talking to each other is a data-governance event, not a feature. When that
lands, "which agent may know what, and prove it" stops being a nice-to-have and
becomes an audit requirement. TIKI-TAKA is that layer, and it is designed to sit
under someone else's orchestrator — the boundary is a filesystem, not our API.

We built it for a hackathon. We'd bet on it in production.

---

**Built with:** typescript · node.js · fastify · react · vite · vitest ·
openai-codex · volcengine-ark · byteplus · sentence-transformers · sbert ·
python · docker · podman · colima · terraform · json · markdown · git-lfs ·
jensen-shannon-divergence · cosine-similarity · dag-scheduling
