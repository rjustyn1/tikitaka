# ⚠️ Outdated — superseded architecture

These four docs (`DESIGN.md`, `SPEC.md`, `DEMO.md`, `DOCS.md`) describe an
**earlier** version of the memory-governance design — the prompt-boundary
injection model with a deterministic lexical selector.

They are kept for history only. **Do not cite or build from them.**

The current design lives in [`../ARCHITECTURE.md`](../ARCHITECTURE.md):

- `ARCHITECTURE.md` — the current design, the problem it solves, the full
  pipeline, and where it plugs into the existing codebase (§12)

Key things that changed:

| Old (here) | New (`latestdoc/`) |
|---|---|
| Memory injected at the **prompt boundary** (a delimited reference block) | Memory landed as **`AGENTS.md` entries** (severe) and **native Codex skills** (normal) |
| A deterministic **lexical selector** decides relevance per run | **Codex-native skill matching** decides relevance; security is enforced by **file placement** |
| Per-run **injected/withheld audit** record | **Write-time grant ledger**; workspace file presence self-evidences enforcement |
| Consolidator + a selector | **One consolidator LLM** (routing folded in); no separate selector |
