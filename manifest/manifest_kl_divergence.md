# Manifest — Node-level drift & intra-task consolidation

**Scope:** a second, *finer* consolidation trigger layered on top of the existing
prompt-level topic segmentation. Where segmentation consolidates a run of *tasks*
that stayed on one subject, this consolidates a run of *nodes* **within one
task** the moment the agents' work drifts to a new subject — so memory can flush
**mid-DAG**, not only at task end.

This manifest records **only the problems we found *and solved*** in this branch,
with the intent behind each change and its current state. Open/parked items are
listed at the end and are explicitly *not* part of this work.

---

## 1. The routing SBERT cannot measure topic drift

- **Problem.** The obvious move was to reuse the fine-tuned recognition SBERT for
  drift. Measured (`scripts/probe-drift.mjs`), it does **not** work: that model
  was triplet-trained for *note → agent* matching, so its space is organized by
  *which agent* a text belongs to. Same-feature facets (backend vs frontend of
  one feature) came out **as far apart as unrelated subjects** — no threshold
  could separate "different facet, same subject" from "real subject change".
- **What changed.** Drift uses a **separate, general** sentence embedder
  (`all-MiniLM-L6-v2`), never the routing checkpoint. On the same probe the
  general model separated cleanly: same-feature ≈ 0.38–0.45, unrelated ≈
  0.70–1.03, a clear gap → threshold ~0.55.
- **Intention.** Right tool per job: the fine-tuned model stays for *routing*; a
  general model does *drift*. No retraining — a downloaded checkpoint.
- **State.** Settled. `MEMORY_DRIFT_MODEL_DIR` selects the drift model,
  independent of `MEMORY_SBERT_MODEL_DIR`.

## 2. The drift signal must be the explanation, not code/files

- **Problem.** Diffing raw traces (commands, file writes, code) is noise —
  vocabulary/syntax swamps the topic signal, and the embedder was not trained on
  code.
- **What changed.** Drift embeds each node's **explanation** — its output
  message (`agent_message`) — only. Cosine distance vs the mean of the buffered
  nodes' embeddings.
- **Intention.** Measure *what the agent is doing*, in natural language.
- **State.** Settled (`group-runner.ts`, node-completion path).

## 3. The drift bridge is local-only — a HF id silently disabled the flush

- **Problem.** `MEMORY_DRIFT_MODEL_DIR` first defaulted to the HF id
  `sentence-transformers/all-MiniLM-L6-v2`. But `scripts/embed-recognizer.py`
  loads with `local_files_only=True`, so **every drift embed threw** "model
  directory does not exist" → the error was caught → the flush **never fired**,
  with no crash and no note. This is the single bug that made a live run produce
  zero mid-DAG memory.
- **What changed.** Default is now a **local** dir, `data/drift-model`
  (`path.resolve`d). `scripts/fetch-drift-model.py` provisions it once from the
  SBERT venv; the dir is gitignored.
- **Intention.** Match the bridge's local-only contract; keep the ~90 MB model
  out of git while making provisioning one command.
- **State.** Fixed and verified — after the fix, `consolidatedAt` appeared on
  flushed nodes in a live run.

## 4. Consolidating a node twice (flush vs segment close)

- **Problem.** A node could be consolidated by an intra-task flush **and** again
  by the later segment-close consolidation.
- **What changed.** `flushNodeBuffer` stamps `GroupPlanNode.consolidatedAt`; the
  buffer builder (`task-buffer.ts`) **excludes** any node with `consolidatedAt`
  and, for a flush, restricts to an explicit `onlyNodeIds` set. The transcript is
  filtered to human turns + included nodes. `pipeline.runMemoryPipeline` gained
  an `onlyNodeIds` argument to carry the scope.
- **Intention.** Every node is consolidated **exactly once**; the segment close
  sweeps up only the leftover buffer.
- **State.** Settled. The interplay was traced: flush marks its nodes; segment
  close skips marked ones. (The one theoretical race — segment close between a
  flush's pipeline call and its mark — cannot occur in practice: a segment closes
  only when a *later* task starts, long after the flush completes.)

## 5. Mid-task notes did not surface in the UI

- **Problem.** `useGroupTask` fetched notes only once the task was flushed
  (`flushedAt != null`) — correct for task-end consolidation, but the node-drift
  flush lands notes **while the task is still running**, so 9 real notes sat in
  the store and the approval card stayed empty.
- **What changed.** `useGroupTask` now fetches memory on **every poll**, not only
  at flush. `memoryReady` still tracks `flushedAt`.
- **Intention.** Mid-DAG notes appear in the conversation the moment they exist.
- **State.** Fixed; the inline approval card renders pending notes live.

## 6. Verifiability without the server log

- **Problem.** The drift/embedding values live only in the server log, and
  `npm run … | tee`/`grep` crashes Vite with `EPIPE` (redirect to a file
  instead). We needed to confirm "embedding worked + consolidator fired" even
  when no notes and no log.
- **What changed.** `GroupPlanNode.driftScore` is persisted to the store, and
  `scripts/node-drift-stats.mjs` reports the drift distribution for threshold
  calibration. Together with `consolidatedAt`, the store alone proves the
  mechanism ran.
- **Intention.** The claim is verifiable from `tikitaka/.data`, not just logs.
- **State.** Settled.

---

## Files changed

| File | Change |
| --- | --- |
| `apps/server/src/config.ts` | `MEMORY_DRIFT_MODEL_DIR` (local default), `MEMORY_NODE_DRIFT_THRESHOLD` (0.55) |
| `apps/server/src/types.ts` | `GroupPlanNode.consolidatedAt`, `GroupPlanNode.driftScore` |
| `apps/server/src/memory/group-runner.ts` | node buffer + drift trigger + `flushNodeBuffer` + driftScore persistence |
| `apps/server/src/memory/task-buffer.ts` | `onlyNodeIds` scope + exclude consolidated + transcript filter |
| `apps/server/src/memory/pipeline.ts` | `runMemoryPipeline(segmentId, onlyNodeIds?)` |
| `apps/web/src/group/useGroupTask.ts` | fetch memory every poll |
| `scripts/fetch-drift-model.py` | provision the local drift model |
| `scripts/node-drift-stats.mjs` | threshold calibration from a run log |
| `README.md`, `.env.example` | drift feature + config keys |

## Setup required after pulling

1. The SBERT venv (same one as note routing — `apps/server/requirements-sbert.txt`).
2. **One new step:** `.venv-recognition/bin/python scripts/fetch-drift-model.py`
   (downloads `all-MiniLM` into `data/drift-model`, which is gitignored).

Without these, drift **degrades gracefully**: the embed is caught, no flush
fires, and segment-close consolidation still runs. Nothing crashes.

## Current state

- Server suite green (302), web suite green (76), typecheck clean.
- End-to-end verified on a live run: drift embedded → node buffer flushed
  mid-DAG (`consolidatedAt` set) → extractor produced notes → approval cards
  surfaced → notes land as skills on approval.
- Defaults: `MEMORY_NODE_DRIFT_THRESHOLD=0.55` (calibrate with
  `node-drift-stats.mjs` on real runs).

## Explicitly NOT in this branch (parked, unsolved)

- Prompt-level `MEMORY_TOPIC_DRIFT_THRESHOLD=0.90` is conservative: two coding
  prompts read as one subject, so a *coherent* task's memory waits for a
  clearly-different task. A tuning dial (topic-segment owner), not a bug.
- `writeGroupTaskSection` appends a per-task charter block to each agent's
  `AGENTS.md`, so N tasks leave N charter blocks (cosmetic bloat). Pre-existing
  workspace behavior, untouched here.
