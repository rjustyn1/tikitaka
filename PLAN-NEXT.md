# Plan — incremental (node-level) consolidation + cleanup

## Direction (committed)
Add **node-level, embedding-based drift** that flushes to the consolidator
**mid-DAG** (intra-task), on top of the existing **prompt-level** segmentation
across tasks. Drift signal = each node's **explanation span** (agent_message /
reasoning), compared by **embedding cosine** — NOT bag-of-words, NOT file/code.

---

## 1. Decisions to lock first (they gate the build)

- **D1 — Drift embedding model.** Reuse the fine-tuned SBERT, or a stock general
  sentence-embedder? → **Recommend:** test the existing checkpoint first (the
  drift logging tells you if it separates); add a stock `all-MiniLM`-class model
  *only if it doesn't*. No retraining either way — worst case is a download.
- **D2 — Shared code.** Persist per group, or keep fresh per task? → Tension:
  persisting adds a **second continuity channel** (weakens the "memory carries
  knowledge" thesis) and lets a *withheld member* read facts from the code. →
  **Recommend:** keep fresh unless you deliberately want the "incremental
  project" framing; then lean the memory proof on the *non-member*.
- **D3 — Coexistence.** Node-level intra-task flush AND prompt-level cross-task
  segment, or replace one? → **Recommend:** keep both (fine + coarse).

## 2. New-architecture build  (backend — friend's area)

- **B1** Drift signal: pull each completed node's **explanation span**; embed
  (per D1); cosine vs the running **buffer centroid** (mean of prior nodes).
- **B2** Threshold: calibrate from real runs (instrumentation already in —
  `[node-drift]` logs + `scripts/node-drift-stats.mjs`).
- **B3** Partial flush: consolidate a **buffer of completed nodes** mid-task when
  drift crosses the threshold. Bookkeeping so a node consolidates **once**; do
  not extract while parallel siblings mutate shared state (snapshot completed
  outputs only). This touches `flush-trigger` + `topic-segment` + the runner.
- **B4** Consolidator input: accept **partial buffers**, not only whole segments.
- **B5** Switch the drift logging from bag-of-words → **embeddings** (once D1),
  ideally logging BOTH side by side first to prove the choice.

## 3. Bounded fixes  (independent, low-risk, do anytime)

- **F1 — Remove the role picker + stop feeding role to the LLM.**
  - Frontend: delete the `<select>` in `GroupEditor.tsx`; derive the label from
    the agent (`deriveRole`). Fixes the docstring/code mismatch too.
  - Backend: drop the `Role:` line from `buildTurnPrompt` and the role column
    from the charter roster (`group-prompt.ts`); rely on `description`.
- **F2 — Fix the misleading "no governed memory" message.** On a *cancelled*
  task it says "no step completed successfully" even when steps completed.
  Distinguish "cancelled → consolidation skipped" from "no completed nodes"
  (`GroupWorkspace.tsx` panel-note + the `flushGaveUp` reason).

## 4. Optional / later

- **O1** Improve the **planner system prompt** — better decomposition, right
  agent assignment, fewer nodes (helps token burn). NOT related to KL.
- **O2** Demo Task 2 wording → self-contained (moot if D2 = persist code).
- **O3** Fold `npm run verify:live` into the e2e checklist.

## 5. Sequencing

1. **Lock D1–D3.**
2. **F1 + F2** in parallel (independent, quick, mostly done-able now).
3. **B1–B5** (gated by D1 + D3).
4. **O1–O3** as capacity allows.

## Ownership
- **Friend** (KL / consolidator / planner / workspace): all of §2, D2, O1.
- **Shared** (you + friend): F1 (frontend + prompt), D1, D3.
- **UI/message**: F2, O2.
