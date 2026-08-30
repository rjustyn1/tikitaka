# MANIFEST_1 - Person 1 Runtime And Workspace Lifecycle

Status: landed with the Person 2 planner handoff pending

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
  unchanged, including `MEMORY_EXTRACTOR=fake` as the offline default.
- `workspace.ts` continues to export the pure managed-block helpers and
  `writeInstructions()` continues to preserve `<!-- memory:* -->` blocks.
- `TODO.md`, `types.ts`, `config.ts`, `app.ts`, and `apps/web/**` were not
  changed by this runtime pass.

## Integration Notes

### Person 2 - planner and node execution

The current `GroupRunner` still consumes the existing `buildChainNodes()` and
`templateFor()` boundary from `memory/group-chain.ts`. Once Person 2 publishes
the validated planner result and final `GroupPlanNode` instruction contract:

1. Adapt `GroupRunner` to execute the persisted validated node order,
   dependencies, agent ids, and instruction text.
2. Keep the existing lease, shared-code, span, context-injection, lock-release,
   cancellation, and terminal cleanup behavior.
3. Do not recreate planner validation or infer a second plan inside the runner.

The runtime assumes completed nodes persist `status`, `runId`, `output`, and
`completedAt`, and that each node run persists its context injection and trace
spans before the memory flush boundary.

### Person 3 - memory pipeline

- Consume completed `AgentRun`, `TraceSpan`, `GroupPlanNode`, and
  `GroupContextInjection` rows from the shared store.
- Use `replaceManagedBlock` and `removeManagedBlock` from `workspace.ts` for
  memory landing; do not reimplement them in another workspace module.
- Keep memory extraction on `fake` for offline checks. Real Ark extraction is
  an explicit environment choice.
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
- Keep `MEMORY_EXTRACTOR=fake` unless a live Ark key and model are deliberately
  configured.

### Integration requirements

- Person 2 must publish the planner result and final instruction field before
  the runner is switched away from the current chain boundary.
- Person 3 must consume execution records without editing `GroupRunner`.
- Person 4 must consume server DTOs and must not add a second planner or alter
  the runtime lifecycle.
- Run integration in this order: planner contract, Person 1 runtime, Person 3
  memory pipeline, then Person 4 web behavior.

## Verification

Passed for this manifest:

```text
npm run typecheck -w @launchpad/server
npm run build -w @launchpad/server
npm test -w @launchpad/server
```

The server suite passed with 158 tests. The root `npm run check` remains blocked
by the existing missing `apps/web` test dependencies (`@testing-library/react`)
and related matcher types; no web dependency files were changed in this
workstream.

`TODO.md` remains unchanged.
