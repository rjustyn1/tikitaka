# Integration Manifest — Task 2

> **The one question this answers: how does a QA agent integrate the four
> workstreams into one green build?**
>
> Audience: the QA/integration agent. This file is self-contained — you do not
> need to read the design docs to perform the integration, though
> [`SPEC.md`](./SPEC.md) is the authority if a contract is ever ambiguous.
>
> Written by Person 2. Sections marked **OBSERVED** were verified against the
> repository. Sections marked **EXPECTED** describe work that had not landed
> when this was written; treat them as a checklist, not as fact.

---

## 0. Ground truth at time of writing — OBSERVED

```text
remote        https://github.com/rjustyn1/tikitaka.git
main          7542ff8  "docs: complete documentation"
```

Branches that actually exist on the remote:

```text
origin/main
origin/feat/group-memory-contracts   Person 1 - ALREADY MERGED into main (PR #1, 1f74f1c)
origin/docs/restructured             docs only
origin/docs/rj-iter                  docs only
origin/feature/tracing               docs only
```

**There is no Person 2, 3 or 4 branch yet.** Person 1's contracts layer is the
only implementation on `main`. Person 2's work exists as **uncommitted changes
in the working tree** and must be branched before you can integrate anything.

Baseline test counts:

```text
main @ 7542ff8                       21 tests   (but see section 8: 1 fails on Windows)
main + Person 2 working tree         84 tests   all green, typecheck + build clean
```

---

## 1. How to use this document

```text
1. Read section 2 so you know who owns what.
2. Read section 3. It is the ONLY genuine contract collision and it must be
   RESOLVED, not merged. Everything else is ordinary conflict resolution.
3. Follow the merge order in section 4. Do not improvise the order.
4. Run the gate in section 6 after EVERY merge, not just at the end.
5. Before filing a bug, check sections 8 and 9. Several things look broken and
   are known, expected, and not anyone's regression.
```

---

## 2. Ownership map — who owns which file

Merge conflicts are almost entirely predictable from this table. If two people
touched a file that is not marked *shared*, one of them was out of scope and the
owner's version wins.

| File | Owner | Notes |
|---|---|---|
| `apps/server/src/types.ts` | Person 1 | **shared** — highest merge risk in the repo |
| `apps/server/src/store.ts` | Person 1 | |
| `apps/server/src/config.ts` | Person 1 | `MEMORY_*` keys |
| `apps/server/src/app.ts` | Person 1 | **shared** — routes; Person 2 added 2 edits, see §3 |
| `apps/server/src/app.test.ts` | Person 1 | Person 4 adds a separate `app.groups.test.ts` |
| `apps/server/src/workspace.ts` | **Person 2** | was double-assigned; Person 3 must NOT edit it |
| `apps/server/src/agent-service.ts` | Person 2 | |
| `apps/server/src/codex-runner.ts` | Person 2 | A2 `--add-dir` |
| `apps/server/src/container-codex-runner.ts` | Person 2 | A2 nested mount |
| `apps/server/src/memory/group-runner.ts` | Person 2 | |
| `apps/server/src/memory/flush-trigger.ts` | Person 2 | |
| `apps/server/src/memory/group-chain.ts` | Person 2 | |
| `apps/server/src/memory/group-prompt.ts` | Person 2 | |
| `apps/server/src/memory/pending-contracts.ts` | Person 2 | **temporary — see §3** |
| `apps/server/src/memory/task-buffer.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/extractor-client.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/consolidator.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/safety.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/landing.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/review.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/ledger.ts` | Person 3 | EXPECTED |
| `apps/server/src/memory/workspace-memory.ts` | Person 3 | EXPECTED — **not** `workspace.ts` |
| `apps/web/src/App.tsx` `styles.css` `mock.ts` | Person 4 | EXPECTED |
| `apps/web/src/types.ts` `api.ts` | Person 1 | **shared** with Person 4 |

---

## 3. The one collision you must RESOLVE, not merge

This is the single highest-risk item in the whole integration. Read it fully.

### The situation

Person 1's contracts layer landed **before** the A1–A5 design review, so
`types.ts` still says:

```ts
export interface AgentGroup {
  memberAgentIds: string[];     // pre-A4
  // ...
}
```

`SPEC.md` and decision A4 replaced that with role-bound membership:

```ts
export type GroupRole = "backend" | "frontend" | "security";
export interface GroupMember { agentId: string; role: GroupRole }

export interface AgentGroup {
  members: GroupMember[];       // A4 - exactly three, one per role
  // ...
}
```

The five-node plan binds nodes to **roles**, so `memberAgentIds: string[]`
cannot express the plan at all. `SPEC.md` wins — this is not a matter of taste.

### How Person 2 bridged it without touching `types.ts`

Person 2's branch does **not** edit `types.ts`. Instead:

```text
apps/server/src/memory/pending-contracts.ts
```

holds `GroupRole`, `GroupMember`, `AgentLease`, `AgentLeaseHolder` and
`GroupRunnerRequest`, and defines `GovernedGroup = AgentGroup & { members }`.
On every group write, `memberAgentIds` is recomputed from `members` as a
**derived mirror**, so both shapes are simultaneously valid and cannot drift.

That is why the build is green today with two contradictory contracts in it.

### What you must do about it

```text
IF Person 1 has landed the A4 deltas in types.ts by integration time:
   1. delete the two mirror assignments in memory/group-runner.ts
        createGroup:  memberAgentIds: deriveMemberAgentIds(input.members),
        updateGroup:  group.memberAgentIds = deriveMemberAgentIds(input.members);
   2. repoint imports from memory/pending-contracts.js to types.js in the
      8 files listed by:  grep -rl pending-contracts apps/
   3. move GROUP_ROLES / findMembershipError / readMembers into
      memory/group-chain.ts (they are validation helpers, not contracts)
   4. delete memory/pending-contracts.ts
   5. re-run the section 6 gate

IF Person 1 has NOT landed them:
   leave the quarantine file exactly as it is. It is green, it is isolated to
   one file, and removing it is not QA's call to make unilaterally.
   Raise it to Person 1 instead.
```

**Do not** "resolve" this by deleting `members` and restoring `memberAgentIds`.
That silently reverts A4 and the plan template stops working.

### The related latent break — check this even if you change nothing

```text
apps/web/src/api.ts:110   createGroup() still SENDS memberAgentIds
apps/web/src/api.ts:121   updateGroup() same
apps/web/src/types.ts:119 AgentGroup still DECLARES memberAgentIds
```

The server's Zod schema now requires `members`, so these client methods would
receive a **400**. They are not failing today only because no UI calls them yet.
The moment Person 4 wires the group screen, this breaks. Flag it to Person 1
(who owns those files) as soon as Person 4's branch appears.

### Person 2's deliberate edits inside Person 1's files

Two edits crossed an ownership boundary. Both are intentional and documented.
**Keep them.** If Person 1's branch conflicts here, Person 2's version is the
one that matches `SPEC.md`.

| File | Edit | Reason |
|---|---|---|
| `app.ts` `createGroupBody` | `memberAgentIds` → `members` array with `role` enum, `.length(3)` | A4's contract is otherwise unreachable through the API |
| `app.ts` | added `POST /api/groups/:id/tasks/:taskId/cancel` → 202 | `PLAN.md` gives the route to Person 1 and the impl to Person 2; the impl is dead code without a route |
| `app.test.ts` | create-group stub test now posts a valid 3-member body | old payload no longer passes Zod; the test still asserts 501, intent unchanged |

`updateGroupBody` needed no edit — it is `createGroupBody.partial()`.

---

## 4. Merge order

Dependency order, from `PLAN.md` § Build Order. Do not improvise.

```text
0. main                       Person 1's contracts are already here

1. Person 2   group runner, workspace extensions, lease, A2 runner wiring
              Rationale: WORKSPACE-EXTENSIONS must land before LANDING or
              editing an Agent WIPES governed memory (see below). Person 2 also
              owns the managed-block helpers that Person 3 imports.

2. Person 3   memory pipeline, safety, landing, review, ledger
              Depends on: Person 2's replaceManagedBlock/removeManagedBlock,
              and the MemoryPipeline seam.

3. Person 4   frontend + app.groups.test.ts
              Depends on: Person 1's route shapes, and real data from 2 and 3.

4. Person 1   any remaining A4/A5/config deltas, then the §3 cutover.
```

### The hard ordering constraint — do not violate it

```text
Person 2's workspace.ts MUST be merged before Person 3's landing.ts.
```

`writeInstructions()` used to regenerate `AGENTS.md` from scratch, and
`updateAgent()` calls it on every Agent edit. If landing lands first, editing an
Agent silently deletes the `<!-- memory:<noteId> -->` block and the demo shows
memory vanishing for no visible reason. Person 2's version composes instead of
regenerating, and there is a test for exactly this
(`workspace.test.ts` → *"preserves governed memory when the Agent is edited"*).

If you ever see that test missing or failing after a merge, **stop** — the merge
resolution dropped the composing `writeInstructions()`.

---

## 5. File-level conflict hot spots

Expect real conflicts here. Everything else should merge cleanly.

| File | Who touches it | Resolution rule |
|---|---|---|
| `types.ts` | P1 writes, everyone imports | P1's version wins on names. If P2's `pending-contracts.ts` disagrees, apply §3. |
| `app.ts` | P1 owns; P2 added schema + cancel route | Union of both. Keep P2's `members` schema and the cancel route. |
| `agent-service.ts` | P2 owns; P3 may want a pipeline hook | P2's version. P3 injects via the constructor's 5th argument, not by editing methods. |
| `workspace.ts` | **P2 only** | P2's version, always. P3's memory writes belong in `workspace-memory.ts`. |
| `app.test.ts` vs `app.groups.test.ts` | P1 vs P4 | Separate files by design. Neither should edit the other. |
| `apps/web/src/types.ts`, `api.ts` | P1 owns, P4 consumes | P1's version; then apply the §3 latent-break fix. |
| `apps/server/src/memory/*` | P2 and P3, different files | No overlap by design. A conflict here means someone strayed. |

---

## 6. The verification gate

Run this after **every** merge, not only at the end.

```bash
npm run check      # typecheck (server + web) -> vitest -> build
```

Expected at each stage:

| After merging | Tests | Notes |
|---|---|---|
| main only | 21 | 1 pre-existing Windows failure — see §9 |
| + Person 2 | **84** | typecheck + build clean, 9 test files |
| + Person 3 | 84 + P3's | P2's 84 must all still pass |
| + Person 4 | above + P4's | |

Person 2's 84 break down as:

```text
 4  src/agent-service.test.ts
 7  src/app.test.ts
 9  src/codex-runner.test.ts
 5  src/container-codex-runner.test.ts
 2  src/store.test.ts
15  src/workspace.test.ts
10  src/memory/flush-trigger.test.ts
14  src/memory/group-prompt.test.ts
18  src/memory/group-runner.test.ts
```

If the total drops after a later merge, a merge resolution deleted tests. Find
which file lost count before proceeding.

Additional gates that cost nothing:

```bash
grep -rn "TODO\|FIXME\|@ts-expect-error\|it.skip\|describe.skip" apps/server/src
./scripts/verify-codex-skills.sh     # A1 skill placement; needs no API key
```

---

## 7. Acceptance checks per workstream

From each workstream's *Done When* in `PLAN.md`. Tick these off; do not accept a
branch that fails its own list.

### Person 1
```text
[ ] new types compile on server and web
[ ] an old database file loads with the new arrays backfilled
[ ] route stubs validate inputs with Zod
[ ] store backfill and route validation are tested
```

### Person 2 — OBSERVED complete
```text
[x] a group task runs the sequential chain with a fake runner
[x] group messages appear in order (1 human + 5 agent turns, seq 1..6)
[x] group thread ids are separate from the solo codexThreadId
[x] shared ./code exists for every selected Agent
[x] solo and group runs never collide on one Agent (A3 lease -> 409, not 500)
[ ] shared ./code writable from a REAL Codex run in BOTH runtimes  -- see §8
```

### Person 3
```text
[ ] fake extractor produces deterministic candidate notes
[ ] safety redacts fake secrets and quarantines prompt-injection shapes
[ ] landing writes ONLY into private Agent workspaces
[ ] ledger shows granted AND withheld Agents
[ ] revoke removes files but keeps audit records
[ ] nothing is ever written under $CODEX_HOME  (A1: that path is global to
    every Agent and silently voids the security claim)
```

### Person 4
```text
[ ] user can create a group with Agent toggles AND a role per Agent
[ ] user can start a group task; timeline and node status update while running
[ ] context packet viewer shows injected and withheld ids
[ ] review queue supports approve / edit / reject / revoke
[ ] grant ledger shows who did and did not receive memory
[ ] the proof beat runs: fresh-thread run on the target Agent answers using
    landed memory; the same prompt on a withheld Agent cannot
```

---

## 8. Known NOT verified — do not file these as bugs

These are open by design and blocked on things no branch can fix.

| Item | Status |
|---|---|
| `ARK_API_KEY` returns **401** | Expired key, gitignored and untracked — an expiry, not a leak. Nothing runs end to end until it is replaced. |
| The database holds **zero spans** | No Codex run has yet done file work. Every span-consuming component is built against an assumption. |
| Shared `./code` writable from a **real** Codex run, both runtimes | Arg builders are unit-tested on both paths, and the local-process link is verified by writing through it. The live half needs a real `codex exec` plus a container. |
| `codex exec` **fires** a discovered skill | `skills/list` proves discovery only. This is the residual A1 check, blocked on the API key. |
| OS-enforced isolation between Agents | Not claimed. Landlock is unavailable on Docker Desktop for Mac; the container is the real boundary. |

---

## 9. Environment gotchas that look like bugs

Check here before reporting a failure.

**A pre-existing Windows test failure on `main`.**
`container-codex-runner.test.ts` asserted a literal `/tmp/codex-home`, but
`config.ts` runs `path.resolve()` on it, which yields `C:\tmp\codex-home` on
Windows. Verified failing on unmodified `HEAD` before Person 2's work. Person 2's
branch fixes it to assert the resolved value. If you integrate on Windows without
Person 2's branch, expect exactly one failure here.

**vitest picking up third-party tests.**
The Codex runtime writes scratch files under `apps/server/codex-home/.tmp/`,
which is gitignored, and vitest used to collect them — producing failures like
*"No test suite found"* in `plugin-eval` or `playwright-starters`. Person 2's
branch adds `apps/server/vitest.config.ts` restricting collection to
`src/**/*.test.ts`. Keep that file.

**`./code` is a junction, not a symlink, on Windows.**
`prepareSharedCode()` calls `symlink(target, path, "junction")`. On POSIX the
type argument is ignored and it is a normal symlink; on Windows a junction links
directories without requiring elevation. `lstat().isSymbolicLink()` is therefore
`false` on Windows for that path — assert on behaviour (write through it, read
from the shared dir), not on link type.

**CRLF warnings from git.** Cosmetic, on a repo with LF-authored files checked
out on Windows. Not a merge problem.

**Background group tasks and temp-dir cleanup.** Group tasks run detached from
`startGroupTask()`. Any test that creates one must wait for a *terminal* status
before its temp directory is removed, or Windows throws `ENOTEMPTY`. Note that
polling for `status !== "running"` is **wrong** — a task is `queued` before it is
`running`, so that predicate passes instantly. Poll for membership of
`["completed","partial","failed","cancelled"]`.

---

## 10. Definition of done for the integration

```text
[ ] every workstream branch merged in the section 4 order
[ ] npm run check green: typecheck (server + web), all tests, build
[ ] total test count >= the sum of each branch's own count
[ ] grep -rn "TODO\|FIXME\|@ts-expect-error\|it.skip" apps/server/src  -> empty
[ ] the section 3 collision is either fully cut over or explicitly deferred
    with Person 1's agreement, and pending-contracts.ts is the only place any
    duplicated contract lives
[ ] workspace.test.ts "preserves governed memory when the Agent is edited"
    is present and passing  (the Person 3 hazard)
[ ] no governed memory file exists anywhere under $CODEX_HOME or under
    workspaces/shared-code/
[ ] each workstream's section 7 list is ticked by its owner, not by QA
```

Last two are worth a manual check even when the suite is green:

```bash
find . -path "*codex-home*/skills/*" -name "SKILL.md" 2>/dev/null   # must be empty
find . -path "*shared-code*" \( -name "AGENTS.md" -o -name ".agents" \)  # must be empty
```

---

## 11. Escalation

Route a problem to its owner rather than fixing across a boundary.

```text
type contracts, store, routes, config, freshThread, deleteAgent cascade
                                                        -> Person 1
group execution, workspace.ts, the lease, A2 runner wiring
                                                        -> Person 2
extraction, safety, landing, review, ledger              -> Person 3
frontend, demo flow, app.groups.test.ts                  -> Person 4
a contradiction between two documents                    -> SPEC.md wins on
                                                            names; ARCHITECTURE.md
                                                            wins on design
```

Person 2's reasoning, including every cross-boundary edit and the full
verified/not-verified split, is recorded in [`MILESTONE_PERSON_2.md`](./MILESTONE_PERSON_2.md).
