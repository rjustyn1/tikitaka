# Frontend UI Technical Design

## Component

`apps/web/src/App.tsx`

## Purpose

Add the UI needed to demo selected Agent groups, group task execution, DAG
progress, context injection, and memory review.

## Views

```text
Agents
  existing solo Agent management

Groups
  create/edit group with Agent toggles

Group Task
  prompt composer
  shared timeline
  DAG/node status
  selected Agent roster

Trace / Context
  per-node run trace
  injected messages
  injected dependency outputs
  withheld branch messages
  runtime locks

Memory Review
  pending/quarantined notes
  approve/edit/reject/revoke

Grant Ledger
  granted and withheld records per task/note
```

## Code-Level Spec

Extend `apps/web/src/types.ts` with DTOs mirroring server types:

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

export interface GroupTask {
  id: string;
  groupId: string;
  prompt: string;
  sharedCodePath: string;
  status: "queued" | "running" | "completed" | "partial" | "cancelled" | "failed";
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

export interface GroupPlanNode {
  id: string;
  groupTaskId: string;
  agentId: string;
  kind: "work" | "join";
  nodeRole: string;
  dependsOn: string[];
  contextSnapshotSeq: number;
  allowedPlanNodeIds: string[];
  status: GroupTask["status"];
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

export interface MemoryNote {
  id: string;
  groupTaskId: string;
  groupId: string;
  content: string;
  severity: "normal" | "severe";
  status: "candidate" | "pending" | "quarantined" | "active" | "rejected" | "revoked";
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

Extend `apps/web/src/api.ts`:

```ts
groups: () => request<{ groups: AgentGroup[] }>("/api/groups"),
createGroup: (body: CreateGroupBody) =>
  request<{ group: AgentGroup }>("/api/groups", { method: "POST", body }),
updateGroup: (id: string, body: UpdateGroupBody) =>
  request<{ group: AgentGroup }>(`/api/groups/${id}`, { method: "PATCH", body }),
startGroupTask: (groupId: string, prompt: string) =>
  request<{ task: GroupTask }>(`/api/groups/${groupId}/tasks`, {
    method: "POST",
    body: { prompt },
  }),
groupTask: (groupId: string, taskId: string) =>
  request<GroupTaskResponse>(`/api/groups/${groupId}/tasks/${taskId}`),
notes: (query?: string) => request<{ notes: MemoryNote[] }>(`/api/notes${query ?? ""}`),
reviewNote: (id: string, body: ReviewNoteBody) =>
  request<{ note: MemoryNote }>(`/api/notes/${id}/review`, { method: "POST", body }),
revokeNote: (id: string, body: RevokeNoteBody) =>
  request<{ note: MemoryNote }>(`/api/notes/${id}/revoke`, { method: "POST", body }),
taskGrants: (taskId: string) =>
  request<{ grants: GrantRecord[] }>(`/api/tasks/${taskId}/grants`),
```

State additions in `App.tsx`:

```ts
const [groups, setGroups] = useState<AgentGroup[]>([]);
const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
const [activeGroupTask, setActiveGroupTask] = useState<GroupTaskResponse | null>(null);
const [notes, setNotes] = useState<MemoryNote[]>([]);
const [grants, setGrants] = useState<GrantRecord[]>([]);
```

Polling:

```ts
useEffect(() => {
  if (!activeGroupTask || isTerminal(activeGroupTask.task.status)) return;
  const timer = setInterval(() => refreshGroupTask(), 2000);
  return () => clearInterval(timer);
}, [activeGroupTask?.task.id]);
```

First demo UI can stay in one React file. Add small components inside `App.tsx`
before extracting files:

```text
GroupList
GroupEditor
GroupTaskComposer
GroupTimeline
DagStatusPanel
ContextInjectionPanel
MemoryReviewPanel
GrantLedgerPanel
```

## Demo Flow

The first demo should make these visible:

- selected members only;
- shared code path;
- separate group thread per Agent;
- branch nodes and join nodes;
- exact context packet for each node;
- proposed memory notes after task completion;
- grant and withheld decisions.

## UI Rules

- Use checkboxes/toggles for group membership.
- Use tabs for task timeline, DAG, context, memory, and ledger.
- Use badges for node status.
- Use compact tables for grants and context injections.
- Do not auto-select all Agents by default.

## API Needs

Frontend needs DTOs for:

- groups;
- group tasks;
- group messages;
- plan nodes;
- context injections;
- notes;
- grants.

## Tests

- group modal starts with no Agents selected;
- selected Agents appear in group roster;
- task polling updates node statuses;
- context packet viewer shows injected/withheld messages;
- review action updates note state;
- revoked note disappears from active memory view.
