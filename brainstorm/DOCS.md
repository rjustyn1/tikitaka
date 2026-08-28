# Documentation Map

> Read this before adding, moving, or rewriting any document.
> Structure locked. Changing it is a team decision, not a lane's.

---

## 1. The two shelves

**Working docs — `brainstorm/`.** For us, during the build. Never submitted,
never read by a judge. They can be long, argumentative and blunt.

**Shipped docs — `tikitaka/`.** What a reviewer clones and reads. Graded: the
challenge weights *"a concise live demo, useful README, one-command startup,
documented limitations"* at 15%, and the written rationale carries part of the
25% design score. **None of these exist yet.**

---

## 2. The map

### Working — `brainstorm/`

| Doc | The one question it answers | Must never contain |
|---|---|---|
| `DESIGN.md` | **Why** did we decide it this way? | field lists, enums, test rows, beats, timings |
| `SPEC.md` | **What** exactly do I build? | persuasion, rationale essays |
| `DEMO.md` | **Which beats**, in what order, under 3:00? | design rationale, interface detail |
| `DOCS.md` | Where does this fact go? | anything else |
| `PROBLEM_STATEMENT_CONTEXT_MEMORY.md` | history — the first draft | it is not maintained; do not cite it |

### Shipped — `tikitaka/`, none written yet

| Doc | The one question it answers |
|---|---|
| `README.md` | What is this, and how do I run it? |
| `docs/MIDDLEWARE.md` | What's the problem, the boundary, the trust boundary, the enforcement point? Written from `DESIGN.md`. |
| `docs/architecture.png` | the one-page diagram — a named deliverable |
| `DEMO.md` | copied from the working one, once the beats stop moving |

The starter kit's existing `docs/ARCHITECTURE.md`, `DEPLOYMENT.md` and
`LOCAL_POC.md` stay untouched. **Do not rewrite what you did not build** — add
alongside and link.

---

## 3. What each doc is for, precisely

**`DESIGN.md` settles arguments.** Its job is that nobody re-litigates a decision
mid-build: you point at it and move on. So it records *why* — the alternatives
considered and the reason one won — and stays readable end to end. It is not the
doc you code from, and not the doc judges read.

**`SPEC.md` is the buildable contract.** Field names, enums, gate order,
endpoints, the validation ladder, the failure table, the test rows. If someone
cannot start coding from it, it is incomplete. It defers all rationale to
`DESIGN.md`.

**`DEMO.md` is the run sheet.** Beats, seconds, what to say, what not to linger
on, and the rehearsal checklist. Where a staging choice is really a design
decision, the reason lives in `DESIGN.md` and `DEMO.md` just does it.

---

## 4. The rule that prevents drift

> **One fact lives in exactly one document.** Everywhere else it is a pointer.

We were already bitten. `DESIGN.md` and the old plan file both carried a data
model and drifted — `pending` vs `candidate`, `sourceGroupId` vs
`sourceGroupIds`. Both carried a demo table and disagreed on how many beats ran
live. That is the whole argument for the rule.

| Fact | Lives in | Everyone else |
|---|---|---|
| Why a decision was made | `DESIGN.md` | points |
| Field names, enums, types | `SPEC.md` | points |
| Gate order, endpoints, test rows | `SPEC.md` | points |
| Beats, timings, stage directions | `DEMO.md` | points |

**Never cite a document that does not exist.** A doc that names a missing
authority reads worse than one that cites nothing.

---

## 5. Changing a decision, once we start building

1. Change `DESIGN.md` first — the decision and the reason.
2. Change `SPEC.md` if the interface moves.
3. Tell whoever is building it directly. Do not rely on them re-reading.
4. If it changes what we say on stage, change `DEMO.md`.

Never change `SPEC.md` alone to work around a design decision. That is how the
two shelves fall out of sync, and the person who finds out is a judge.
