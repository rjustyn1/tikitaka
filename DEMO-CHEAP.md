# Cheap end-to-end demo

A tightly-scoped run that shows every feature — parallel DAG, topic-segment
consolidation, SBERT note routing, human review, landing, ledger — while
burning a fraction of the tokens of an open-ended "build an app" prompt.

The trick is **scope**: tiny, explicit task slices + agent instructions that say
"do the minimum." Open-ended prompts (e.g. "develop a todo app with best
practices") make every agent write a lot and can run up to `CODEX_TIMEOUT_MS`
(10 min) per node — that's the token blow-up.

---

## 0. Launch

Bring the server up on `:3000` however you normally do (`npm run poc`, or the
sourced host run). Optional token cap — shorten each node's max runtime so
nothing runs away:

```bash
CODEX_TIMEOUT_MS=180000 ARK_API_KEY=… ARK_MODEL=… SEED_DEMO=0 npm run poc
```

Open <http://localhost:3000> and keep the **Teams** tab visible while it runs.

## 1. Create 3 agents  (Agents → Create Agent)

Paste the **same** text into every agent's **Instructions** box — this is the
main token lever:

> Prioritize speed and minimalism. Implement only what the task literally asks —
> no extra endpoints, no error handling beyond what is specified, no comments,
> no tests, no configs, no dependencies, no refactoring of existing files. Make
> **one pass and stop**; do not iterate, polish, or add "nice-to-haves".
> In-memory only.

| Name | Description (the planner + recognizer read THIS) |
| --- | --- |
| `backend` | Backend HTTP endpoints and in-memory storage in plain Node/JS. |
| `frontend` | Minimal HTML/JS UI, no frameworks or build tools. |
| `security` | Input validation and secret-boundary review, small targeted checks only. |

> Give **distinct, meaningful descriptions** — the planner assigns nodes and the
> SBERT recognizer routes memory by *description*, never by the role label.

## 2. Create a team  (Teams → Create New Team)

Select all three agents. (The role dropdown is cosmetic — it only colors the
badge; leave the defaults.)

## 3. Send 3 goals, one at a time — WAIT for each to finish

Do **not** cancel a task you want memory from — cancelling skips consolidation.

**Task 1** — subject: *upload*
> In code/, add a POST /upload endpoint that accepts JSON {filename} and returns
> {id,url}, stored in an in-memory object. Security: reject any filename
> containing '..' or '/'. Frontend: add a ~10-line code/index.html with a
> filename input that POSTs to it. Nothing else.

**Task 2** — still *upload*
> Add a GET /upload/:id endpoint that returns the stored record as JSON, reusing
> the existing in-memory store in code/. Do not change anything else.

**Task 3** — different subject (this one triggers consolidation)
> In code/slug.js add a pure function slugify(text): lowercase, replace
> non-alphanumeric runs with single hyphens, trim leading/trailing hyphens. No
> dependencies.

**Why 3:** memory consolidates per *topic segment* (a run of consecutive tasks
on one subject). Tasks 1+2 accumulate in the "upload" segment; Task 3's subject
change **closes** that segment and consolidates 1+2 together. Two tasks alone
would sit unconsolidated until the 30-min idle timeout.

---

## What to watch (per feature)

| Feature | Where | Working =  |
| --- | --- | --- |
| Planner / parallel DAG | Plan tab (graph) | multiple nodes, right agent per description, parallel branches |
| Live execution | Live Terminal + Members | ≥2 agents running at once; short chain-of-thought lines |
| Codex/Ark | chat + a node's Trace | real, task-relevant output; files appear in shared `./code` |
| Topic segmentation | (after Task 3) | tasks 1+2 consolidate together when Task 3 starts |
| Consolidator | Review / approval cards | non-zero, sensible notes |
| SBERT routing | a note's routed-to agents | note goes to the semantically right agents; no "degraded to fake" log |
| Safety | approval card flags | secrets redacted; injection-y notes quarantined |
| Human review | the conversation | severe/low-confidence notes appear as approval cards; Approve/edit/Reject |
| Landing | Workspaces tab + filesystem | file only in target agents' workspaces; others hold nothing |
| Ledger | Ledger tab | granted AND withheld rows, each with a reason |

After a real run, catch silent failures:
```bash
LOCAL_POC_DATA_ROOT=$HOME/.volc-agent-launchpad npm run verify:live
```

## Gotchas / reading the messages

- **"This task produced no governed memory…"** appears when a task did **not**
  consolidate. Two causes: (a) you **cancelled** it (consolidation is skipped by
  design), or (b) no node reached `completed`. Completing nodes ≠ finishing:
  a cancelled or timed-out node counts as nothing.
- **No memory after a single task is normal** — the segment is still open.
  Consolidation runs when the segment *closes* (Task 3, or the caps).
- **Don't cancel** a task you want memory from. Let it finish or fail naturally.
- **Token levers:** the "do the minimum" instructions, tiny scoped tasks, and a
  shorter `CODEX_TIMEOUT_MS`.

## One-command version

`./scripts/demo-cheap.sh` does steps 1–3 headlessly (creates the agents + team,
fires the three tasks in order). Watch the UI while it runs.
