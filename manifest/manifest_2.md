# Integration Manifest — Person 2 (Planner And Group Contracts)

> **The one question this answers: what Person 2 changed, and exactly what each
> other person must do to integrate with it.**
>
> Scope came from [`TODO_Instructions/Person_2.md`](../TODO_Instructions/Person_2.md);
> findings from [`TODO.md`](../TODO.md). The design reference for the planner
> itself is [`middlewaredoc/components/PLANNER.md`](../middlewaredoc/components/PLANNER.md) —
> this file is the *integration* checklist, that one is the *component* doc.
>
> Follow this top to bottom. Every wiring point is listed with an exact file,
> symbol, and signature. Nothing should need reverse-engineering from the code.

---

## 0. TL;DR for the integrator

Person 2 replaced the hardcoded plan with a validated planner, and removed the
fixed three-role membership rule.

- **Not additive.** Person 2 edits four shared files: `types.ts`, `app.ts`,
  `memory/group-chain.ts`, `memory/group-prompt.ts`. `types.ts` and `app.ts` are
  the likely merge points with Person 1.
- **Nothing is broken at rest.** `buildChainNodes()` kept its exact signature, so
  `group-runner.ts` compiles and runs untouched. Server typecheck is clean.
- **12 tests fail, all in files Person 1 owns**, all asserting the contract that
  was deliberately removed. See §6. These are the change landing, not
  regressions.
- **One non-obvious hazard can silently disable the planner.** Read §3.1 before
  wiring anything.
- **Integration order** (from `TODO_Instructions/README.md`): Person 2 first
  (this), then Person 1, then Person 3, then Person 4.

---

## 1. What changed

### New files

| File | Lines | What it is |
|---|---|---|
| `apps/server/src/memory/planner.ts` | 608 | The planner: client seam, prompt, schema, validation ladder, ownership derivation, fallback, materialisation |
| `apps/server/src/memory/planner.test.ts` | 451 | 33 tests, no network, no Ark key |
| `middlewaredoc/components/PLANNER.md` | — | Component doc: result shape, limits, rejection table |

### Modified — shared files

| File | Change | Breaks anyone? |
|---|---|---|
| `apps/server/src/types.ts` | `GroupPlanNode.instruction: string` added (required). `GroupRole` widened from the fixed union to an open string. | Type-level only. Five test fixtures needed one line each — already added, see §1.1. |
| `apps/server/src/app.ts` | `groupMembersBody`: `.length(3)` → `.min(1).max(12)`; the "must include one backend/frontend/security" refinement deleted. `groupMemberBody.role`: `z.enum([...])` → `z.string().trim().min(1).max(40).default("member")`. Imports `MIN_GROUP_MEMBERS`/`MAX_GROUP_MEMBERS` from `group-chain.js`. | No. Strictly widens what the API accepts. |
| `apps/server/src/memory/group-chain.ts` | `V1_CHAIN` **deleted**. `findMembershipError()` no longer enforces roles or a count of 3. `buildChainNodes()` kept, same signature, now the deterministic fallback. `templateFor()` and `resolveRole()` kept as deprecated shims. `GROUP_ROLES`, `readMembers()` unchanged. | Behaviourally yes — see §3.2. Compiles unchanged. |
| `apps/server/src/memory/group-prompt.ts` | `buildTurnPrompt` renders `node.instruction` first; `template` demoted to an optional deprecated param. Adds an `Expected output:` line. | No. `template` still accepted. |

### Modified — tests

| File | Owner | Change |
|---|---|---|
| `apps/server/src/memory/group-prompt.test.ts` | P2 | Rewritten: membership rules, fallback plan, instruction rendering. 20 tests. |
| `apps/server/src/app.test.ts` | P2 | "rejects duplicate group roles" → "accepts any number of members" + "rejects empty group / duplicate Agent". |
| `apps/server/src/app.groups.test.ts` | P2 | The invalid-members case is now a duplicated Agent, since one member is valid. |

### 1.1 Cross-boundary edits (five lines, declared)

`GroupPlanNode.instruction` is required, so five fixture literals in files owned
by others needed `instruction: ""` added. One line each, no assertion changed,
all five suites still green. Declared here rather than left broken so
`npm run check` is not red for a type-only reason.

```text
apps/server/src/memory/pipeline.test.ts:111        Person 3
apps/server/src/memory/flush-trigger.test.ts:45    Person 3
apps/server/src/memory/task-buffer.test.ts:64      Person 3
apps/server/src/memory/review.test.ts:91           Person 3
apps/server/src/agent-service.test.ts:349          Person 1
```

Review these, do not re-decide them.

---

## 2. The published contract

### 2.1 Persisted node — what everyone downstream reads

```ts
interface GroupPlanNode {
  // ... all existing fields unchanged ...
  instruction: string;    // NEW, required. Planner output. What this Agent was told to do.
  expectedOutput: string;
}
```

Returned by `GET /api/groups/:id/tasks/:taskId` with no mapping change.

### 2.2 Planner surface — what Person 1 calls

```ts
// The seam. Structurally identical to ExtractorClient on purpose.
interface PlannerClient {
  extract(input: { system: string; prompt: string; timeoutMs: number }):
    Promise<{ rawText: string }>;
}

class TaskPlanner {
  constructor(
    client: PlannerClient,
    timeoutMs?: number,                                    // default 120_000
    onReject?: (reason: PlanRejection | "transport" | "parse") => void,
  );
  plan(input: { prompt: string; agents: readonly PlannerAgent[] }): Promise<PlanResult>;
}

interface PlannerAgent { id: string; name: string; description: string }

interface PlanResult {
  nodes: PlannedNode[];
  source: "model" | "fallback";   // NOT persisted — log it, do not store it
}

interface PlannedNode {
  agentId: string;             // resolved from an index; never model-authored
  nodeRole: string;            // kebab-case slug, derived if the model omits one
  instruction: string;         // required, non-empty
  expectedOutput: string;
  dependsOnIndexes: number[];  // positions in THIS array
  readOnly: boolean;           // server-derived
  fileOwnershipHints: string[];
  runtimeLocks: string[];
}

// Materialise into persisted rows:
function buildPlanNodes(
  groupTaskId: string,
  planned: readonly PlannedNode[],
  createdAt: string,
): GroupPlanNode[];
```

`nodes` comes back in **topological order**, so a plain forward `for` loop is
always a valid execution order. `buildPlanNodes` assigns ids, resolves
`dependsOnIndexes` → `dependsOn`, and computes `allowedPlanNodeIds` as the
**transitive** ancestor set.

### 2.3 Limits, enforced not advisory

| Constant | Value | Meaning |
|---|---|---|
| `MAX_PLAN_NODES` | 8 | Plans over this are rejected whole, never truncated |
| `MAX_PLANNER_AGENTS` | 12 | Roster shown to the planner |
| `MAX_INSTRUCTION_CHARS` | 1200 | Truncated, not rejected |
| `MIN_GROUP_MEMBERS` / `MAX_GROUP_MEMBERS` | 1 / 12 | From `group-chain.ts` |

Rejection reasons: `empty`, `too-many-nodes`, `unknown-agent`,
`missing-instruction`, `bad-dependency`, `duplicate-dependency`,
`self-dependency`, `cycle`. Every one rejects the **whole plan** — there is no
partial repair, because a plan with one node dropped is a plan whose
dependencies no longer mean what they say.

### 2.4 Ownership is server-derived, never model-authored

The planner picks an area *name*; the server maps it to a glob.

```text
server → code/apps/server/**      web  → code/apps/web/**
shared → code/packages/**         docs → code/docs/**
all    → code/**                  anything else → read-only, no hints, no locks
```

`writes: false` or an unrecognised area both degrade to read-only. The failure
direction is always *less* access.

---

## 3. Integration hazards

### 3.1 ⚠ Do not pass `FakeExtractorClient` to the planner

`PlannerClient` and `ExtractorClient` are structurally identical, so
`createExtractorClient(config)` type-checks as a planner client. With
`MEMORY_EXTRACTOR=ark` that is correct and intended — same Ark transport, no
duplicate HTTP code.

**With `MEMORY_EXTRACTOR=fake` or `off` it silently breaks the planner.**
`FakeExtractorClient` emits memory-note JSON (`{"notes": [...]}`), which the
planner schema rejects (it wants `{"nodes": [...]}`), so every plan degrades to
the fallback with `source: "fallback"` and reason `"parse"`. No error, no crash
— just a generic plan on every task, in every test and every offline demo. This
is the same class of failure `TODO.md` already records for the fake extractor.

Wire it like this instead:

```ts
import { FakePlannerClient, TaskPlanner } from "./memory/planner.js";
import { createExtractorClient } from "./memory/extractor-client.js";

const plannerClient =
  config.memoryExtractor === "ark"
    ? createExtractorClient(config)     // real Ark transport
    : new FakePlannerClient();          // offline: emits VALID plan JSON

const planner = new TaskPlanner(
  plannerClient,
  config.memoryExtractTimeoutMs,
  (reason) => app.log.warn({ reason }, "planner rejected a plan, using fallback"),
);
```

`FakePlannerClient` is test/demo only and topic-blind — it reads the roster, not
the task. Same caveat as `FakeExtractorClient`; do not mistake its output for a
real plan.

### 3.2 Plan quality drops until Person 1 wires the planner

`GroupRunner` still calls `buildChainNodes()`, which is now the fallback, not a
template. Today three members produce three generic sequential nodes instead of
the old `backend-contract → frontend-plan → security-review → backend-impl →
frontend-impl`. That is inherent to removing `V1_CHAIN` as the source of every
plan, but it means **a demo rehearsal before §4.1 lands will look worse than it
did yesterday**. Do §4.1 before any demo.

### 3.3 Legacy `memberAgentIds` backfill truncates to three

`store.ts:91-104` `backfillGroupMembers()` slices legacy `memberAgentIds` to
`roles.length`, i.e. 3, and assigns positional roles. Under the new contract a
legacy group with more than three member ids silently loses members. Person 1
owns `store.ts`. Low priority — no such row is known to exist — but it is now a
latent data-loss path rather than a no-op.

### 3.4 Seeded demo nodes have no instruction

`scripts/seed-demo.mjs` (~line 327) writes plan-node rows without `instruction`.
Seeded nodes render blank in Person 4's Plan panel until the script sets one.
The file is outside every ownership list in `TODO_Instructions/`; Person 1 owns
`scripts/` "relevant to local runtime and live verification", which is the
closest fit.

---

## 4. Per-person integration

### 4.1 Person 1 — `GroupRunner` ([Person_1.md](../TODO_Instructions/Person_1.md) work item 7)

**Precondition:** none. The contract is landed and the fallback keeps the
current path working.

**Step 1 — construct the planner** in `index.ts`, using the ternary in §3.1, and
pass it into `GroupRunner` as a constructor dependency.

**Step 2 — call it** in `startGroupTask()`, replacing one line:

```ts
// BEFORE
const nodes = buildChainNodes(taskId, members, timestamp);

// AFTER — `agents` is the array already resolved from `members` just above
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

`startGroupTask()` is already `async`, and this sits after the filesystem work
and before the `store.mutate()`, so a planner failure cannot half-write a task.

**Step 3 — two pure deletions:**

- `group-runner.ts:415` — drop the `template: templateFor(node.nodeRole)`
  argument to `buildTurnPrompt`, then the `templateFor` import. The parameter is
  optional and `node.instruction` already takes precedence.
- Nothing to change for `findMembershipError()` / `readMembers()` — same
  signatures, relaxed rules.

**Step 4 — do not** re-validate planner output in `GroupRunner`. Cycles, bad
indices, and node caps are already rejected before the result is returned;
`Person_1.md` says the same ("Do not redesign planner validation in
GroupRunner").

**Step 5 — rewrite the 12 failing tests** listed in §6 against plan shape rather
than a fixed chain. They are in your files.

**Interaction with your other work items:** items 2 and 3 (stale `./code` links,
`releaseSharedCode()` on terminal) are independent of the planner and unaffected
by anything here. Item 4 (incremental spans) is likewise independent. Item 6
(`CODEX_HOME` assertion) touches `index.ts`, the same file as §4.1 step 1 —
expect a local merge there, not a conflict.

### 4.2 Person 3 — memory pipeline ([Person_3.md](../TODO_Instructions/Person_3.md))

**Nothing is required of you.** No planner change touches `config.ts`,
`extractor-client.ts`, `consolidator.ts`, or `pipeline.ts`.

Three notes:

1. **`GROUP_ROLES` is still exported** from `group-chain.ts`, so
   `pipeline.ts:182`'s `syntheticGroup()` compiles unchanged. Its positional
   role assignment is still harmless — the consolidator reads no group role
   fields — but it is now genuinely arbitrary rather than merely positional.
2. **Your work item 3 and this planner solve the same problem the same way.**
   You are asked to stop making the extractor echo UUIDs and use integer indices
   into the task buffer instead. `planner.ts` already does exactly that for
   agent and dependency references — `buildPlannerRequest()` numbers the roster,
   `validatePlan()` maps indices back to ids, and `planner.test.ts` asserts no
   UUID ever reaches the prompt. Reuse the shape; there is no shared helper to
   import, and you should not create a dependency from `consolidator.ts` to
   `planner.ts`.
3. **Your work item 4 interacts with §3.1.** Whatever you decide for
   `MEMORY_EXTRACTOR`'s default, the planner must select `FakePlannerClient` for
   any value other than `"ark"`. If you change the enum, tell Person 1 so the
   ternary in §3.1 stays correct.

Your four fixture lines from §1.1 are in `pipeline.test.ts`,
`flush-trigger.test.ts`, `task-buffer.test.ts`, `review.test.ts`.

### 4.3 Person 4 — frontend ([Person_4.md](../TODO_Instructions/Person_4.md) work item 3)

**Precondition:** none for the type; §4.1 for the field to hold anything
interesting.

**Read `node.instruction` from the DTO.** It is on every `GroupPlanNode`
returned by `GET /api/groups/:id/tasks/:taskId`. Render it in `ChainPanel`
(`apps/web/src/group/panels.tsx:73-118`) alongside `nodeRole`, agent name,
status and `expectedOutput` — which was already persisted and already unused.
Do not reconstruct an instruction in the browser, and do not add a second
planner.

**Three assumptions in the web code that are now wrong:**

```text
apps/web/src/types.ts:106            GroupRole is a fixed union — widen to string
apps/web/src/group/format.ts:37      ROLES = [backend, frontend, security] — no longer exhaustive
apps/web/src/group/GroupEditor.tsx   assumes exactly one toggle per fixed role
```

`GroupEditor` needs to become "toggle any Agents in or out" with an optional
free-text label, matching `POST /api/groups` — `members: [{ agentId, role? }]`,
1 to 12 entries, `role` defaults to `"member"` server-side, the same Agent may
not appear twice. This is the group-creation half of your work item 2.

**Render gracefully for an empty instruction.** Rows seeded by
`scripts/seed-demo.mjs` (§3.4) and any task row created before this landed have
`instruction: ""`. `Person_4.md` already asks for this.

**Do not assume a node count.** Plans are 1–8 nodes and vary per task; the old
five-node layout no longer holds.

---

## 5. Merge conflict map

| File | P1 | P2 | P3 | P4 | Note |
|---|:--:|:--:|:--:|:--:|---|
| `types.ts` | read | **write** | read | — | P1 is told not to edit it; conflict unlikely |
| `app.ts` | read | **write** | — | — | P2 owns group schemas + routes per instructions |
| `memory/group-chain.ts` | — | **write** | — | — | exclusive |
| `memory/group-prompt.ts` | — | **write** | — | — | exclusive |
| `memory/planner.ts` | read | **write** | — | — | new, exclusive |
| `memory/group-runner.ts` | **write** | read | — | — | P2 did not touch it |
| `index.ts` | **write** | — | — | — | §4.1 step 1 lands here |
| `config.ts` | — | — | **write** | — | untouched by P2 |
| `apps/web/**` | — | — | — | **write** | untouched by P2 |
| the five fixtures in §1.1 | 1 line | 1 line | 4 lines | — | declared cross-boundary |

Person 2's branch has **no overlap with Person 4** and **no overlap with Person
3** except the four declared fixture lines. The only real merge surface is
Person 1 ↔ Person 2, and only if Person 1 edits `types.ts` or `app.ts` despite
being told not to.

---

## 6. Verification state

**Green:**

```text
npm run typecheck -w @launchpad/server     clean
planner.test.ts                            33 passed
group-prompt.test.ts                       20 passed
app.test.ts + app.groups.test.ts           13 passed
                                           66 passed across the four owned files
full server suite                          178 passed / 190
```

**Red — 12 tests, all asserting the removed contract, all in files Person 1
owns:**

```text
memory/group-runner.test.ts   11 failed
  "requires exactly one Agent per role"          — the rule was removed
  "runs the five-node chain in role order"       — plans are not five nodes
  + 9 asserting node counts of 5/6, role-named
    nodes, and code/apps/server/** locks from
    the old template
integration-e2e.test.ts        1 failed
  asserts a five-node chain end to end
```

These are the contract change landing. Per
[`TODO_Instructions/README.md`](../TODO_Instructions/README.md) — "Each person
should run targeted tests for their own boundary. The full `npm run check`
happens after integration" — they are expected to be red at this point and are
rewritten in §4.1 step 5.

**Not verified here:** no live Ark planner call has been made. Every planner test
uses `FakePlannerClient` or a stub client returning fixed text. The real-model
path (`MEMORY_EXTRACTOR=ark`) is exercised only by the shared `ArkExtractorClient`
transport, which predates this work.

---

## 7. Acceptance, against `Person_2.md`

| Criterion | State |
|---|---|
| Different task prompts can produce different validated plans | Done — `planner.test.ts` "different prompts produce different plans" |
| Groups can contain any explicitly selected number of Agents | Done — schema, `findMembershipError()`, tests |
| Every persisted node has a short instruction and auditable dependencies | Done — required field, transitive `allowedPlanNodeIds` |
| Invalid or cyclic planner output cannot reach execution | Done — whole-plan rejection, then deterministic fallback |
| Person 1 can execute the planner result without role reconstruction | Done — nodes carry `agentId` and `instruction`; §4.1 is a one-line swap |
| Targeted contract and planner tests pass without Ark | Done — 66 passed, no network |
| Ownership hints / runtime locks constrained and documented | Done — §2.4, `PLANNER.md`, `deriveOwnership()` |
| Legacy `memberAgentIds` kept at the store boundary only | Unchanged — still localised in `store.ts`; never reintroduced to the API |
