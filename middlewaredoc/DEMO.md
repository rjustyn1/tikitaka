# Demo — Three Minutes

> The single home for beats, timings and stage directions.
> Rationale is in [`ARCHITECTURE.md`](./ARCHITECTURE.md); interfaces are in
> [`SPEC.md`](./SPEC.md).
>
> Every beat below has been exercised against a running server on seeded data.
> The **timings are still budgets, not measurements** — re-time them with a
> stopwatch on the machine you will present from.

---

## The decision that shapes everything: pre-run, don't seed

The governance layer is genuine either way — real pipeline, real safety, real
landing, real files, real ledger. What differs is where the Agents' *words* come
from.

```text
PRIMARY   pre-run one REAL task before you present.
          The transcript is model-generated, so "did the Agents actually say
          this?" has a clean yes.

FALLBACK  npm run seed. Identical UI, identical governance, but the transcript
          is authored. If asked, SAY SO. Do not imply otherwise.
```

Pre-run well before you present — five Codex nodes takes minutes and nobody
should watch that. Once it is done the expensive part is behind you and only
two beats cost a model call.

```bash
# an hour before, or the night before
export $(grep -E '^ARK_(API_KEY|MODEL|BASE_URL)=' .env | xargs)
npm run poc
#   → create Backend, Frontend, Security, and Ops (Ops stays OUT of the team)
#   → create the team, start one task, let all five nodes finish

# if that failed, or you are offline
npm run seed
```

`start-local-poc.sh` does **not** read `.env` — only `docker compose` does. And
export only those three variables: `.env` also carries container paths
(`/app/data`, `/app/workspaces`, `/app/codex-home`) which would send the poc
looking for directories that do not exist on a Mac.

---

## Cast and setup

**Backend**, **Frontend** and **Security** in a team called `Upload Feature
Team`, one per role. **Ops** exists on the platform and is deliberately **not**
a member — it is the withheld Agent, and it carries the demo.

Before you present:

```text
[ ] the runtime image is built (first `npm run poc` does it — minutes)
[ ] one completed task exists, pre-run or seeded
[ ] a note is sitting `pending` so beat 4 has something to approve
[ ] MEMORY_EXTRACTOR=fake unless you deliberately want live extraction
```

---

## The beats

**Open on the denial, not the grant.** A positive-injection beat on its own is
indistinguishable from any memory product. The denial, the named reason and the
audit record are what nothing else does.

| # | Beat | Tab | Live? | Target |
|---|---|---|---|---|
| 1 | Ops holds nothing. Three members hold files; the non-member's workspace is empty | Workspaces | no | 0:25 |
| 2 | The ledger says `withheld · out_of_group`, with a timestamp | Ledger | no | 0:20 |
| 3 | Where the constraint came from: Backend proposes returning storage credentials "to make integration easy", Frontend says it only needs the public contract, Security overrules | Transcript | no | 0:30 |
| 4 | The severe note sitting `pending`. Edit its `description`, then approve | Review | no | 0:35 |
| 5 | The file appears in Backend and Frontend. Ops still empty | Workspaces | no | 0:15 |
| 6 | Two fresh-thread runs, same prompt: the granted Agent answers using the memory, the withheld one cannot | Proof | **yes** | 0:45 |
| 7 | Revoke. The file vanishes; the ledger keeps the record | Review | no | 0:10 |

Total 3:00 with no slack. If a rehearsal runs over, cut 7 first, then compress 3.

---

## Stage directions

**Beat 1 is the beat that wins, so open with it.** Say it plainly:

> *"This isn't a prompt telling Ops to keep a secret. There is nothing in that
> workspace to reveal."*

Placement is the enforcement point. A memory reaches an Agent if and only if a
file was written into its workspace, and you are looking at the workspace.

**Beat 3 — name what the user never said.** The size limit and the credential
boundary were never in anyone's prompt. They came out of one Agent's run and
reached another through the middleware.

**Beat 4 is the authority point.** This is what separates governance from a
memory feature. Say what the human is doing: setting policy, not editing text.
`description` is the only signal Codex matches on, so editing it is editing
*when* the memory fires.

Say this before anyone asks it:

> *"Reviewer identity here is attribution, not authentication. This platform is
> single-user and has no identity system, so we record who claims to have
> approved. We're not going to pretend that's more than it is."*

**Beat 6 — `freshThread` is why this works.** Both runs start a NEW Codex
thread. A resumed thread may not re-read a changed `AGENTS.md`, so a normal
follow-up run can appear to ignore memory that did land. Use the explicit
`$skill-name` invocation the panel suggests: relevance matching is the soft,
model-driven half, and the stage is the wrong place to demonstrate a
probabilistic step.

**Beat 7 must not re-run the granted Agent.** It already has the memory in a
live thread. Show the file disappearing from Workspaces instead — same
enforcement path, zero seconds, and the ledger visibly keeps the record.

---

## Have these ready as sentences, not improvised

> *"We can prove a memory was available to one Agent and withheld from another,
> with a named reason. We cannot prove the model used it on a given run — Codex
> emits no skill-invocation event. That's why the audit is at write time, and
> we'd rather say so than overclaim."*

> *"Security is file placement, which is deterministic and ours. Relevance is
> Codex's own skill matcher, which is model-driven and soft. We didn't reinvent
> retrieval; we drew a hard line around who may receive what."*

If asked whether the run was live:

> *"This task was seeded so the demo fits in three minutes. The pipeline,
> the safety checks, the landing and the ledger are all real — you're looking at
> actual files on disk. The live path is `npm run poc`."*

---

## Do not promise these

The v1 chain is sequential (A4). There are no branches:

```text
"branch context does not leak sibling output"   there are no siblings
"the join owner receives branch outputs"        there are no joins
runtime locks preventing a collision            one node runs at a time
```

In the Context tab, **“Already seen” is transcript de-duplication, not a
governance decision.** Governance withholding lives in the Ledger, where a
decision carries a reason. Conflating the two would misrepresent the system to
someone who may well ask.

Also unverified as of writing, so do not assert them: that shared `./code` is
writable from a real `codex exec` in both runtimes, and that `codex exec`
actually *fires* a discovered skill rather than merely discovering it.

---

## Rehearsal checklist

```text
[ ] runtime image already built, so no build happens on stage
[ ] one completed task loaded, pre-run preferred
[ ] a pending note exists for beat 4
[ ] two full run-throughs timed with a stopwatch, both under 3:00
[ ] narrator and screen driver are different people
[ ] every panel shown is real UI, not a slide
[ ] no key, token or .env value visible in any window, including the terminal
[ ] browser zoomed so the back row can read the ledger table
[ ] fallback if a live run hangs: cancel the task, say what would have happened,
    show the pre-seeded equivalent, keep moving
```

---

## If something breaks

```text
a live proof run hangs      Cancel task in the header. Narrate the expected
                            result and move to beat 7.
the task shows "failed"     A node could not reach Codex. Reseed
                            (npm run seed) and continue — the governance
                            beats do not need a live model.
notes never appear          The task is terminal but consolidation produced
                            nothing. The UI says so after ~20s. Reseed.
the group screen 400s       Membership must be exactly three, one per role.
                            The modal blocks this; the server enforces it.
```
