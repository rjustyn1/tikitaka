# Middleware Documentation

Governed cross-agent memory: agents earn knowledge in isolated Codex sessions and
lose it. This middleware captures that knowledge from a shared task, governs who
may receive it, lands it as native Codex memory in the right agents, and records
every grant and denial.

> `../docs/` belongs to the organizers and is left exactly as shipped. Everything
> we write lives here.

---

## The map

Each document answers **one** question. Read the one that matches your question.

| Document | The one question it answers | Never contains |
|---|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | **Why** is it built this way? What are the honest limits? | field names, endpoints, staffing |
| [`SPEC.md`](./SPEC.md) | **What** exactly do I build against? | rationale essays, staffing |
| [`PLAN.md`](./PLAN.md) | **Who** builds what, in what order? | contract detail, rationale |
| [`DECISIONS.md`](./DECISIONS.md) | **What** did we decide, on what evidence? | anything still undecided |
| [`GROUP-CHAT-DESIGN.md`](./GROUP-CHAT-DESIGN.md) | Why this group/thread model? | buildable contracts |
| [`DEMO.md`](./DEMO.md) | Which beats, in what order, under 3:00? | design rationale, interfaces |
| [`MIDDLEWARE.md`](./MIDDLEWARE.md) | *(for reviewers)* What is the problem, the trust boundary, the enforcement point? | internal planning |
| [`integrationManifestTask2.md`](./integrationManifestTask2.md) | *(for QA)* How do the four workstreams become one green build? | design, contracts |
| [`integrationManifest3.md`](./integrationManifest3.md) | *(for QA)* How does the memory pipeline reconcile with 1 and 2? | design, contracts |
| `MILESTONE_PERSON_1..4.md` | **Has** that workstream built it, and is it verified? | design, contracts |
| [`components/`](./components/) | **How** does this one module work internally? | anything outside that module |
| [`archive/`](./archive/) | history — a superseded design | anything to build from |

**Start here:** new to the project → `MIDDLEWARE.md`, then `ARCHITECTURE.md`.
Starting your workstream → `PLAN.md`, then `SPEC.md`, then your component TD.

---

## The rule that prevents drift

> **One fact lives in exactly one document. Everywhere else it is a pointer.**

This is not style advice. We were bitten by exactly this twice: a data model
lived in two files and drifted (`pending` vs `candidate`), and a build order
lived in three and disagreed about whether landing came before or after the group
runner. Both were found in review, not by the person building from the wrong
copy.

| Fact | Lives in | Everyone else |
|---|---|---|
| Why a decision was made | `ARCHITECTURE.md` | points |
| What was decided, and the evidence | `DECISIONS.md` | points |
| Field names, enums, types, store shape | `SPEC.md` | points |
| Routes, request/response schemas, config keys | `SPEC.md` | points |
| Who builds it, in what order | `PLAN.md` | points |
| A module's internals and file formats | that module's TD | points |
| Beats, timings, stage directions | `DEMO.md` | points |

Two corollaries:

- **`SPEC.md` wins on names.** If an enum or field appears both in `SPEC.md` and
  in a component TD, `SPEC.md` is right and the TD needs updating.
- **Never cite a document that does not exist.** A doc naming a missing authority
  reads worse than one citing nothing.

---

## Changing a decision, once building has started

1. Change `ARCHITECTURE.md` first — the decision and the reason.
2. Append to `DECISIONS.md` — what changed, and the evidence.
3. Change `SPEC.md` if a contract moved.
4. **Tell whoever is building it directly.** Do not rely on them re-reading.
5. If it changes what we say on stage, change `DEMO.md`.

Never change `SPEC.md` alone to work around a design decision. That is how the
documents fall out of sync, and the person who finds out is a judge.

---

## Status

The design is settled and verified; the code is not written. Before the first
line, see the **Day-0 Checklist** at the end of [`PLAN.md`](./PLAN.md) — two
items there block everything else:

- the `ARK_API_KEY` in `.env` returns `401`, so nothing runs end to end;
- the database holds one run and **zero spans**, so every span-consuming
  component is currently designed against an assumption.
