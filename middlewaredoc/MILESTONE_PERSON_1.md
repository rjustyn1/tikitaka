# Milestone - Person 1

Status: landed

Owner: Person 1 - Data, Store, And API Contracts

## What Landed

- Shared group, DAG, context-injection, memory-note, landing-file, grant, lease, runner, and fresh-thread types are exported from `apps/server/src/types.ts`.
- Web DTOs mirror the Person 1 response/input surface in `apps/web/src/types.ts`, and `apps/web/src/api.ts` calls the new group, memory, audit, and fresh-thread routes.
- `JsonStore.initialize()` backfills every new group/memory array and migrates legacy `memberAgentIds` groups to `members`.
- `AgentGroup.members` is the active A4 contract: exactly three entries, one each for `backend`, `frontend`, and `security`.
- Person 1 config keys are in `apps/server/src/config.ts`, with `MEMORY_EXTRACTOR=fake` as the default offline path.
- Fastify route schemas exist for group CRUD, group task stubs, context/timeline reads, notes, memory files, grants, and solo `freshThread`.
- `AgentService` exposes the Person 1 service contract, store-backed group CRUD, the A3 Agent lease seam, A5 solo `freshThread`, delete-agent cascade handling, and restart cleanup for stale group state.
- `workspace.ts` exports `replaceManagedBlock(existing, markerId, body)` and `removeManagedBlock(existing, markerId)`, and `writeInstructions()` preserves `<!-- memory:* -->` blocks.

## Integration Manifest

Import `integrationManifestTask1` or `MILESTONE_PERSON_1` from
`apps/server/src/integration-manifest-task1.ts`:

```ts
import {
  MILESTONE_PERSON_1,
  integrationManifestTask1,
} from "./integration-manifest-task1.js";
```

## Person 2 Handoff

- Implement real group task execution behind `startGroupTask()` and `cancelGroupTask()`.
- Use `acquireAgent()` and `releaseAgent()` around every group node run.
- Pass `sharedCodePath` to the runner for group runs.
- Use the exported managed-block helpers for planner-owned `AGENTS.md` sections.

## Person 3 Handoff

- Keep using the existing route shapes for notes, review, revoke, landed memory, and grants.
- Import managed-block helpers from `workspace.ts` for memory landing.
- Keep `MEMORY_EXTRACTOR=fake` as the test/default path so `npm run check` stays offline.

## Person 4 Handoff

- Use web DTOs from `apps/web/src/types.ts`.
- Send group members as `members: [{ agentId, role }]`, not `memberAgentIds`.
- Use `freshThread: true` on solo messages when demoing that landed memory is reloaded.

## Verification

```text
npm run check
```
