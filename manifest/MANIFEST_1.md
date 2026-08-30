# MANIFEST_1 - Person 1 Runtime And Workspace Lifecycle

Status: Person 1, Person 2, and Person 3 partially integrated; Person 4 pending

Owner: Person 1

Related contract manifest: `apps/server/src/integration-manifest-task1.ts`

## Purpose

This manifest records the Person 1 runtime changes, the integration points for
the other workstreams, and the requirements for a complete integration. It is
an implementation handoff, not a replacement for `TODO.md`, `PLAN.md`, or
`SPEC.md`.

## Changes Landed

### Local development paths

- Updated `README.md` so bare host development passes absolute repository-root
  values for `APP_DATA_DIR`, `AGENT_WORKSPACE_ROOT`, and `CODEX_HOME`.
- Documented using the same values when running `npm run seed`, which avoids
  the npm workspace cwd split between the root scripts and the server package.
- Left the container-oriented `.env.example` unchanged.

### Shared workspace lifecycle

- `WorkspaceManager.removeSharedCodeDirectory(groupTaskId)` removes only the
  task leaf created under `shared-code` and rejects path traversal.
- Failed group setup rolls back prepared member links, task-specific charter
  blocks, and the newly created shared directory. No task row is created.
- Terminal group tasks release each member's `./code` exposure before the group
  becomes available for another task. Cancellation and normal completion use
  the same path.
- Restart recovery releases links for known group tasks, including terminal
  rows left by an earlier process.
- Link cleanup is non-destructive: local symlinks are removed, container mount
  points are removed only when empty, and real local directories are preserved.
- Cleanup failures are isolated per Agent and do not prevent terminal task
  state or memory-flush bookkeeping from being recorded.

### Active traces

- `AgentService` and `GroupRunner` persist `onSpan` events while a run is in
  progress instead of waiting for terminal state.
- Per-run write queues preserve callback order, and span ids are upserted so a
  started span followed by a completion update does not duplicate the trace.
- Terminal status and `traceSummary` are written after pending span writes
  drain. Open spans are marked `incomplete` on runner failure or cancellation.
- The existing `GET /api/runs/:id/trace` response can therefore serve useful
  data for an active run. Person 4 owns rendering that data.

### Startup safety

- Added and exported `assertNoGovernedMemoryInCodexHome(codexHome)` in
  `apps/server/src/workspace.ts`.
- Server startup calls the assertion alongside generated Codex configuration.
- A `memory-*` entry under `CODEX_HOME/skills` fails startup with a useful
  placement error. `scripts/verify-live.mjs` remains the secondary diagnostic.

### Existing Person 1 contracts retained

- `AgentGroup.members` is the active role-bound membership shape. No new
  `memberAgentIds` compatibility field was introduced.
- The exact memory configuration keys already present in `config.ts` remain
  unchanged. `MEMORY_EXTRACTOR` defaults to `ark`; offline tests opt into
  `fake` explicitly.
- `workspace.ts` continues to export the pure managed-block helpers and
  `writeInstructions()` continues to preserve `<!-- memory:* -->` blocks.
- `TODO.md`, `types.ts`, `config.ts`, `app.ts`, and `apps/web/**` were not
  changed by this runtime pass.

## Integration Notes

### Person 2 - planner and node execution

- Integrated `TaskPlanner` and its validated `GroupPlanNode.instruction`
  contract into `GroupRunner`.
- `GroupRunner` persists and sequentially executes the planner's topological
  node order; it no longer rebuilds the retired fixed chain or role templates.
- Ark mode shares the validated Ark extractor transport. `fake` and `off` modes
  use `FakePlannerClient`, preserving offline checks.
- Existing lease, shared-code, span, context-injection, lock-release,
  cancellation, resume, and terminal-cleanup behavior remains covered.

The runtime assumes completed nodes persist `status`, `runId`, `output`, and
`completedAt`, and that each node run persists its context injection and trace
spans before the memory flush boundary.

### Person 3 - memory pipeline

- Integrated the required validated-config pipeline boundary and removed the
  independent `process.env` memory config path.
- Extractor provenance now uses short run/span indices in model output and
  resolves those indices back to persisted UUIDs before validation/storage.
- `workspace-memory.ts` imports and re-exports `replaceManagedBlock` and
  `removeManagedBlock` from `workspace.ts`; there is one managed-block
  implementation shared by group charters and governed-memory landing.
- Memory extraction defaults to `ark`. Offline checks and demos must select
  `MEMORY_EXTRACTOR=fake` explicitly.
- The runtime calls the memory pipeline only after the existing flush decision;
  active trace persistence does not implicitly trigger consolidation.

### Person 4 - web UI

- Use the existing trace route while a run is active; no server route change is
  required for live span polling.
- Treat `run.status === "running"` plus non-empty trace spans as a valid active
  state.
- Use `members: [{ agentId, role }]` for group requests and keep the private
  workspace versus shared-code distinction visible in the UI.

## Requirements

### Runtime requirements

- Node.js 22 or newer and the installed workspace dependencies.
- Bare host development must set absolute `APP_DATA_DIR`,
  `AGENT_WORKSPACE_ROOT`, and `CODEX_HOME` values consistently for both
  `npm run dev` and `npm run seed`.
- `CODEX_HOME/skills` must not contain governed `memory-*` entries.
- Local-process group runs require a writable workspace root for symlinks;
  container runs require a writable bind-mounted workspace and Codex home.
- The default Ark extractor requires a valid Ark key and model for live tasks;
  select `MEMORY_EXTRACTOR=fake` explicitly for offline operation.

### Integration requirements

- Person 4 must consume server DTOs and must not add a second planner or alter
  the runtime lifecycle.
- Person 4 should integrate after this planner/runtime/memory checkpoint and
  use `members: [{ agentId, role }]` plus dynamic planner nodes.

## Verification

Passed for this manifest:

```text
npm run typecheck -w @launchpad/server
npm run build -w @launchpad/server
npm test -w @launchpad/server
```

Final post-merge server verification passed typecheck, build, and 199 tests
across 21 files. The root `npm run check` reaches the unfinished Person 4 web
workspace and stops during web typecheck because `@testing-library/react` and
its DOM matcher types are missing. No web dependency files were changed in this
partial integration.

`TODO.md` remains unchanged.
