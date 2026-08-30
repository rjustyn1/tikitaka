# Spec — Contracts

> **The one question this answers: what exactly do I build against.**
> Field names, enums, store shape, routes, config keys. If a name appears
> here and in a component TD, this file wins.
>
> Rationale lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> Who and when lives in [`PLAN.md`](./PLAN.md).
> Why a contract looks like this lives in [`DECISIONS.md`](./DECISIONS.md).
> Module internals, including each module's own file formats, live in
> [`components/`](./components/).

---

# Part 1 — Types And Store

## Component

`apps/server/src/types.ts` and `apps/server/src/store.ts`

## Purpose

Define the shared contracts used by group chat, DAG execution, context
injection, memory notes, review, landing, and ledger records.

This should be implemented before the other modules so every component imports
the same types.

## Database Shape

Extend `Database`:

```ts
export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  spans: TraceSpan[];

  groups: AgentGroup[];
  groupTasks: GroupTask[];
  groupMessages: GroupMessage[];
  groupParticipants: GroupParticipantState[];
  groupPlanNodes: GroupPlanNode[];
  contextInjections: GroupContextInjection[];
  notes: MemoryNote[];
  grants: GrantRecord[];
  runtimeLocks: GroupRuntimeLock[];
  landedMemoryFiles: LandedMemoryFile[];
}
```

## Group Types

```ts
export type GroupRole =
  | "backend"
  | "frontend"
  | "security"
  | (string & {});

export interface GroupMember {
  agentId: string;
  role: GroupRole;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  // Replaces memberAgentIds. Between 2 and 12 unique Agents.
  members: GroupMember[];
  activeTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupParticipantState {
  groupId: string;
  agentId: string;
  membershipEpoch: number;
  role: string;
  agentWorkspacePath: string;
  groupThreadId: string | null;
  lastSeenSeq: number;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export interface GroupTask {
  id: string;
  groupId: string;
  prompt: string;
  sharedCodePath: string;
  status: GroupTaskStatus;
  currentNodeId: string | null;
  nodeRunIds: string[];
  flushedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  seq: number;
  speakerType: "human" | "agent";
  speakerAgentId: string | null;
  groupTaskId: string | null;
  planNodeId: string | null;
  content: string;
  createdAt: string;
}
```

## DAG Types

```ts
export type GroupPlanNodeKind = "work" | "join";

export interface GroupPlanNode {
  id: string;
  groupTaskId: string;
  agentId: string;
  kind: GroupPlanNodeKind;
  nodeRole: string;
  dependsOn: string[];
  contextSnapshotSeq: number;
  allowedPlanNodeIds: string[];
  status: GroupTaskStatus;
  runId: string | null;
  output: string | null;
  error: string | null;
  readOnly: boolean;
  fileOwnershipHints: string[];
  runtimeLocks: string[];
  expectedOutput: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GroupContextInjection {
  id: string;
  groupTaskId: string;
  planNodeId: string;
  agentId: string;
  fromSeqExclusive: number;
  toSeqInclusive: number;
  injectedMessageIds: string[];
  injectedDependencyNodeIds: string[];
  withheldMessageIds: string[];
  createdAt: string;
}

export interface GroupRuntimeLock {
  id: string;
  groupTaskId: string;
  lockKey: string;
  holderPlanNodeId: string;
  acquiredAt: string;
  releasedAt: string | null;
}
```

## Memory Types

```ts
export type MemorySeverity = "normal" | "severe";
export type MemoryStatus =
  | "candidate"
  | "pending"
  | "quarantined"
  | "active"
  | "rejected"
  | "revoked";

export interface MemoryNote {
  id: string;
  groupTaskId: string;
  groupId: string;
  content: string;
  severity: MemorySeverity;
  status: MemoryStatus;
  targetAgentIds: string[];
  description: string;
  sourceRunIds: string[];
  sourceSpanIds: string[];
  rationale: string;
  redactionFired: boolean;
  quarantineHit: boolean;
  safetyReasons: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LandedMemoryFile {
  id: string;
  noteId: string;
  agentId: string;
  kind: "agents_md" | "skill";
  path: string;
  createdAt: string;
  removedAt: string | null;
}

export interface GrantRecord {
  id: string;
  groupTaskId: string;
  noteId: string;
  agentId: string;
  decision: "granted" | "withheld" | "rejected" | "revoked";
  reason: string;
  filePath: string | null;
  reviewerName: string | null;
  createdAt: string;
}
```

## Store Initialization

`store.ts` should keep backward compatibility with old JSON files:

```ts
if (!Array.isArray(parsed.groups)) parsed.groups = [];
if (!Array.isArray(parsed.groupTasks)) parsed.groupTasks = [];
if (!Array.isArray(parsed.groupMessages)) parsed.groupMessages = [];
if (!Array.isArray(parsed.groupParticipants)) parsed.groupParticipants = [];
if (!Array.isArray(parsed.groupPlanNodes)) parsed.groupPlanNodes = [];
if (!Array.isArray(parsed.contextInjections)) parsed.contextInjections = [];
if (!Array.isArray(parsed.notes)) parsed.notes = [];
if (!Array.isArray(parsed.grants)) parsed.grants = [];
if (!Array.isArray(parsed.runtimeLocks)) parsed.runtimeLocks = [];
if (!Array.isArray(parsed.landedMemoryFiles)) parsed.landedMemoryFiles = [];
```

## Mutation Rule

All modules should use `JsonStore.mutate()` for writes. Do not keep independent
module-level state for groups, nodes, locks, notes, or grants.

The store already serializes writes with an internal promise queue, so modules
should prefer one mutation per state transition.

## Tests

- initializes all new arrays for a missing database;
- backfills all new arrays for an old database;
- preserves existing agents/runs/messages/spans;
- serializes concurrent mutations;
- stores and returns group task objects without losing nested arrays.

---

## Additions From The A1-A5 Review

These three contracts are owned by Person 1 and unblock Person 2 and Person 4.
See "Resolved Blockers (A1-A5)" in `DECISIONS.md` for rationale.

### A2 - shared code on the runner request

`RunnerRequest` gains one optional field. It is the only change the runners need:

```ts
export interface RunnerRequest {
  agentId: string;
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /**
   * A2. Absolute host path of the group task's shared code directory.
   * container runtime  -> extra bind mount at /workspace/code
   * local-process      -> codex exec --add-dir <path>
   * Omitted for solo runs.
   */
  sharedCodePath?: string;
  onSpan?: (span: TraceSpan) => void;
  onThreadId?: (id: string) => void;
}
```

### A3 - the Agent lease

One lease shared by solo runs and group nodes. This is the fix for
`CodexRunner.active` and `containerName()` both being keyed by `agentId`.

```ts
export type AgentLeaseHolder =
  | { kind: "solo"; runId: string }
  | { kind: "group"; groupTaskId: string; planNodeId: string };

export interface AgentLease {
  acquireAgent(agentId: string, holder: AgentLeaseHolder): Promise<Agent>;
  releaseAgent(agentId: string, holder: AgentLeaseHolder): Promise<void>;
}
```

```text
acquireAgent flips status to busy inside ONE store.mutate() and throws 409 if held.
The existing sendMessage() busy check becomes a call to acquireAgent.
releaseAgent runs in a finally block on both paths.
No re-entrancy needed: the v1 chain is sequential, so an Agent taking two turns
  acquires and releases twice with no overlap.
initialize() clears stale leases on restart, next to the existing run reset.
```

### A5 - fresh-thread solo runs

```ts
export interface SendMessageInput {
  content: string;
  /**
   * A5. Start a NEW Codex thread instead of resuming Agent.codexThreadId,
   * so AGENTS.md and .agents/skills are re-read from disk. This is what makes
   * landed governed memory observable in the demo.
   */
  freshThread?: boolean;
}
```

`AgentService.sendMessage()` passes `threadId: null` when `freshThread` is true.
`Agent.codexThreadId` is still updated from the result.

### Group task restart recovery

`initialize()` currently resets stale runs and busy Agents. It must also:

```text
GroupTask.status running/queued -> cancelled
group.activeTaskId -> null
GroupPlanNode status running/queued -> cancelled
GroupRuntimeLock.releasedAt -> now() where null
release any stale Agent leases
```

Without this, a server restart mid-task leaves the group permanently unable to
start another task.

---

## Configuration Keys

Owned by Person 1, in `apps/server/src/config.ts`. None of these exist yet; the
file was in no workstream's scope until the A1-A5 review.

| Key | Values | Purpose |
|---|---|---|
| `MEMORY_ENABLED` | `true` \| `false` | master switch; `false` restores exact baseline behaviour with no group/memory features |
| `MEMORY_EXTRACTOR` | `ark` \| `fake` \| `off` | extractor backend. `fake` is the deterministic offline demo path and is required for tests |
| `MEMORY_EXTRACT_TIMEOUT_MS` | number | consolidator call timeout |
| `REVIEW_ALL_SKILLS` | `true` \| `false` | force every skill through HITL, for a high-security posture |
| `SKILLS_DIR` | `.agents/skills` | **verified** against `@openai/codex@0.111.0` — discovered with `scope: "repo"`, no git repo required. `.codex/skills` also works. Never `$CODEX_HOME/skills`, which is `scope: "user"` and global to every Agent |

`MEMORY_EXTRACTOR=fake` must be the default in tests so `npm run check` never
touches the network. See `EXTRACTOR-CLIENT.md` for the client implementations.

---

# Part 2 — API Routes

## Component

`apps/server/src/app.ts`

## Purpose

Expose group task execution, memory review, and audit data to the frontend.

## Routes

```text
GET    /api/groups
POST   /api/groups
GET    /api/groups/:id
PATCH  /api/groups/:id

POST   /api/groups/:id/tasks
GET    /api/groups/:id/tasks/:taskId
GET    /api/groups/:id/tasks/:taskId/timeline
GET    /api/groups/:id/tasks/:taskId/context-injections

GET    /api/notes?agentId=&status=
POST   /api/notes/:id/review
POST   /api/notes/:id/revoke

GET    /api/agents/:id/memory
GET    /api/tasks/:id/grants
```

## Code-Level Spec

Add Zod schemas near the existing route schemas:

```ts
const groupIdParams = z.object({ id: z.string().uuid() });
const groupTaskParams = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
});
const noteIdParams = z.object({ id: z.string().uuid() });
const taskIdParams = z.object({ id: z.string().uuid() });

const groupMemberBody = z.object({
  agentId: z.string().uuid(),
  role: z.string().trim().min(1).max(40).default("member"),
});

const groupMembersBody = z.array(groupMemberBody).min(2).max(12)
  .superRefine((members, ctx) => {
    if (new Set(members.map((member) => member.agentId)).size !== members.length) {
      ctx.addIssue({
        code: "custom",
        message: "Each Agent can appear only once in a group",
      });
    }
  });

const createGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  members: groupMembersBody,
});

const updateGroupBody = createGroupBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

const startGroupTaskBody = z.object({
  prompt: z.string().trim().min(1).max(50_000),
});

const reviewNoteBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), reviewerName: z.string().trim().min(1) }),
  z.object({
    type: z.literal("edit"),
    reviewerName: z.string().trim().min(1),
    content: z.string().trim().min(1).max(2000).optional(),
    severity: z.enum(["normal", "severe"]).optional(),
    targetAgentIds: z.array(z.string().uuid()).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    approveAfterEdit: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("reject"),
    reviewerName: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(500),
  }),
]);

const revokeNoteBody = z.object({
  reviewerName: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
});
```

Route handlers:

```ts
app.get("/api/groups", async () => ({ groups: service.listGroups() }));

app.post("/api/groups", async (request, reply) => {
  const body = createGroupBody.parse(request.body);
  return reply.code(201).send({ group: await service.createGroup(body) });
});

app.post("/api/groups/:id/tasks", async (request, reply) => {
  const { id } = groupIdParams.parse(request.params);
  const body = startGroupTaskBody.parse(request.body);
  return reply.code(202).send({ task: await service.startGroupTask(id, body.prompt) });
});

app.get("/api/groups/:id/tasks/:taskId", async (request) => {
  const { taskId } = groupTaskParams.parse(request.params);
  return service.getGroupTask(taskId);
});
```

Prefer adding methods to `AgentService` that delegate to `GroupRunner` and
memory services. Keep Fastify routes thin.

## Route Ownership

Routes should stay thin:

- validate request body with `zod`;
- call `AgentService` or memory service methods;
- return DTOs;
- never perform workspace writes directly.

## Important Errors

```text
400 invalid request body
404 group/task/note not found
409 group task already running
409 membership cannot change during running task
409 agent already busy
503 Ark/Codex unavailable when required
```

## Polling Shape

Task endpoint returns:

```ts
interface GroupTaskResponse {
  task: GroupTask;
  nodes: GroupPlanNode[];
  messages: GroupMessage[];
  contextInjections: GroupContextInjection[];
}
```

## Tests

- create group with selected Agent IDs;
- reject membership updates while task running;
- start group task;
- return timeline and node statuses;
- review note;
- revoke note;
- auth hook still protects new API routes.

---

## Additions From The A1-A5 Review

### A5 - freshThread on the existing solo message route

The proof beat reuses `POST /api/agents/:id/messages`. One optional field:

```ts
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  // A5: start a NEW Codex thread so AGENTS.md and .agents/skills are re-read.
  freshThread: z.boolean().default(false),
});
```

No new route. `AgentService.sendMessage()` passes `threadId: null` when set.

### A4 - membership validation (superseded)

```text
POST /api/groups          400 unless there are 2-12 unique Agent members
PATCH /api/groups/:id     409 while group.activeTaskId is set
POST /api/groups/:id/tasks planner selects relevant members from descriptions
```

Roles are free-form display labels. They do not assign work; the task planner
returns Agent ids directly after reading the prompt and member descriptions.

### A3 - lease-aware error codes

```text
409 agent already busy       solo run attempted while a group node holds the lease
409 agent held by group task include the groupTaskId in the message
```

Routes must surface these as 409, never as a 500. Today a solo message sent
during a group run reaches `CodexRunner` and throws
`"Agent already has an active Codex process"` as an unhandled error.

### Alias routes - must not drift

`/timeline` and `/context-injections` return data already present in
`GroupTaskResponse`. Keep them, but implement both as **thin projections of the
same service call**, never as independent queries:

```ts
const full = service.getGroupTask(taskId);

app.get("/api/groups/:id/tasks/:taskId/timeline", async (request) =>
  ({ messages: full.messages }));

app.get("/api/groups/:id/tasks/:taskId/context-injections", async (request) =>
  ({ contextInjections: full.contextInjections }));
```

Person 4 should poll `GET /api/groups/:id/tasks/:taskId` only. The aliases exist
for debugging and for narrating the demo, not for the polling loop.

### Route list correction

`GET /api/groups/:id` is specified in this document but was missing from
Person 1's build scope in `DECISIONS.md`. It is in scope.

### Cancel a running group task

Not previously specified anywhere, and needed: `CODEX_TIMEOUT_MS` defaults to
600s and the v1 chain has five nodes.

```text
POST /api/groups/:id/tasks/:taskId/cancel   -> 202
  marks the task cancelled
  cancels the in-flight node run
  releases the Agent lease and any runtime lock rows
  remaining nodes are marked cancelled, never started
```
