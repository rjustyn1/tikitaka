# TODO 2 — Recognition Model, Approval Flow, Agent Profiles

Design agreed in discussion on 2026-08-30. This is new scope, not yet reflected
anywhere in `middlewaredoc/` — write a `RECOGNITION.md` component doc before or
alongside building this, following the existing `PLANNER.md`/`CONSOLIDATOR.md`
shape (purpose, inputs/outputs, code-level spec, tests).

## Decisions confirmed

- Agent skills remain private to each Agent workspace. A note may be projected
  into one private skill per recognized Agent, but skills are never shared across
  workspaces.
- Within one Agent, a note is assigned to only the highest-scoring skill.
- A confident threshold match may merge into the existing skill. An Agent
  fallback, low-confidence skill result, or new-skill proposal requires review
  before it is materialized.
- A new skill gets a minimal valid `SKILL.md` containing only its name and
  description in frontmatter, followed by managed note blocks as they are
  approved. The server owns the stable skill key and collision check.
- The recognizer will be a trainable SBERT-style semantic matching model, not
  only a frozen Ark embedding lookup. Ark/fake embeddings remain useful for the
  baseline and offline tests.
- Conflicting notes always require manual resolution; the system must not
  silently overwrite or merge contradictory memory.
- Thresholds are tuned against a reviewed holdout set using routing quality and
  false-grant behavior, rather than chosen arbitrarily.
- The generator first writes data under `data/recognition/`; a separate training
  script reads from that directory and writes checkpoints/evaluation artifacts
  there. Executable scripts remain under ignored `scripts_ignored/`.
- Runtime skill discovery uses `.agents/skills` for every Agent workspace; the
  configurable `.codex/skills` option is not part of this feature.

## Recognition dataset generation and ANCE preparation

The public datasets below are reference and warm-start material, not the source
of truth for our private `backend`/`frontend`/`qa`/`calculator` capabilities.
There is no public corpus that directly labels durable project notes with our
dynamic Agent profiles. The final authority must be a small, reviewed,
project-specific dataset with multi-agent labels.

- [ ] **Define the dataset contract before writing the generator.** Produce
      JSONL records with a redacted note text, optional title/description,
      `relevantAgentIds` (zero or more), `uncertainAgentIds`, an explicit
      out-of-scope flag, source/provenance, label origin, and the exact Agent
      profile snapshot/hash used for labeling. Keep labels in the dataset
      pipeline only — `targetAgentIds` must remain absent from the
      consolidator prompt and schema.

      Required label origins are `human`, `synthetic`, `weak`, and
      `hard-negative`. Synthetic and weak labels are training material, never
      silently promoted to gold evaluation labels.

- [ ] **Add one generator entry point under the ignored
      `scripts_ignored/` directory, planned as
      `scripts_ignored/generate-recognition-dataset.py`.** It should write all
      generated and downloaded artifacts only beneath `data/recognition/` and
      have resumable subcommands or modes for `fetch`, `normalize`, `generate`,
      `audit`, and `mine-hard-negatives`, with configurable output directory,
      seed, source selection, per-agent count, concurrency, and dry-run options.
      It must load `OPENAI_API_KEY` from the local `.env` at runtime (or an
      already-exported environment variable), never print or persist it, and
      fail clearly when an API-backed mode is requested without the key. Keep
      the key in `.env` only; do not add it to `.env.example`. A fixture/offline
      mode must work without the key.

- [ ] **Ignore the generator source path.** Add `scripts_ignored/` to the
      repository `.gitignore`. The generated `data/` directory is already
      ignored and must remain the sole output location; do not broaden the
      ignore rule to hide source code or documentation elsewhere.

- [ ] **Pull and record the public reference sources.** Add source adapters or
      importers for the following, preserving source split, dataset name,
      license/attribution metadata, and an immutable source manifest:
      - TCAndon-Router/router data for agent-description and multi-agent
        routing examples;
      - AgentSearchBench for task-to-agent sets and ranking labels;
      - Schema-Guided Dialogue for task/service schemas and unseen-service
        evaluation;
      - CLINC150, HWU64, MINDS14, and BANKING77 for intent variation and
        out-of-scope examples;
      - TAWOS and the help-desk ticket data for issue/assignment language;
      - NLBSE issue reports for realistic software issue text, without treating
        `bug`/`feature`/`question` as Agent labels.

      Do not train on a benchmark test split. Do not redistribute a source
      record unless its license permits it; otherwise store source identifiers
      and derived text only as allowed by that source's terms.

- [ ] **Create a canonical capability catalog for the demo.** Seed at least
      `backend`, `frontend`, `qa`, `planner`, `researcher`, `docs`, and
      `calculator`, with name, description, instructions, examples of positive
      work, and examples of neighboring work it should not own. The catalog
      must support arbitrary additional Agents and 2–12 active group members;
      no fixed three-Agent assumption may enter the data generator.

- [ ] **Generate project-specific durable-note examples with the OpenAI API.**
      Generate notes from capability-neutral scenarios and source examples,
      then ask a separate validation pass to label the applicable Agent set
      against the profile catalog. Include single-agent, genuinely multi-agent,
      ambiguous, out-of-scope, and negative examples. Include examples such as
      API/authentication notes for `backend`, layout/interaction notes for
      `frontend`, test/regression notes for `qa`, arithmetic/unit requests for
      `calculator`, and cross-cutting notes that correctly belong to more than
      one Agent.

      The generator must not ask the consolidator to choose recipients. The
      generated dataset may contain labels because it is training/evaluation
      data, but every generated label must be marked `synthetic` until reviewed.

- [ ] **Apply privacy, quality, and leakage checks before writing records.**
      Redact secrets, tokens, credentials, emails, and identifying data before
      sending text to the API or embedding it. Reject empty, malformed,
      duplicated, prompt-injected, or excessively long records. Keep code and
      stack traces where they are useful for backend/QA recognition, but remove
      secrets. Split by source task/dialogue/thread and time where available so
      paraphrases from one source cannot cross train/validation/test.

- [ ] **Separate gold, silver, and evaluation artifacts.** Write distinct
      `train.jsonl`, `validation.jsonl`, `test.jsonl`, and `manifest.json` files
      plus a label-quality report. Use reviewed project notes for the gold test
      set; reserve public-derived and LLM-generated records for warm-start or
      silver training unless manually verified. Include an OOS/none-of-the-
      above set and a deliberately difficult same-domain confusion set.

- [ ] **Add ANCE-style hard-negative mining as a later generator phase.** Start
      from a frozen embedding baseline, score each note against all current
      profile snapshots, and select high-scoring incorrect profiles as
      `hard-negative` pairs. Repeat after each recognizer checkpoint or
      calibration update. For the runtime's 2–12 member group, use an exact
      cosine scan rather than introducing an ANN index; this preserves ANCE's
      realistic-negative principle while keeping the implementation small.
      Hard negatives must include backend/frontend, backend/qa, planner/docs,
      and calculator/researcher confusions where those profiles are present.

- [ ] **Add a separate SBERT-style training script after data generation.**
      Plan this as `scripts_ignored/train-recognizer.py`, reading the reviewed
      and silver JSONL artifacts from `data/recognition/` and writing the model
      checkpoint, tokenizer/configuration, calibration report, and evaluation
      outputs back under `data/recognition/`. Train a shared note/profile
      encoder with multi-positive contrastive or ranking loss: all relevant
      Agents are positives, while non-relevant same-group Agents and sibling
      skills are negatives. The exported model must accept new Agent and skill
      descriptions without a fixed Agent-ID classifier head.

      Ark remains a serving/baseline option, but the trainable recognizer uses
      an open SBERT-compatible encoder so its weights can actually be updated.
      The training script must support CPU/small-fixture execution for tests,
      deterministic seeds, checkpoint resume, and a separate held-out
      evaluation command.

- [ ] **Define the acceptance metrics and audit output.** Report set precision,
      recall, F1, Jaccard, exact match, per-Agent recall, fallback/OOS recall,
      false-grant rate, and the fraction of notes requiring review. Report
      threshold matches separately from fallback matches. No automatic routing
      rollout is allowed until the threshold is calibrated on reviewed data and
      the false-grant target is explicitly recorded.

- [ ] **Test the generator without a live API.** Add deterministic fixtures for
      every source adapter, mocked OpenAI responses, retry/rate-limit handling,
      resume behavior, schema validation, redaction, deduplication, split
      isolation, provenance, and API-key absence. The normal repository check
      must never call the network merely because the generator exists.

## Recognition model — replaces the consolidator's own routing

- [ ] **Strip `targetAgentIds` out of the consolidator's schema and prompt
      entirely.** `consolidator.ts` should only extract content, severity,
      description, and provenance (`sourceRunIds`/`sourceSpanIds` or
      `sourceEntryIndexes`/index-based, matching the existing pattern) — never
      decide who receives a note. That decision moves entirely to the new
      recognizer below.

- [ ] **Build a `Recognizer` behind an `EmbeddingClient` interface**, mirroring
      the pattern already used twice in this codebase (`ExtractorClient` in
      `extractor-client.ts`, and the model-call boundary in `planner.ts`): one
      model call behind a tiny interface, a fake client for offline tests, a
      validation ladder before anything is trusted.
      ```ts
      interface EmbeddingClient {
        embed(text: string): Promise<number[]>;
      }
      class ArkEmbeddingClient implements EmbeddingClient { ... }   // real
      class FakeEmbeddingClient implements EmbeddingClient { ... }  // deterministic, offline
      ```

- [ ] **Agent profile embeddings ("enrollment"), cached, not recomputed per
      note.** For each candidate agent, embed `name + description +
      instructions` and cache the vector (e.g. on the `Agent` row, or a small
      companion store array) alongside a hash of the source text — recompute
      only when that text changes, not on every note.

- [ ] **Matching rule — threshold-based, with a single-best-guess fallback**
      (decided in discussion, not the earlier "discard on zero matches"
      proposal):
      ```
      scores = { agent: cosineSimilarity(noteEmbedding, agent.profileEmbedding)
                 for agent in group members }
      matches = { agent for agent in scores if scores[agent] >= τ }

      if matches is non-empty:
          target = matches                # threshold match, possibly several agents
      else:
          target = { argmax(scores) }     # fallback: single best guess, always exactly one
      ```
      This is the actual fix for "a note might be needed by more than one
      agent" — a threshold naturally returns 0, 1, or many matches, which an
      LLM asked to enumerate `targetAgentIds` in one shot does not reliably do.

- [ ] **Tag every match with `matchKind: "threshold" | "fallback"` plus the raw
      similarity score, and carry it through to the `GrantRecord`/ledger.** A
      forced best-guess match is a materially weaker claim than a confident
      threshold match, and the ledger should be able to show the difference —
      *"granted to Backend, confidently (0.86)"* vs. *"granted to Backend,
      best-guess fallback (0.31, nothing cleared the threshold)"*. This
      strengthens the existing audit story rather than adding a parallel one.

- [ ] **The group-membership ceiling doesn't change.** Whatever the recognizer
      outputs still gets intersected with actual group members server-side —
      recognition never gets to route outside the group, same hard boundary
      `validateCandidates()` already enforces today.

- [ ] **Add hierarchical skill grouping after Agent recognition.** Agent
      recognition chooses the eligible Agent set first; it must not search or
      merge across private Agent workspaces. For each recognized Agent, load
      only that Agent's current skill profiles (name, description, approved
      examples, and stable `skillKey`), retrieve/rerank the note against them,
      and apply this rule:

      ```text
      an existing skill >= skill threshold:
          assign the note to that skill and append one managed memory block
      no existing skill >= skill threshold:
          create a reviewed new-skill proposal for that Agent
      ```

      A note may be assigned to different skills in different recognized
      Agents. A no-match must never be silently forced into the nearest skill.
      The first implementation may use exact scoring across the current skill
      list; a cross-encoder or OpenAI reranker can be added behind the same
      interface for ambiguous top candidates. The runtime catalog is small, so
      an ANN index is unnecessary.

- [ ] **Persist skill assignments as an auditable projection.** Store the
      selected `skillKey`, skill path, score, match kind, and note id alongside
      the note/grant decision. `SKILL.md` is a materialized view, not the source
      of truth. Use managed `memory:<noteId>` blocks so adding a note updates an
      existing skill without overwriting its other memories; revoking a note
      removes only its block and deletes the skill directory only when empty.

- [ ] **Separate relevance from compatibility.** A high similarity score only
      means that a note concerns the same topic. Before merging, check that it
      does not contradict the existing skill memories. Contradictions, invalid
      generated names, collisions, and new-skill creation require review rather
      than automatic merging.

## Approval flow

- [ ] **Severe notes: always require approval, regardless of match
      confidence.** Unchanged from today's `requiresHumanReview()` — severity
      wins outright, stacks on top of everything else here, not replaced by
      it.

- [ ] **Normal notes, threshold match: apply directly, no approval wait** —
      but this bypasses *only* the confidence-based trigger. **Confidence is
      independent of safety** (explicit decision): `redactionFired` and
      `quarantineHit` remain separate, AND-ed conditions that force review
      regardless of how confident the routing match was. A confidently-routed
      note with a secret in it still goes to review — routing confidence never
      overrides content safety.

- [ ] **Normal notes, fallback match: always route to approval**, same
      pending-review path as today's severe/redacted/quarantined/broadly-routed
      notes. Add `matchKind === "fallback"` as one more OR-ed condition in
      `requiresHumanReview()` — one line, not a new mechanism.

- [ ] **The note-taker (consolidator) generates the skill's file name, not a
      mechanical derivation.** Today's `noteSlug()` in `workspace-memory.ts`
      derives a slug from `note.description` (truncate, slugify, append a
      note-id suffix). Add a `name`/`slug` field to what the consolidator
      generates per note instead, so the note-taker picks something meaningful
      rather than a mechanically truncated description.

- [ ] **Invalid/collided generated names reject the whole note** (explicit
      decision, not a silent fallback to the mechanical slug). Validate the
      model-provided name server-side the same way `planner.ts` already
      refuses to trust a model-authored file path (`WORK_AREAS`: *"the model
      never writes a path"*) — sanitize to safe filename characters, cap
      length, and check for a collision against that agent's existing landed
      notes. If it fails any of those checks, or is empty, the candidate note
      is dropped at validation, same failure class as a bad UUID/index
      citation today — not landed under a fallback name.

- [ ] **The one-`.md`-per-note skills folder structure already exists — no new
      work needed there.** `writeSkill()` in `workspace-memory.ts` already
      writes `<agent-workspace>/.agents/skills/<slug>/SKILL.md`, one directory
      per note. What's new is only the naming source (above), not the
      structure.

## Memory reaching the model — no thread-freshness dependency

- [ ] **Fold currently-landed governed memory into every group turn's prompt
      explicitly, rather than relying on Codex noticing a changed
      `AGENTS.md`/skill file on a resumed thread.** Correction from
      discussion: neither "a resumed thread re-reads changed files" nor "it
      doesn't" was ever actually verified in this project — the old
      `DECISIONS.md` (since removed from `middlewaredoc/`) stated the risk in
      hedged language and built the `freshThread` proof beat specifically to
      *sidestep* the uncertainty for the demo, not because the resumed case
      was proven broken. Rather than resolve that uncertainty or force every
      group turn onto a fresh thread (costly — discards conversation
      continuity, re-primes context every turn), extend `buildTurnPrompt()` /
      `buildContextPacket()` in `group-prompt.ts` to include the agent's
      currently-landed memory as one more explicit section of the assembled
      prompt — the same mechanism already used to inject prior group messages
      and dependency outputs, not a new one. This makes the question moot:
      the agent doesn't need to notice anything changed on disk, because it's
      told directly, every turn, same as everything else already in the
      prompt.

      **Concrete design — touches exactly two places, both already doing this
      job for a different field (node-role identity, per
      `buildTurnPrompt()`'s own doc comment: *"a resumed Codex thread may not
      re-read a changed instructions file, so identity for THIS turn has to
      travel with the prompt"* — same rationale, same fix, different field):**

      1. `TurnPromptInput` (`group-prompt.ts`) gains one field:
         ```ts
         governedMemory: readonly Pick<MemoryNote, "content" | "description" | "severity">[];
         ```
      2. `buildTurnPrompt()` gains one section, distinguishing severity the
         same way landing does (always-loaded vs. situational):
         ```ts
         if (input.governedMemory.length > 0) {
           sections.push("[Your governed memory]");
           for (const note of input.governedMemory) {
             sections.push(
               note.severity === "severe"
                 ? "- (always apply) " + note.content
                 : "- (apply when: " + note.description + ") " + note.content,
             );
           }
           sections.push("");
         }
         ```
      3. The one call site, `group-runner.ts:463` (`buildTurnPrompt({...})`
         inside `runPlanNode()`), passes it — the `database` snapshot is
         already in scope there (it's what `groupMessages`/`dependencyOutputs`
         are already pulled from a few lines above), so this is one more
         filter over already-loaded data, not a new store read:
         ```ts
         const governedMemory = database.notes.filter(
           (note) => note.status === "active" && note.targetAgentIds.includes(node.agentId),
         );
         ```

      **Why the content can't drift out of sync with what's landed:**
      `note.content` is the exact same field `workspace-memory.ts`'s
      `appendAgentsMemory()`/`writeSkill()` already write into
      `AGENTS.md`/`SKILL.md` — this reads the same value a second time, it
      doesn't maintain a second copy.

      **Scope:** group turns only. Solo runs are unaffected and keep using
      `freshThread` (A5) + Codex's native file-reading — they have no
      curated-context mechanism to extend the same way.

      **Trade-off, worth a decision but not blocking a v1:** this bypasses
      Codex's own soft relevance-matching for group turns specifically —
      consistent with how group turns already work (messages are explicitly
      curated via `buildContextPacket()`, not left to Codex's judgment
      either), but it means no cap on this section's size yet. An agent that's
      accumulated memory across many past tasks gets all of it injected into
      every future turn, unbounded. `task-buffer.ts` already solves the same
      class of problem (`MAX_TASK_BUFFER_CHARS`) — worth capping this section
      the same way once an agent's accumulated memory is more than a
      hypothetical, not needed when each agent typically holds a handful of
      notes.

- [ ] Solo runs keep using `freshThread` (A5) as today — this item is only
      about group task turns, which never had a freshness mechanism at all.

## Agent profile UI

- [ ] **New profile view: click an agent → see name, description,
      instructions, and its currently-landed notes.** Build on both surfaces
      (decided in discussion):
      - the existing solo Agents sidebar/detail view (`App.tsx`), and
      - the Teams agent-profile panel already scoped in `TODO.md`'s UI/UX
        section (the Discord/Slack-style right-hand member panel) —

      same component, reachable from both places, backed by the same data
      `LandedMemoryPanel` already fetches (`GET /api/agents/:id/memory`) plus
      the `Agent` row's own `name`/`description`/`instructions` fields — no
      new backend endpoint needed, just a shared component and two places
      that render it.

## Open follow-up, not blocking this round

- Whether the recognizer's threshold τ should be a flat global constant or
  calibrated relative to the group's own baseline pairwise similarity (raised
  earlier in discussion, not resolved) — start with a flat threshold, revisit
  if fallback matches turn out to fire far more often than threshold matches
  in practice.
