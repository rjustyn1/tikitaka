# Person 2 — Planner And Group Contracts

## Mission

Replace the fixed three-role/five-node assumption with a validated planner
contract that the runtime can execute.

## Exclusive ownership

You may edit:

- apps/server/src/types.ts
- group schemas and routes in apps/server/src/app.ts
- apps/server/src/memory/group-chain.ts
- apps/server/src/memory/group-prompt.ts
- a new planner module under apps/server/src/memory/ if needed
- apps/server/src/app.test.ts
- apps/server/src/app.groups.test.ts
- planner, group-chain, and group-prompt tests

Do not edit:

- apps/server/src/memory/group-runner.ts
- apps/server/src/agent-service.ts
- apps/server/src/store.ts
- apps/server/src/workspace.ts
- apps/server/src/config.ts
- memory extraction, landing, review, ledger, or safety modules
- apps/web/**
- TODO.md or TODO_Instructions/**

## Work items from the baseline

1. Replace V1_CHAIN as the source of every plan. Add a planner interface that
   receives the task prompt and candidate Agent descriptions and returns a
   validated ordered graph with selected Agents, dependencies, ownership hints,
   expected output, and a short instruction for each node.

2. Revisit A4. Remove the fixed exactly-three and one-backend,
   one-frontend, one-security requirement from group membership. A group may
   contain any explicitly selected number of Agents; the planner decides which
   members are relevant to a task while routing remains inside the group.

3. Persist each node instruction. Add instruction: string to GroupPlanNode and
   every server-side store/API DTO that carries a plan node. The instruction
   must be planner output, not a frontend-generated template lookup.

4. Validate planner output like the existing extractor boundary: strict
   schema, invalid Agent rejection, node-count cap, dependency cycle rejection,
   duplicate/invalid references rejected, and deterministic fake/offline tests.
   Decide and document how ownership hints and runtime locks are constrained.

5. Keep the handoff clean. Person 1 owns GroupRunner integration and will
   consume your result. Publish the exact planner result shape and examples
   without editing GroupRunner. Person 4 will consume instruction through the
   server DTO and must not reconstruct it in the browser.

## Acceptance

- Different task prompts can produce different validated plans.
- Groups can contain any explicitly selected number of Agents.
- Every persisted node has a short instruction and auditable dependencies.
- Invalid or cyclic planner output cannot reach execution.
- Person 1 can execute the planner result without role reconstruction.
- Targeted contract and planner tests pass without Ark.

## Handoff

Report the final node schema, planner limits, and failure behavior to Person 1
and Person 4. If a legacy memberAgentIds shape is still read for migration,
keep that compatibility localized to the server contract/store boundary and
do not reintroduce it as the authoritative API shape.

