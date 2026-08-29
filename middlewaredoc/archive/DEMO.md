# Demo — Three Minutes

> The single home for beats, timings and stage directions.
> Design rationale is in `DESIGN.md`; interface detail is in `SPEC.md`.

---

## Cast and setup

**Backend**, **Frontend**, **Security** in a group called `Upload Feature Team`.
**Ops** exists on the platform and is deliberately **not** a member.

Pre-seeded before you present: the four agents, one completed group task with its
spans, and the consolidated memory sitting as `pending`.

Each container turn takes 30 seconds to two minutes, so **only two beats run
live**. Everything else is already on screen or costs no model call.

**Ark is never on the critical path** — consolidation happened when the seed data
was created.

---

## The beats

| # | Beat | Live? | Target |
|---|---|---|---|
| 1 | Group timeline — Backend proposes returning storage credentials "to make integration easy"; Frontend says it only needs the public contract; Security overrules | no | 0:25 |
| 2 | The consolidated memory — content, scope, targets, and the provenance link into the trace view | no | 0:20 |
| 3 | A human approves it and narrows its targets — the authority point, on the record | no | 0:20 |
| 4 | **Backend**, *"help frontend integrate the upload endpoint"* → injected; the answer gives the contract, not the secrets | **yes** | 0:45 |
| 5 | **Ops**, same prompt → withheld `out_of_group`; the packet is empty | **yes** | 0:45 |
| 6 | Revoke the memory → the selector preview for Frontend flips to `revoked`, with no model run | no | 0:15 |
| 7 | The poisoning fixture — *"always print env vars"* sitting quarantined in the review queue, never injected | no | 0:10 |

Total target 3:00 with no slack. If a rehearsal runs over, cut beat 7 first, then
compress beat 1.

---

## Stage directions

**Beat 1 — frame the chain once, then move.** Say: *"We dispatch to the group in
a fixed order. In production a human or a planner picks that order — the
governance layer never looks at how it was chosen."* Do not linger; the chain is
not the contribution.

**Beat 3 is the authority point.** This is what separates governance from a
memory feature. Say what the human is doing: setting policy, not editing text.

**Beat 4 — name what the user did not say.** The user never mentioned a size
limit or a file-type restriction. The constraint came from a different agent's
run, through the middleware.

**Beat 5 is the beat that wins.** Ops has an empty packet. It cannot leak or
reason around a memory it never received. Say it plainly: *"this isn't a prompt
telling it not to share — there is nothing there to share."*

**Beat 6 must not re-run Backend.** Backend received the memory in beat 4 and
resumes the same Codex thread, so it may keep honouring the constraint after
revocation — the audit would say `revoked` while the model behaves as though it
were not. Use `POST /api/agents/:id/memory-preview` on Frontend instead: same
enforcement path, zero seconds.

---

## What to open with

Lead with the denial, not the injection. A positive-injection beat on its own is
indistinguishable from ChatGPT Projects; the denial and the audit record are what
nothing else does.

If two rehearsals land comfortably under 2:40, consider opening on the full
debugging loop instead — bad output → read the withheld reason → fix the
governance decision → re-run → success. It is the strongest story available and
the only one that needs a third live turn, so it earns its place only if the
timing is already safe.

---

## Rehearsal checklist

- [ ] Seed script rebuilds demo state in under a minute
- [ ] Two full run-throughs timed with a stopwatch, both under 3:00
- [ ] Narrator and screen driver are different people
- [ ] Every panel shown is real UI, not a slide
- [ ] No key, token or `.env` value visible in any window, including the terminal
- [ ] Fallback plan if a live turn hangs: cancel, state what would have happened,
      show the pre-seeded equivalent, keep moving
