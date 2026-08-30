# TODO — Things To Revise

Found while spinning up and demoing the app on 2026-08-30. Grouped by area.
Checked items include the evidence so whoever picks this up doesn't have to
re-derive it.

## Build / dependencies

- [ ] **`apps/web` fails `npm run build` / `tsc -b`.** `@testing-library/react`,
      `@testing-library/jest-dom`, and `@testing-library/user-event` are listed
      in `apps/web/package.json` devDependencies but are not present in
      `node_modules` — `ls node_modules/@testing-library` comes back empty.
      `tsc -b` includes the test files (`GroupEditor.test.tsx`,
      `panels.test.tsx`, `useGroupTask.test.ts`, `test-setup.ts`), so the whole
      web build fails on missing types (`toBeInTheDocument`, `toBeDisabled`,
      etc.) and a missing module. Fix: `npm install` at the repo root to sync
      workspace deps, then confirm `npm run build` passes end to end.
      (`npm run dev` still works via Vite, which skips type-checking, so this
      was invisible until a production build was attempted.)

## Local dev environment

- [ ] **`.env` is the Docker/container variant and breaks bare `npm run dev`.**
      It sets `APP_DATA_DIR=/app/data`, `AGENT_WORKSPACE_ROOT=/app/workspaces`,
      `CODEX_HOME=/app/codex-home` — container-only paths. Sourcing it directly
      on a Mac host crashes the server (`ENOENT: no such file or directory,
      mkdir '/app'` in `writeCodexConfig`). `DEMO.md` and `README.md` both know
      this and say "export only `ARK_*` vars," but there's no local-friendly
      `.env.local` / `.env.development` matching the README's literal
      "`cp .env.example .env` then `npm run dev`" instructions. Either fix the
      README's local-dev section to say so explicitly, or ship a second env
      file for the non-Docker path.

- [ ] **`APP_DATA_DIR`/`AGENT_WORKSPACE_ROOT`/`CODEX_HOME` defaults resolve
      relative to `cwd`, and npm workspace scripts change `cwd`.**
      `npm run dev` (root) invokes `apps/server`'s `dev` script with
      `cwd = apps/server`, so the default `.data` resolves to
      `apps/server/.data` — a different directory than
      `node scripts/seed-demo.mjs` produces when run from the repo root
      (`<repo>/.data`). Result: seeding "worked" but the running server showed
      an empty Teams screen, because it was reading a different, freshly
      auto-created empty store. Worked around this session by exporting
      absolute `APP_DATA_DIR`/`AGENT_WORKSPACE_ROOT`/`CODEX_HOME` before
      `npm run dev`. Fix properly: either pin these to absolute repo-root paths
      in a committed local-dev env file, or make `npm run dev` run from the
      repo root instead of per-workspace cwd.

## UI / UX

- [ ] **Teams have no sidebar, unlike Agents.** `App.tsx:742-763` gives Agents a
      persistent sidebar list (`.agent-list`) — every agent as a card with name,
      description, and status dot, always visible, one click to switch, in
      either view. Teams have no equivalent: in `group/GroupWorkspace.tsx:257-272`,
      switching teams is a plain `<select>` dropdown buried in the content
      header, and it's only rendered `if (groups.length > 1)` — with a single
      team there's no team list or selector anywhere, you just land on whatever
      was already active. Bring Teams up to the same level as Agents: a
      persistent sidebar list of teams (name + member roster/status), visible
      whenever the Teams view is active, the same way `.agent-list` works today.

- [ ] **Show each plan node's actual instruction/mini-plan, not just its role
      name.** `ChainPanel` (`group/panels.tsx:73-118`) renders `node.nodeRole`
      (e.g. the raw string `"security-review"`), a status pill, the agent
      name, and — once finished — the raw output. It never shows what the
      agent was actually told to do, or `node.expectedOutput` (which *is*
      already persisted and available, just unused in this panel). Sitting
      under a tab literally labeled "Plan" with no instruction text visible is
      what made the security-review step read as "planning" — the wiring was
      correct, the display just gave no way to tell. Needs the node
      `instruction` field from the Planner section below, then rendered here.

- [ ] **Render Teams as a group chat with real agent profiles — a Discord/Slack
      shape, not a form-and-tabs dashboard.** Two gaps together are what make
      it not read as a chat app today:
      1. `GROUP-CHAT-DESIGN.md`'s own one-line summary describes the feature
         as "one shared conversation to the user" — the Transcript tab
         (`TimelinePanel` in `panels.tsx:121-172`) already renders turns
         chat-style (speaker, timestamp, content, in seq order), but it's
         buried as one of seven equal-weight tabs behind
         Plan/Context/Review/Ledger/Workspaces/Proof instead of being the
         primary surface.
      2. **There is no member/profile panel at all** — only a one-line strip
         of tiny chips (`roster-inline` in `GroupWorkspace.tsx:245-254`: a
         colored role-dot, name, and role in italics, crammed into the page
         header). No avatar, no live status, and no link to what that agent
         currently knows — which the app already tracks
         (`LandedMemoryPanel`), just buried as its own separate "Workspaces"
         tab instead of living next to the person it describes.

      Target shape: teams list (left, from the sidebar item above) → chat
      feed as the main view (center) → a real agent-profile panel (right) —
      avatar, name, role, live status for the running task, and what memory
      that agent currently holds — with plan/review/ledger/governance as
      secondary panels around that core, not equal tabs competing with the
      conversation itself.

## Planner (the plan is hardcoded)

- [ ] **The task plan is a fixed constant, not a planner.** `V1_CHAIN` in
      `apps/server/src/memory/group-chain.ts:43` is the same five role-bound
      nodes for every task (`backend-contract → frontend-plan →
      security-review → backend-impl → frontend-impl`), each node just
      depending on the one before it. `buildChainNodes()` stamps that constant
      into plan-node rows, and `GroupRunner.executeGroupTask()`
      (`memory/group-runner.ts:308-327`) is a plain `for` loop over the result.
      The user's task `prompt` is only interpolated into each node's turn text
      — it never affects which nodes exist, how many, their roles, or the
      dependency shape. Even the "STRETCH" scope on file — a 7-node
      branch/join template — is a *second* hardcoded constant, not a planner
      that reads the task and decides structure.

- [ ] **`DECISIONS.md`'s A4 call ("v1 is a hardcoded sequential chain, exactly
      three roles") should be revisited, not treated as settled.** It locked
      in the fixed-3-role, fixed-5-node shape that's now causing both the
      planner problem and the UI confusion above. Don't build against it as
      ground truth — the two items below supersede it.

- [ ] **Suggested design (from discussion): the planner reads each agent's
      `description` and assigns steps from that.** Instead of a fixed
      backend/frontend/security template, give the planner the task prompt
      plus every candidate agent's `description`, and have it decide who's
      relevant, what order they go in, and a short instruction (a "mini plan")
      per agent — for however many agents the group actually has. This fits
      the same shape already used elsewhere in this codebase for LLM-generated
      structured output (`consolidator.ts`: one call behind an
      `ExtractorClient` interface, a fake client for offline tests, a strict
      Zod schema on the output, a validation ladder before anything is
      trusted) — reusing that pattern here keeps the planner testable without
      a live model and consistent with how the rest of the pipeline is built.
      Open questions before building: a hard cap on node count (mirroring
      the consolidator's max-5-notes cap), cycle rejection on the generated
      `dependsOn` graph, and who assigns `fileOwnershipHints`/`runtimeLocks`
      per node — the planner, or a fixed rule layered on top of its output.

- [ ] **Drop the fixed 3-role membership constraint; let a group hold any
      number of agents.** Not scope creep — closer to the *original* design:
      `GROUP-CHAT-DESIGN.md`'s "Locked Decisions" describe membership as
      `"explicit Agent toggles"` (no fixed count), and its "First Version
      Boundary" defers free-form planning as later scope, not something to
      block forever. The exact-3-roles rule is hardcoded in three places —
      `GroupRole`/`AgentGroup.members` in `types.ts`, `GROUP_ROLES` /
      `findMembershipError()` in `group-chain.ts`, and the
      `z.array(...).length(3)` schema in `app.ts` — plus the group-creation UI
      (`GroupEditor.tsx`), which assumes exactly one toggle per fixed role.
      All four need to change together.

- [ ] **Persist each node's instruction, not just a template lookup.** A
      dynamic planner has no fixed `nodeRole → instruction` key to look up
      (today's `templateFor()` in `group-chain.ts`), so `GroupPlanNode` needs
      its own `instruction: string` field, saved like `expectedOutput` already
      is — the data the UI/UX item above needs to render.

## Memory pipeline (runs after the planned DAG completes)

Sequencing note: these run downstream of the Planner section above. In
`group-runner.ts`, `startGroupTask()` builds the node graph → `executeGroupTask()`
runs every node → `finishGroupTask()` → `maybeFlush()` → only then does
`memoryPipeline.runMemoryPipeline()` fire, which is what calls the consolidator
below. So the planner decides the DAG, the DAG runs to completion, and only
after that does extraction happen over what it produced.

- [ ] **The configured extractor timeout is dead — hardcoded to 30s.**
      `consolidator.ts:109`, `buildExtractorRequest()`, sets
      `timeoutMs: 30_000` as a literal. `MEMORY_EXTRACT_TIMEOUT_MS` exists in
      `config.ts` and `MemoryConfig.memoryExtractTimeoutMs` exists specifically
      to carry that value into the extractor call, but nothing passes it in —
      changing the env var has zero effect.

- [ ] **The memory pipeline reads config from `process.env` directly instead
      of the app's real `AppConfig`.** `pipeline.ts:142` calls
      `memoryConfigFromEnv()`, a stub adapter in `extractor-client.ts` whose
      own comment says to delete it "once Person 1 adds `memoryExtractor`/
      `memoryExtractTimeoutMs` to `AppConfig`." That already happened — both
      fields are on `AppConfig`, validated through the same Zod schema as
      everything else — but the stub was never removed. Two independent,
      unvalidated-vs-validated sources of truth for the same settings.

- [ ] **Design risk: the extractor is asked to echo back exact UUIDs, which
      `DECISIONS.md`'s own corrections already warned against.** The
      consolidator's schema requires `sourceRunIds`/`sourceSpanIds` as
      `z.string().uuid()`, and the prompt lists real run/span UUIDs for the
      model to copy verbatim. `validateCandidates()` does an exact-string
      match against the buffer, so any transposed character in a 36-char UUID
      silently drops the whole note — no error, just zero notes (the
      documented fail-open behavior, but quietly so). `DECISIONS.md` already
      recommends the fix: short integer indices into the buffer, mapped back
      to real ids server-side, instead of asking the model to reproduce UUIDs
      character-for-character. Not shipped. The `FakeExtractorClient` sidesteps
      this by regex-extracting real UUIDs out of its own prompt rather than
      generating them, so the seeded demo never exercises this failure mode —
      it would only show up with `MEMORY_EXTRACTOR=ark` against a real model.

- [ ] **Stop defaulting to the fake extractor for real usage — make `fake`
      something you opt into, not something that happens silently.**
      `config.ts:36` defaults `MEMORY_EXTRACTOR` to `"fake"`, and neither
      `.env` nor `.env.example` overrides it — so every real group task gets
      fake extraction unless someone explicitly exports
      `MEMORY_EXTRACTOR=ark`. This is not cosmetic: `FakeExtractorClient`
      (`extractor-client.ts:128-168`) always emits the same two hardcoded
      notes — *"the upload endpoint must reject files larger than 10MB..."*
      and *"uploaded object keys are namespaced per user..."* — regardless of
      what the actual task was about, as long as it can regex-find
      agent/run/span ids in the right shape in the prompt. Confirmed live: the
      dev server running right now has never had `MEMORY_EXTRACTOR` exported,
      so it's been on the fake path the entire session.
      Do **not** delete `FakeExtractorClient` outright — `SPEC.md` requires it
      for tests ("`MEMORY_EXTRACTOR=fake` must be the default in tests so
      `npm run check` never touches the network"). But that requirement isn't
      actually tied to the schema default: the one test that needs it,
      `integration-e2e.test.ts`, already sets `MEMORY_EXTRACTOR: "fake"`
      explicitly in its own env override rather than relying on the config
      default. So the schema-level default can safely stop being `"fake"`
      with zero risk to `npm run check`. Fix: flip `config.ts`'s default to
      `"ark"` (or remove the default and require the key be set explicitly),
      and add `MEMORY_EXTRACTOR=ark` to `.env.example` so real/demo runs are
      correct by default instead of by accident. Tests keep working exactly
      as they do today because they already opt into `fake` explicitly. Add a
      short comment on `FakeExtractorClient` itself flagging that it's
      test/demo-only, canned, and topic-blind — not a real extractor — so
      nobody mistakes its output for the real thing when reading the code.

- [ ] **Spans are batched to one flush at run terminal, not persisted
      incrementally — not implemented at all today, and it blocks two other
      ideas from this list.** In both `agent-service.ts`'s `executeRun()` and
      `group-runner.ts`'s `runPlanNode()`, `onSpan` just pushes into an
      in-memory array (`spanBuffer`); the single `store.mutate()` that writes
      `db.spans` only happens after the run/node reaches terminal status. No
      code path writes a span to the store while a run is still in progress,
      and no route reads them either — `GET /api/runs/:id/trace` hits the same
      empty store for an active run. This is the shared prerequisite for:
      - **Live output streaming to the UI.** The Codex CLI's own stdout *is*
        already consumed incrementally (`codex-runner.ts`'s
        `child.stdout.on("data", ...)` parses line-by-line as Codex emits
        events), but that stream dead-ends in the in-memory buffer above —
        nothing persists or exposes it mid-run, so the UI only ever shows a
        static "thinking" spinner while polling run status every 900ms.
      - **Topic-shift-triggered incremental consolidation** (raised in
        discussion): running the consolidator before a node finishes, as soon
        as its in-progress transcript shows a topic shift. `ARCHITECTURE.md`
        §9 already names an adjacent, coarser idea — a node/DAG-level
        "Flink-style watermark" flush trigger, explicitly deferred as "a later
        chapter" — but even that only operates on completed nodes. A
        mid-node, topic-shift trigger is a step finer than anything named in
        the docs, and either version needs spans in the store before the node
        terminates to have anything to read.

## Group runner / workspace

- [ ] **CONFIRMED LIVE, blocking the demo right now.** Reproduced independently
      through the actual running UI, not just predicted from reading the code:
      opened Teams, selected "Upload Feature Team," entered a task prompt,
      clicked Start task — got exactly the predicted error, verbatim: *"This
      Agent workspace already has a `./code` link pointing elsewhere."* No new
      group task was created. Verified on the filesystem: all three of that
      team's agents (`4fa8c6a9...`, `99758dd8...`, `5f2df64f...`) still have
      `workspaces/<id>/code` symlinked to `shared-code/f5dd2733-...`, the
      seed script's original task directory — and `GET /api/groups` confirms
      `activeTaskId: null` for that team, so this is not the "task already
      running" guard, it's the stale-link conflict below. **Also surfaced a
      second, smaller side effect of the same root cause:** a
      `shared-code/11182727-...` directory exists on disk with no group task
      referencing it — `createSharedCodeDirectory()` runs before the
      per-member `prepareSharedCode()` loop, so when a first member's link
      conflict fails the start, the shared-code directory already created for
      that attempt is orphaned; nothing cleans that up either. Fix for both:
      same as below, plus have `startGroupTask()` remove the shared-code
      directory it just created if `prepareSharedCode()` fails partway through
      the member loop.

- [ ] **A group can only ever run one task, ever, on local-process runtime —
      shared code is never released.** `WorkspaceManager.releaseSharedCode()`
      (`workspace.ts`) exists and does exactly what's needed — drops the
      `./code` link, never touches the target — but `GroupRunner` never calls
      it, on task completion, cancel, or anywhere else. The only caller
      anywhere is `scripts/seed-demo.mjs`, as a manual workaround before
      reseeding. On local-process runtime, `prepareSharedCode()` creates a
      real symlink (`<workspace>/code -> shared-code/<taskId>`), and its own
      conflict check throws `409 "This Agent workspace already has a ./code
      link pointing elsewhere"` if a link already exists pointing at a
      different task. Since nothing ever removes the first task's link, a
      second task on the same group fails outright before the new task row is
      even created — with no workaround from the UI or API; someone has to
      delete the stale symlink on the server's filesystem by hand. **This is
      not a demo-only edge case**: `config.ts`'s schema default and the
      committed `.env` are both `RUNTIME_PROVIDER=local-process` — that's
      documented as the actual ECS/Docker-Compose production deployment path.
      Only `npm run poc` explicitly overrides it to `container` (which is
      unaffected — its bind mount is re-specified fresh on every `codex exec`
      call, nothing to go stale). Confirmed live: the dev server running this
      session, started with plain `npm run dev`, reports
      `"runtimeProvider":"local-process"` from `/api/system` — i.e. it has
      this bug right now.

      **Proposed minimal fix (drafted and typechecked, not applied — reverted
      per instruction to leave the code untouched):** a private
      `releaseSharedCodeForTask(taskId)` helper on `GroupRunner`, snapshotting
      the store to find the task's group and its member agents, then calling
      `this.workspaces.releaseSharedCode(agent)` for each — wrapped in a
      try/catch per agent (logged, not thrown) so a release failure can never
      block task completion, consistent with how `maybeFlush()` already
      handles its own failures. Call it once, from `finishGroupTask()`, right
      after `this.activeTasks.delete(taskId)` and before the flush-trigger
      call — `finishGroupTask()` is the single path both normal completion
      and `cancelGroupTask()` fall through to (the `executeGroupTask()` loop
      calls it unconditionally after `break`), so one call site covers both.
      Confirmed via `npm run typecheck -w @launchpad/server` before revert:
      clean, no errors.

- [ ] **The `$CODEX_HOME` governed-memory safety assertion named in
      `DECISIONS.md` A1 doesn't exist in the codebase — it was dropped during
      integration, not just left unwired.** A1's "Hard rule for Person 3
      (LandingService)" says: *"Governed memory is NEVER written under
      `$CODEX_HOME`... Add a startup assertion that `$CODEX_HOME/skills`
      contains no governed memory."* This matters because `$CODEX_HOME` is
      shared across every agent's container, so anything landed there is
      silently visible to all agents and voids the entire "security = file
      placement" claim the architecture rests on. A function for this
      (`assertNoGovernedMemoryInCodexHome`) existed in an earlier version of
      `workspace-memory.ts` seen mid-session, but a repo-wide grep for it now
      returns zero matches — it didn't survive the Person 1/2/3 branch
      integration. The *check* does still exist, but only inside
      `scripts/verify-live.mjs` as a manual diagnostic you run after a live
      task (`line(PASS, "isolation", "no governed memory under CODEX_HOME or
      shared-code")`) — meaningfully weaker than a real startup assertion,
      since it only catches the problem if someone remembers to run it.
      Fix: restore the assertion and call it at server boot (`index.ts`,
      alongside `writeCodexConfig()`), not just in the manual diagnostic.

## Not urgent, just noted

- The seeded demo (`scripts/seed-demo.mjs`) is idempotent and safe to re-run
  before every rehearsal — no action needed, just confirming it works as
  documented in `DEMO.md`.
