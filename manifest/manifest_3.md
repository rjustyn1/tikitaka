# Manifest 3 — Person 3: Governed Memory & Extraction

Revise pass against `TODO_Instructions/Person_3.md` (all 4 work items).
Date: 2026-08-30. Author: Person 3 (Lionel).

Status: **typecheck clean**, full `apps/server` vitest suite **148 tests green**.
Nothing outside Person 3's owned file list was touched. Not yet integrated with
a live Ark model (the offline path — tests/demo — is fully exercised).

---

## Scope boundaries held

- Edited **only** Person 3's owned files (config.ts, .env.example, memory/*.ts +
  matching tests). No changes to group-runner, workspace, index.ts, app.ts, web.
- The persisted note contract (`CandidateMemoryNote.sourceRunIds` /
  `sourceSpanIds`, both UUID strings) is **unchanged** — item 3 changes are
  confined to the extractor prompt + parsing, so Person 4's API DTOs are
  untouched.
- Agent **routing** stays on real agent UUIDs (already membership-validated in
  `validateCandidates`). Item 3's index scheme is scoped to **run/span
  provenance only**, per the instruction wording.
- The `$CODEX_HOME` governed-memory startup-assertion item from `TODO.md` is
  **NOT** in this manifest — under the Person_3.md partition it lives in
  `index.ts` / `workspace.ts` (not Person 3's files). Left for that owner.

---

## Changes made

### Item 1 — Extractor timeout is threaded (verified + test added)
The timeout already flowed `AppConfig.memoryExtractTimeoutMs → createMemoryPipeline
→ RealMemoryPipeline → Consolidator → buildExtractorRequest → ExtractorRequest.timeoutMs
→ ArkExtractorClient(input.timeoutMs)`. The old hardcoded 30s literal was already
gone (replaced earlier by a 120s fallback constant).
- **`consolidator.test.ts`**: added a test using a capturing `ExtractorClient`
  that asserts `new Consolidator(client, 4242)` passes `timeoutMs: 4242` into the
  extractor request. Locks the acceptance criterion.

### Item 2 — One validated config source (removed the env stub)
- **`extractor-client.ts`**: deleted `memoryConfigFromEnv()` entirely (also
  removed its last `MEMORY_EXTRACT_TIMEOUT_MS ?? 30_000` vestige).
- **`pipeline.ts`**: removed the `memoryConfigFromEnv` import; `createMemoryPipeline(
  store, config, options)` — `config` is now a **required** parameter (no
  `= memoryConfigFromEnv()` default). `AppConfig` (a structural superset of
  `MemoryConfig`) is the single source, passed straight through by index.ts.
- **`extractor-client.test.ts`**: removed the `memoryConfigFromEnv` describe block
  and its import.

### Item 3 — Provenance by integer index, not UUID echo
- **`consolidator.ts`**:
  - New `collectSources(taskBuffer)` → `{ runIds, spanIds }` in first-appearance
    order. Array position + 1 is the 1-based index the prompt shows and the model
    cites back. Called once in `buildExtractorRequest` (render) and once in
    `consolidate` (resolve) so numbering is identical.
  - `buildExtractorRequest`: Node-outputs block now prints `run N` and `[span N]`
    (small integers) instead of raw UUIDs.
  - `SYSTEM_PROMPT`: asks for `sourceRunIndices` / `sourceSpanIndices` as the small
    integers shown — explicitly "do not copy any long id strings".
  - Output schema: `sourceRunIndices` / `sourceSpanIndices` as
    `z.array(z.coerce.number().int().positive()).optional()` (coerce tolerates a
    string `"2"`; non-ints dropped).
  - `normalizeCandidate(raw, input, sources)`: resolves each index → real UUID
    (`ids[index - 1]`), drops out-of-range/duplicate indices. Stored note still
    carries real `sourceRunIds` / `sourceSpanIds` UUIDs.
  - `validateCandidates` unchanged — still filters resolved UUIDs against the real
    buffer sets and preserves fail-open (bad citation dropped, note survives).
- **`extractor-client.ts`**: `FakeExtractorClient` rewritten to emit index
  citations. It scrapes agent UUIDs from the "Agents you may target" section and
  the printed `run N` / `[span N]` integers (new `collectInts` helper; old
  `collectAll` removed), then emits `sourceRunIndices` / `sourceSpanIndices`.
- Tests updated to the index format: `consolidator.test.ts` fixtures + the
  "drops out-of-range span index" case; `extractor-client.test.ts` FIXTURE_PROMPT
  + fake expectations.

### Item 4 — Fake extraction explicit & safe
- **`config.ts`**: `MEMORY_EXTRACTOR` schema default flipped `"fake" → "ark"` so a
  normal run/demo does real extraction. Tests stay offline (they opt into `fake`
  explicitly — `integration-e2e` sets it; unit tests build `FakeExtractorClient`
  directly). Comment added explaining this.
- **`extractor-client.ts`**: loud `TEST/DEMO ONLY — NOT a real extractor` doc
  block on `FakeExtractorClient` (canned + topic-blind warning).
- **`.env.example`**: already had `MEMORY_EXTRACTOR=ark` and
  `MEMORY_EXTRACT_TIMEOUT_MS=120000` — no change needed.

### Files touched
```
apps/server/src/config.ts
apps/server/src/memory/consolidator.ts
apps/server/src/memory/consolidator.test.ts
apps/server/src/memory/extractor-client.ts
apps/server/src/memory/extractor-client.test.ts
apps/server/src/memory/pipeline.ts
```

---

## TODO for whoever integrates this (into their branch / the trunk)

1. **`createMemoryPipeline` signature changed — `config` is now required.**
   Any caller must pass a config (AppConfig works — structural superset). Current
   callers already comply: `index.ts:22` and `integration-e2e.test.ts:46`. If your
   branch added another caller relying on the old `= memoryConfigFromEnv()`
   default, pass `config` explicitly.
2. **`memoryConfigFromEnv` is gone.** If your code imported it from
   `extractor-client.js`, switch to the real `AppConfig` / `loadConfig()`.
3. **Extractor prompt format changed** (`run N` / `[span N]` instead of UUIDs) and
   the extractor JSON now uses `sourceRunIndices` / `sourceSpanIndices`. If you
   built a custom `ExtractorClient` or asserted on the old prompt/JSON shape,
   update it. The **persisted** note fields are unchanged, so store/API/web need
   nothing.
4. **Default extractor is now `ark`.** Real/demo runs will try to reach Ark unless
   `ARK_*` is configured. For offline runs set `MEMORY_EXTRACTOR=fake` (or `off`)
   explicitly. Confirm your `.env` sets `MEMORY_EXTRACTOR` — don't rely on the old
   silent `fake` default.
5. Re-run `npm run check` after merge (full check happens post-integration per the
   README concurrency rules).

---

## TODO for me (Person 3) — open items

1. **Live Ark validation.** The index-based provenance path has only been
   exercised against `FakeExtractorClient` and stub JSON. Run one real task with
   `MEMORY_EXTRACTOR=ark` + valid `ARK_*` to confirm a real model reliably cites
   the small integers and notes land with correct provenance. (This was the exact
   failure mode UUID-echo caused; needs a live check to call it fixed end-to-end.)
2. **Remaining stub seam (unchanged, still open):** Person 2 workspace helpers
   `replaceManagedBlock` / `removeManagedBlock` — currently local pure fns in
   `workspace-memory.ts`. Per plan, Person 3 does the swap (delete locals, import
   from `../workspace.js`) once Person 2 lands them. Not part of this pass.
3. Consider indexing agent ids too (routing) if transposition-dropped routes show
   up with a real model — deliberately out of scope here since routing is already
   membership-validated and item 3 was scoped to run/span.
