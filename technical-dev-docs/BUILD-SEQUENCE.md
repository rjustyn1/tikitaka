# Build Sequence Technical Design

## Purpose

Define the recommended implementation order across the component TDs.

This prevents future sessions from starting in the middle and accidentally
building modules before their contracts exist.

## Sequence

```text
1. TYPES-AND-STORE
2. WORKSPACE-EXTENSIONS
3. FLUSH-TRIGGER
4. GROUP-RUNNER
5. TASK-BUFFER
6. EXTRACTOR-CLIENT
7. CONSOLIDATOR
8. SAFETY
9. LEDGER
10. LANDING
11. REVIEW
12. API-ROUTES
13. FRONTEND-UI
```

## Why This Order

`TYPES-AND-STORE` comes first because every other component imports the same
contracts and store arrays.

`WORKSPACE-EXTENSIONS` comes before group execution because group tasks need
private Agent roots and shared `./code` prepared before Codex runs.

`GROUP-RUNNER` can be built with a fake memory pipeline first. That gives the
demo its group chat, DAG execution, and context injection path before the memory
extractor is complete.

`TASK-BUFFER`, `EXTRACTOR-CLIENT`, `CONSOLIDATOR`, and `SAFETY` form the memory
candidate pipeline.

`LEDGER`, `LANDING`, and `REVIEW` form the governance and enforcement pipeline.

`API-ROUTES` and `FRONTEND-UI` come last because they expose the already-defined
service methods.

## Choke Points

Only these modules should write workspace files:

```text
WORKSPACE-EXTENSIONS:
  shared code setup
  group-task AGENTS.md sections

LANDING:
  governed memory entries
  governed memory skills
  revoke/delete landed memory
```

Only these modules should call Codex:

```text
existing AgentService:
  solo Agent runs

GROUP-RUNNER:
  group DAG node runs
```

Only these modules should decide memory activation:

```text
SAFETY:
  redaction/quarantine signals

REVIEW:
  auto-activate vs human review
  approve/edit/reject/revoke
```

## Demo Slice

The smallest useful demo slice is:

```text
TYPES-AND-STORE
WORKSPACE-EXTENSIONS
GROUP-RUNNER with preseeded DAG
API-ROUTES for groups/tasks
FRONTEND-UI group creation + task timeline
TASK-BUFFER with fake data
CONSOLIDATOR with fake extractor
SAFETY
LANDING
LEDGER
REVIEW UI
```

The demo can use `FakeExtractorClient` first. Real Ark extraction can be swapped
in after the end-to-end path works.
