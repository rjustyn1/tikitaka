# Planner

> **The one question this answers: what decides the plan, and what shape does it
> hand to the runtime.**
> Owner: Person 2. Consumed by Person 1 (`GroupRunner`) and Person 4 (web DTO).
> Module: `apps/server/src/memory/planner.ts`. Tests: `planner.test.ts`.

---

## What changed

`V1_CHAIN` is gone. It was A4's fixed five-node, three-role template, stamped
into every task regardless of what the task said. The planner now receives the
task prompt plus every candidate Agent's `description` and returns a validated
ordered graph: who works, in what order, and a short instruction each.

A4's "exactly three members, one per role" membership rule is gone with it. A
group holds any explicitly selected number of Agents (1–12); the planner selects
the subset a given task needs.

## The seam

```ts
interface PlannerClient {
  extract(input: { system: string; prompt: string; timeoutMs: number }):
    Promise<{ rawText: string }>;
}
```

Structurally identical to `ExtractorClient`, deliberately: pass the same
`createExtractorClient(config)` instance. `FakePlannerClient` is the offline
implementation — tests and the demo need no Ark key and no network.

```ts
const planner = new TaskPlanner(client, config.memoryExtractTimeoutMs, onReject);
const result = await planner.plan({ prompt, agents });
```

## The result shape

```ts
interface PlanResult {
  nodes: PlannedNode[];
  source: "model" | "fallback";   // not persisted; log it, do not store it
}

interface PlannedNode {
  agentId: string;             // resolved from an index; never model-authored
  nodeRole: string;            // kebab-case slug, derived if the model omits it
  instruction: string;         // what this Agent is told to do — REQUIRED
  expectedOutput: string;
  dependsOnIndexes: number[];  // positions in THIS array
  readOnly: boolean;           // server-derived, see Ownership below
  fileOwnershipHints: string[];
  runtimeLocks: string[];
}
```

`nodes` is returned in **topological order**, so a plain forward `for` loop over
the array is always a valid execution order — which is what
`executeGroupTask()` already does.

`buildPlanNodes(groupTaskId, result.nodes, createdAt)` turns that into persisted
`GroupPlanNode[]`: ids assigned, `dependsOnIndexes` resolved to `dependsOn` ids,
and `allowedPlanNodeIds` computed as the **transitive** ancestor set (a chain
gave that for free; a real DAG has to compute it).

## The model never sees a UUID

`DECISIONS.md` warned against asking a model to echo 36-character ids, and the
consolidator does it anyway — one transposed character silently drops a note.
The planner works in small integers instead:

```text
## Available agents
1. Backend — Owns the HTTP API and storage.
2. Frontend — Owns the React app.
3. Security — Reviews auth and secret boundaries.
```

The model answers `"agent": 2` and `"dependsOn": [0]`. The server maps indices
back to real ids. A wrong index is an out-of-range rejection, not a silent drop.

## Limits and the validation ladder

| Rung | Rejection |
|---|---|
| at least one node | `empty` |
| at most `MAX_PLAN_NODES` (8) | `too-many-nodes` |
| agent index is an integer inside the roster | `unknown-agent` |
| instruction non-empty after trim | `missing-instruction` |
| every `dependsOn` index exists | `bad-dependency` |
| no node depends on itself | `self-dependency` |
| no repeated index within one node | `duplicate-dependency` |
| graph is acyclic (Kahn) | `cycle` |

Every rung rejects the **whole plan**. There is no partial repair: a plan with
one node quietly dropped is a plan whose dependencies no longer mean what they
say. Roster is capped at `MAX_PLANNER_AGENTS` (12); instruction at 1200 chars,
expected output at 300.

## Ownership hints and runtime locks are server-derived

The planner picks a named **area** from a fixed set; the server maps it to the
glob. The model never writes a path.

```text
server → code/apps/server/**     web → code/apps/web/**
shared → code/packages/**        docs → code/docs/**
all    → code/**                 anything else → read-only, no hints, no locks
```

A model that can emit an arbitrary glob can emit `**` or an absolute path, and
file placement is the security claim the architecture rests on. `writes: false`
or an unrecognised area both degrade to read-only — the failure direction is
always *less* access. Lock rows are still written per write node for the UI;
lock **collision** validation remains STRETCH.

## Failure behaviour: fall back, never fail open to nothing

Zero memory notes is a fine outcome. Zero plan nodes is a task that cannot run.
So every failure — transport, unparseable JSON, any rung above — discards the
model's plan whole and returns the **deterministic fallback**: one node per
member, in membership order, sequential, with a generic instruction. Invalid or
cyclic output still never reaches execution. `source: "fallback"` and the
`onReject` callback are how a degraded plan stays visible instead of passing for
a real one.

## For Person 1 — integrating in `GroupRunner`

`buildChainNodes(taskId, members, createdAt)` keeps its exact signature and
still works, so nothing breaks before you get to this. It is now the fallback,
not a template, so **today it produces one generic node per member** — wiring
the planner is what restores a real plan.

```ts
// in startGroupTask(), replacing: const nodes = buildChainNodes(taskId, members, timestamp);
const plan = await this.planner.plan({
  prompt,
  agents: agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
  })),
});
const nodes = buildPlanNodes(taskId, plan.nodes, timestamp);
```

`agents` is the array you already resolve from `members` just above. Two other
call sites go away as pure deletions:

- `templateFor(node.nodeRole)` at the `buildTurnPrompt` call — the parameter is
  optional now and `node.instruction` takes precedence. Drop the argument, then
  the import.
- `findMembershipError()` keeps its signature; it just no longer enforces roles.

**Not yet done, and yours:** `group-runner.test.ts` (11 tests) and
`integration-e2e.test.ts` (1) assert the removed contract — "runs the five-node
chain in role order", "requires exactly one Agent per role", node counts of 5,
and `code/apps/server/**` locks from the old template. They are the contract
change, not regressions. They need rewriting against plan shape rather than
against a fixed chain, in your files.

## For Person 4 — the DTO

`GroupPlanNode.instruction: string` is persisted and returned by
`GET /api/groups/:id/tasks/:taskId` with no mapping change. Render it. Do not
reconstruct an instruction in the browser, and do not assume five nodes, three
members, or the labels `backend`/`frontend`/`security` — `role` is now a
free-form label defaulting to `"member"`, and node count varies per task.

`POST /api/groups` now accepts `members: [{ agentId, role? }]`, 1–12 entries,
no role requirement. The one rule left is that an Agent may not appear twice.

## Known gap

`scripts/seed-demo.mjs` writes plan-node rows without `instruction` (around
line 327). Seeded demo nodes will render a blank instruction until that script
adds one. It is outside every ownership list in `TODO_Instructions/`.
