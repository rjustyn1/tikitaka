# Types And Store Technical Design

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
export type GroupRole = "backend" | "frontend" | "security";

export interface GroupMember {
  agentId: string;
  role: GroupRole;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  // A4: replaces memberAgentIds. Exactly three, one per role.
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
See "Resolved Blockers (A1-A5)" in `IMPLEMENTATION_DIRECTION.md` for rationale.

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
