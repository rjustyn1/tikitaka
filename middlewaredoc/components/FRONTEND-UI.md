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
export type GroupRole = "backend" | "frontend" | "security";

export interface GroupMember {
  agentId: string;
  role: GroupRole;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  members: GroupMember[];   // A4: replaces memberAgentIds

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

---

## Additions From The A1-A5 Review

### api.ts - fix `request()` before copying any snippet above

`apps/web/src/api.ts` currently takes a **pre-stringified** body:

```ts
body: JSON.stringify(body)
```

Every snippet in this document passes a raw object, which would POST the string
`"[object Object]"`. Fix `request()` to stringify objects once, then all the
snippets above are correct as written:

```ts
async function request<T>(url: string, options?: RequestInit & { body?: unknown }) {
  const body = options?.body === undefined ? undefined
    : typeof options.body === "string" ? options.body
    : JSON.stringify(options.body);
  // ...
}
```

Do this first. It is a five-minute change and it unblocks every other call.

### A4 - group modal with roles

```text
Agent toggles PLUS a role selector per selected Agent.
Roles: backend | frontend | security. Exactly one Agent each.
Submit disabled until all three roles are filled.
Nothing selected by default.
Render the resulting chain above the composer:
  Backend -> Frontend -> Security -> Backend -> Frontend
```

### A5 - the proof beat (Person 4 owns this)

The demo's payoff, driven from the landed-memory view. Two buttons:

```text
POSITIVE  fresh-thread solo run on the TARGET Agent
          api.sendMessage(targetAgentId, prompt, { freshThread: true })
          prompt invokes the skill explicitly by $skill-name
          the Agent answers using the landed memory

NEGATIVE  same prompt, same moment, on a WITHHELD Agent
          that workspace has no such file
          the Agent cannot answer, and the ledger names the withholding reason
```

`freshThread: true` is required. A resumed thread may not re-read a changed
`AGENTS.md`, so a normal solo run can silently fail to show the memory.

### Polling - one endpoint

Poll `GET /api/groups/:id/tasks/:taskId` only. `/timeline` and
`/context-injections` are debugging projections of that same response; polling
them separately invites drift.

### Labelling correction for the context packet viewer

In a sequential chain, `withheldMessageIds` means **already seen by this Agent**
(lastSeenSeq dedupe), *not* **denied by policy**. Label it "already seen" in the
UI. The governance withholding story lives in the grant ledger, where
`decision: "withheld"` carries a real reason. Do not conflate them on stage.

### Sequential v1 - what NOT to promise

```text
The DAG/node panel shows a five-node CHAIN in v1, not a branch diagram.
"branch context does not leak sibling output" does not exist - no siblings.
Runtime locks are displayed as records (which node held which paths),
  not as collision prevention.
```

### Make the ledger readable

`MemoryNote` and `GrantRecord` carry only UUIDs. Ask Person 1 to resolve Agent
and group names into the response DTOs, or build a local `agentId -> name` map
from `listAgents()`. A ledger of raw hex is unreadable on stage.
