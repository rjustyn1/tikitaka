# Person 1 — Runtime And Workspace Lifecycle

## Mission

Make repeated local runs reliable, preserve workspace isolation, and expose
execution state while work is still running.

## Exclusive ownership

You may edit:

- apps/server/src/agent-service.ts
- apps/server/src/memory/group-runner.ts
- apps/server/src/store.ts
- apps/server/src/workspace.ts
- apps/server/src/index.ts
- apps/server/src/trace-summary.ts when needed for active spans
- scripts/ relevant to local runtime and live verification
- README.md for local-dev instructions
- apps/server/src/agent-service.test.ts
- apps/server/src/memory/group-runner.test.ts
- apps/server/src/store.test.ts
- apps/server/src/workspace.test.ts

Do not edit:

- apps/server/src/config.ts
- apps/server/src/types.ts
- apps/server/src/app.ts
- apps/server/src/memory/group-chain.ts
- apps/server/src/memory/group-prompt.ts
- apps/web/**
- other memory modules
- package-lock.json or apps/web/package.json

## Work items from the baseline

1. Fix the local development path mismatch. The container-style .env points at
   /app/data, /app/workspaces, and /app/codex-home, while bare macOS
   npm run dev needs host paths. Also account for npm workspace cwd behavior so
   the running server and scripts/seed-demo.mjs use the same store and
   workspace roots. Prefer root scripts and README guidance; do not change
   Person 3's config schema.

2. Recover from stale shared-code links. When startGroupTask creates a shared
   directory and a member's ./code link points elsewhere, remove only the
   directory created by that failed attempt and leave unrelated workspaces
   untouched.

3. Release shared code after every terminal group task. Use the existing
   WorkspaceManager.releaseSharedCode() for normal completion and cancellation.
   Tolerate a release failure for one Agent without blocking task completion.
   Prove that a second local-process task can start.

4. Persist spans incrementally. agent-service.ts and group-runner.ts currently
   buffer spans until terminal status. Persist incoming spans while retaining
   terminal deduplication, ordering, trace summaries, and existing failure
   semantics. The existing trace route should return useful active-run data.

5. Provide the server side of live output. Keep topic-shift or incremental
   consolidation behind an explicit trigger boundary. Person 4 owns rendering
   the live data in the web UI; do not edit apps/web.

6. Add the CODEX_HOME safety assertion at startup. Reject governed memory under
   CODEX_HOME/skills with a useful error, alongside server boot setup. Keep
   scripts/verify-live.mjs as a secondary diagnostic.

7. Consume Person 2's planner result. Once the planner contract is published,
   adapt GroupRunner to execute its validated nodes and persisted instructions.
   Do not redesign planner validation in GroupRunner.

## Acceptance

- A failed or completed task leaves no stale ./code link or orphaned shared
  directory.
- A second local-process task can run on the same group.
- Active runs expose real spans through the existing trace contract.
- Startup rejects governed memory under CODEX_HOME.
- GroupRunner executes Person 2's planner output without reconstructing roles.
- Targeted runtime tests pass.

## Handoff

Give Person 4 the active trace response behavior and give Person 2 any runtime
constraints discovered while consuming the planner contract. Do not modify
Person 2's contract files to make the handoff fit.

