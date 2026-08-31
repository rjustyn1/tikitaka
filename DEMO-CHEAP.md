# Cheap end-to-end demo (2 tasks, all features)

Two tightly-scoped tasks that exercise **every** feature — parallel DAG,
persistent shared code, topic-segment consolidation, **node-level drift flush
(intra-task)**, SBERT routing, safety, human review, landing, ledger — for a
fraction of the tokens of an open-ended "build an app" prompt.

Two levers keep it cheap: **scope** (tiny explicit slices) and **agent
instructions that say "do the minimum."** Descriptions matter more than ever —
the planner assigns nodes, the recognizer routes memory, AND the turn prompt's
identity all read the agent `description`. Roles are gone; ignore them.

---

## 0. Launch (real SBERT routing + drift, low token ceiling)

```bash
MEMORY_SBERT_PYTHON="$PWD/.venv-recognition/bin/python" \
CODEX_TIMEOUT_MS=180000 \
ARK_API_KEY=<yours> ARK_MODEL=<yours> \
npm run poc 2>&1 | tee run.log
```
- `MEMORY_SBERT_PYTHON` → the venv (torch), so routing uses the real model.
- Node drift uses the **stock** model (`MEMORY_DRIFT_MODEL_DIR`, auto-downloaded) — no extra setup.
- `CODEX_TIMEOUT_MS=180000` caps each node at 3 min so nothing runs away.
- `| tee run.log` captures the `[node-drift]` lines for calibration.

Open <http://localhost:3000>, keep the **Teams** tab visible.

## 1. Create 2–3 agents  (Agents → Create Agent)

Paste the **same** text into each agent's **Instructions** (the token lever):
> Prioritize speed and minimalism. Implement only what the task literally asks —
> no extra endpoints, no error handling beyond what is specified, no comments,
> no tests, no configs, no dependencies, no refactoring. Make one pass and stop;
> do not iterate or polish. In-memory only.

| Name | Description (drives planner + routing + identity — make it meaningful) |
| --- | --- |
| `backend` | Backend HTTP endpoints and in-memory storage in plain Node/JS. |
| `frontend` | Minimal HTML/JS UI, no frameworks or build tools. |
| `security` | Input validation and secret-boundary review, small targeted checks. |

## 2. Create a team  (Teams → Create New Team)

Just select the agents. (No role picker anymore — the planner decides who does what.)

## 3. Two goals, one at a time — WAIT for each; do NOT cancel

**Task 1 — "upload feature"** (coherent → LOW node-drift; builds shared code)
> In code/, add a POST /upload endpoint that accepts JSON {filename} and returns
> {id,url}, stored in an in-memory object. Security: reject any filename with
> '..' or '/'. Frontend: a ~10-line code/index.html with a filename input that
> POSTs to it. Nothing else.

**Task 2 — "three small utilities"** (different subject → closes Task 1's segment
→ consolidation; its own mixed nodes → HIGH node-drift → mid-DAG flush)
> In code/, add three independent pure functions: slugify(text) (lowercase,
> hyphenate), parseIsoDate(s) (ISO-8601 → {y,m,d}), and caesar(text,k) (shift
> letters by k). No dependencies. Keep each tiny.

*(Trim to two utilities for even fewer tokens.)*

---

## What each feature looks like, and how to verify

| Feature | Where | Correct result |
| --- | --- | --- |
| Planner / parallel DAG | Plan tab (graph) | multiple nodes, right agent per **description**, parallel branches |
| Persistent shared code | either task's Trace / `./code` | Task 2 sees Task 1's files (persists per group) |
| Live execution | Live Terminal + Members | ≥2 agents running at once; short lines |
| **Node-level drift (NEW)** | `run.log` → `[node-drift]` | Task 1 nodes **low** drift (<0.55, `"flush":false`); Task 2 nodes **high** (`"flush":true`) + `flushed N node(s)` |
| Mid-DAG consolidation (NEW) | the conversation, **during** Task 2 | approval cards appear **before** the task finishes |
| Topic-segment consolidation | after Task 2 starts | Task 1's learnings consolidate (segment closed by the subject change) |
| SBERT routing | a note's routed-to agents | note goes to the semantically right agents; **no "degraded to fake"** in log |
| Safety | approval card flags | secrets redacted; injection-y notes quarantined |
| Human review | approval cards | Approve / edits / Reject; auto-grant is off, so every match is review-gated |
| Landing | Workspaces tab + filesystem | file only in target agents' workspaces; others hold nothing |
| Ledger | Ledger tab | granted AND withheld rows, each with a reason |

## Calibrate / confirm the drift threshold
```bash
node scripts/node-drift-stats.mjs run.log
```
Task 1 nodes should cluster **low**, Task 2 nodes **high**, with a clear gap; the
default `MEMORY_NODE_DRIFT_THRESHOLD=0.55` should sit in it. Adjust if your live
numbers say so.

## After a real run — catch silent failures
```bash
LOCAL_POC_DATA_ROOT=$HOME/.volc-agent-launchpad npm run verify:live
```

## Gotchas
- **Don't cancel** a task you want memory from — cancelling skips consolidation.
- **No memory after a single coherent task is normal** — the segment is open;
  it consolidates when Task 2 (different subject) starts, OR a node-drift flush
  fires mid-task.
- The **negative case is the strongest proof**: pick an agent a note was NOT
  routed to (a non-member is cleanest, since shared code now persists) and show
  its workspace holds nothing.
- Token levers: minimal instructions, tiny tasks, `CODEX_TIMEOUT_MS`.

## One-command version
`./scripts/demo-cheap.sh` fires the tasks headlessly; watch the UI + `run.log`.
