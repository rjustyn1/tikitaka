# Person 4 — Frontend And Build

## Mission

Make the browser experience demo-ready and keep the web workspace buildable.

## Exclusive ownership

You may edit:

- apps/web/**
- apps/web/package.json
- package-lock.json
- frontend tests and web build configuration

Do not edit:

- apps/server/**
- README.md
- root package.json
- .env.example
- TODO.md or TODO_Instructions/**

## Work items from the baseline

1. Repair the web build dependency state. The Testing Library packages declared
   in apps/web/package.json are missing from node_modules, so tsc -b fails on
   test types and modules. Sync web dependencies and confirm the web build,
   typecheck, and tests pass. Keep dependency changes within the web package
   and lockfile boundary.

2. Give Teams a persistent sidebar. Agents already have a visible one-click
   list; Teams only have a header select and no selector when there is one
   team. Add team names plus member roster/status while Teams is active.

3. Show each plan node's actual mini-plan. Consume Person 2's persisted
   GroupPlanNode.instruction and render it with role, Agent, status, expected
   output, and trace action. Do not recreate instructions in the frontend.
   Render gracefully while older task rows have no instruction.

4. Make Teams read as a shared conversation. Promote the transcript to the
   primary surface and add an Agent profile panel with avatar, name, role,
   live task status, and currently held governed memory. Keep plan, review,
   ledger, workspaces, and proof as secondary views.

5. Render live execution data from Person 1's trace contract where useful.
   Keep polling, loading, and error states bounded. The server owns trace
   truth; do not add a second server endpoint or infer missing spans.

## Acceptance

- npm run build, web typecheck, and web tests pass from a clean dependency
  install.
- Teams can be selected from a persistent sidebar.
- The plan visibly explains what each Agent was told to do.
- The main Teams view communicates one shared conversation plus per-Agent
  identity and memory state.
- The UI remains usable while a task is queued, running, completed, partial,
  cancelled, or failed.
- Targeted web tests pass.

## Handoff

Consume Person 2's final instruction field and Person 1's active trace
behavior. Do not edit server files or add a second server endpoint. After the
other workstreams land, rehearse the UI against the seeded demo and report
remaining runtime blockers without silently working around them.
