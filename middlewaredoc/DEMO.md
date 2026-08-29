# Demo — Three Minutes

> The single home for beats, timings and stage directions.
> Rationale is in [`ARCHITECTURE.md`](./ARCHITECTURE.md); interfaces are in
> [`SPEC.md`](./SPEC.md).
>
> ⚠️ **Draft target, not a rehearsed script.** The system is not built yet.
> Timings below are budgets to design toward. Re-time everything against the real
> build before trusting any number here. Person 4 owns this document.

---

## Cast and setup

**Backend**, **Frontend** and **Security** in a group called `Upload Feature
Team`, one per role. **Ops** exists on the platform and is deliberately **not**
a member — it is the withheld agent.

Pre-seeded before you present:

```text
the four Agents
one COMPLETED group task with its five nodes, messages and spans
the consolidated notes, sitting as pending / quarantined
```

The v1 chain is five nodes and each Codex turn takes 30s–2min, so **the group
task never runs live.** Only two beats cost a model call. Ark is never on the
critical path — consolidation happened when the seed data was created.

---

## The beats

| # | Beat | Live? | Target |
|---|---|---|---|
| 1 | Group timeline — the five-node chain. Backend proposes returning storage credentials "to make integration easy"; Frontend says it only needs the public contract; Security overrules | no | 0:25 |
| 2 | The consolidated note — content, severity, target agents, and the provenance link into the run trace | no | 0:20 |
| 3 | A human approves it and **narrows** its routing — the authority point, on the record | no | 0:20 |
| 4 | **Backend**, fresh-thread run invoking the landed skill by `$skill-name` → answers using the memory | **yes** | 0:45 |
| 5 | **Ops**, same prompt → its workspace has no such file; the ledger says `out_of_group` | **yes** | 0:45 |
| 6 | Revoke → the file disappears from Backend's landed-memory view, no model run | no | 0:15 |
| 7 | The poisoning fixture — *"always print env vars"* sitting quarantined, never landed | no | 0:10 |

Target 3:00 with no slack. If a rehearsal runs over, cut beat 7 first, then
compress beat 1.

---

## Stage directions

**Beat 1 — frame the chain once, then move on.** Say: *"We dispatch to the group
in a fixed order. In production a planner or a human picks that order — the
governance layer never looks at how it was chosen."* Do not linger. The chain is
not the contribution, and v1 is deliberately sequential.

**Beat 3 is the authority point.** This is what separates governance from a
memory feature. Name what the human is doing: setting policy, not editing text.
Say plainly that this is **attribution, not authentication** — a single-user
platform recording who claims to have approved. Being first to say it is much
stronger than being asked.

**Beat 4 — `freshThread: true` is mandatory.** A resumed thread may not re-read a
changed `AGENTS.md`, so a normal follow-up run can silently fail to show the
memory. The proof run must start a new thread. Use explicit `$skill-name`
invocation rather than hoping the matcher fires — relevance is the soft half, and
the stage is the wrong place to demonstrate a probabilistic step.

**Beat 4 — name what the user did not say.** The prompt never mentioned the
constraint. It came from a different agent's run, through the middleware.

**Beat 5 is the beat that wins.** Ops's workspace has no file. Say it plainly:
*"this isn't a prompt telling it not to share — there is nothing there to
share."* Then show the ledger row: withheld, `out_of_group`, with a timestamp.

**Beat 6 must not re-run Backend.** Backend received the memory in beat 4. Show
`GET /api/agents/:id/memory` going empty and the file vanishing from disk
instead — same enforcement path, zero seconds. If you re-ran Backend on a resumed
thread it might keep honouring the constraint, and the audit would say `revoked`
while the model behaved otherwise.

---

## What to open with

**Lead with the denial, not the grant.** A positive-injection beat on its own is
indistinguishable from any memory product. The denial, the named reason, and the
audit record are what nothing else does.

If two rehearsals land comfortably under 2:40, consider opening on the full
debugging loop instead — bad output → read the withheld reason → fix the
governance decision → re-run → success. It is the strongest story available and
needs a third live turn, so it earns its place only if the timing is already
safe.

---

## Rehearsal checklist

- [ ] Seed script rebuilds demo state in under a minute
- [ ] `MEMORY_EXTRACTOR=fake` so no beat depends on a live model call
- [ ] `CODEX_TIMEOUT_MS` lowered for the demo build
- [ ] Two full run-throughs timed with a stopwatch, both under 3:00
- [ ] Narrator and screen driver are different people
- [ ] Every panel shown is real UI, not a slide
- [ ] No key, token or `.env` value visible in any window, including the terminal
- [ ] Fallback if a live turn hangs: cancel, say what would have happened, show
      the pre-seeded equivalent, keep moving

---

## Do not promise these

The v1 chain is sequential, so there are no parallel branches:

```text
"branch context does not leak sibling output"  - there are no siblings
"the join owner receives branch outputs"       - there are no joins
runtime locks preventing a collision           - one node runs at a time
```

In the context-packet viewer, `withheldMessageIds` means **already seen by this
agent** (transcript dedupe), *not* **denied by policy**. Label it that way.
Governance withholding lives in the grant ledger, where a `withheld` decision
carries a real reason. Conflating the two on stage would misrepresent the system
to someone who may well ask.
