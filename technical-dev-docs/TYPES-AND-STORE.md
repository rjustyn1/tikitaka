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
export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  memberAgentIds: string[];
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
