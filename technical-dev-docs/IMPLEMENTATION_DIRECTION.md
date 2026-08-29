# Implementation Direction

## Goal

Split the remaining implementation into four balanced workstreams for a
four-person team.

The implementation should follow the component TDs in this folder, especially:

- `TYPES-AND-STORE.md`
- `GROUPCHAT.md`
- `GROUP-RUNNER.md`
- `WORKSPACE-EXTENSIONS.md`
- `TASK-BUFFER.md`
- `CONSOLIDATOR.md`
- `SAFETY.md`
- `LANDING.md`
- `REVIEW.md`
- `LEDGER.md`
- `API-ROUTES.md`
- `FRONTEND-UI.md`

Core architecture:

```text
private Agent roots
+ shared group code under ./code
+ app-owned group transcript
+ branch-and-join group DAG
+ governed memory landing into private Agent workspaces
```

---

## Person 1 - Data, Store, And API Contracts

### Ownership

This person owns the backend contracts that unblock everyone else.

Primary files:

```text
apps/server/src/types.ts
apps/server/src/store.ts
apps/server/src/app.ts
apps/web/src/types.ts
apps/web/src/api.ts
technical-dev-docs/TYPES-AND-STORE.md
technical-dev-docs/API-ROUTES.md
```

### Build Scope

Implement the shared types:

```text
AgentGroup
GroupTask
GroupMessage
GroupParticipantState
GroupPlanNode
GroupContextInjection
GroupRuntimeLock
MemoryNote
LandedMemoryFile
GrantRecord
```

Extend the database:

```text
groups
groupTasks
groupMessages
groupParticipants
groupPlanNodes
contextInjections
runtimeLocks
notes
landedMemoryFiles
grants
```

Add store backfill for existing JSON databases.

Add route schemas and route stubs for:

```text
GET /api/groups
POST /api/groups
PATCH /api/groups/:id
POST /api/groups/:id/tasks
GET /api/groups/:id/tasks/:taskId
GET /api/groups/:id/tasks/:taskId/context-injections
GET /api/notes
POST /api/notes/:id/review
POST /api/notes/:id/revoke
GET /api/agents/:id/memory
GET /api/tasks/:id/grants
```

### Integration Contract

Expose service methods that other teammates can call:

```ts
createGroup(input)
updateGroup(id, input)
listGroups()
getGroup(id)
startGroupTask(groupId, prompt)
getGroupTask(taskId)
listNotes(query)
reviewNote(id, input)
revokeNote(id, input)
listAgentMemory(agentId)
listTaskGrants(taskId)
```

Initial route handlers may call placeholder service methods until Person 2 and
Person 3 finish their modules.

### Done When

- New types compile on server and web.
- Old database files load with empty new arrays.
- Route stubs validate inputs with Zod.
- Tests cover store backfill and basic route validation.

---

## Person 2 - Group Runner, DAG, And Shared Code Setup

### Ownership

This person owns the group execution path and shared code mechanics.

Primary files:

```text
apps/server/src/memory/group-runner.ts
apps/server/src/memory/flush-trigger.ts
apps/server/src/workspace.ts
apps/server/src/agent-service.ts
technical-dev-docs/GROUPCHAT.md
technical-dev-docs/GROUP-RUNNER.md
technical-dev-docs/FLUSH-TRIGGER.md
technical-dev-docs/WORKSPACE-EXTENSIONS.md
```

### Build Scope

Implement group lifecycle:

```text
create group
update group membership
freeze membership during running task
create membership epoch
create fresh groupThreadId on re-add
```

Implement shared code setup:

```text
workspaces/shared-code/<groupTaskId>
<agent.workspacePath>/code -> shared-code/<groupTaskId>
```

Implement planner-written group-task sections in each selected Agent's private
`AGENTS.md`.

Implement the preseeded demo DAG:

```text
backend-contract
  -> frontend-plan
  -> security-review
join-plan
  -> backend-impl
  -> frontend-impl
final-join
```

Implement DAG validation:

```text
no duplicate Agent in one parallel phase
no overlapping write paths
no duplicate runtime locks
join nodes depend on all branches they integrate
```

Implement execution:

```text
find runnable nodes
build prompt
call AgentRunner with participant.groupThreadId
persist groupThreadId back to participant state
save node output
save group message
release locks in finally
finish at final join
call flush trigger
```

### Integration Contract

Use existing runner interface:

```ts
runner.run({
  agentId,
  runId,
  workspacePath: participant.agentWorkspacePath,
  threadId: participant.groupThreadId,
  prompt,
});
```

Person 2 should not implement memory extraction or landing. After task
completion, call a placeholder memory pipeline hook that Person 3 can replace.

### Done When

- A group task can run through the preseeded DAG with a fake runner.
- Group messages appear in order.
- Group thread IDs are separate from solo `codexThreadId`.
- Shared `./code` exists for every selected Agent.
- Duplicate Agent/path/runtime-lock parallel plans are rejected before launch.

---

## Person 3 - Memory Pipeline, Safety, Landing, And Audit

### Ownership

This person owns the governed memory pipeline after group task completion.

Primary files:

```text
apps/server/src/memory/task-buffer.ts
apps/server/src/memory/extractor-client.ts
apps/server/src/memory/consolidator.ts
apps/server/src/memory/safety.ts
apps/server/src/memory/landing.ts
apps/server/src/memory/review.ts
apps/server/src/memory/ledger.ts
apps/server/src/workspace.ts
technical-dev-docs/TASK-BUFFER.md
technical-dev-docs/EXTRACTOR-CLIENT.md
technical-dev-docs/CONSOLIDATOR.md
technical-dev-docs/SAFETY.md
technical-dev-docs/LANDING.md
technical-dev-docs/REVIEW.md
technical-dev-docs/LEDGER.md
```

### Build Scope

Implement task buffer:

```text
read group task
read plan nodes
read runs/spans
topologically order node outputs
include context injection IDs
filter noisy spans
cap final buffer size
```

Implement extractor client:

```text
FakeExtractorClient for tests/demo
OffExtractorClient for disabled memory
ArkExtractorClient behind config
```

Implement consolidator:

```text
strict JSON parsing
candidate note schema
max 5 notes
source run/span validation
target Agent validation
```

Implement safety:

```text
secret redaction
quarantine detection
review-required signals
```

Implement landing:

```text
severe notes -> private Agent AGENTS.md managed block
normal notes -> private Agent .agents/skills/<slug>/SKILL.md
never write governed memory into shared code
idempotent landing
precise revoke
```

Implement review and ledger:

```text
candidate -> active/pending/quarantined
approve/edit/reject/revoke
grant records
withheld records
append-only audit
```

### Integration Contract

Expose one pipeline entrypoint for Person 2:

```ts
runMemoryPipeline(groupTaskId: string, sinkNodeIds: string[]): Promise<void>
```

This method should:

```text
build task buffer
extract candidate notes
run safety
auto-land clean normal notes
queue risky notes for review
write grant/withheld ledger records
```

Memory failures must not fail the completed group task.

### Done When

- Fake extractor produces deterministic candidate notes.
- Safety redacts fake secrets and quarantines prompt-injection shapes.
- Landing writes only to private Agent workspaces.
- Ledger shows granted and withheld Agents.
- Revoke removes files but keeps audit records.

---

## Person 4 - Frontend Demo Experience And End-To-End QA

### Ownership

This person owns the user-facing demo flow and end-to-end verification.

Primary files:

```text
apps/web/src/App.tsx
apps/web/src/api.ts
apps/web/src/types.ts
apps/web/src/styles.css
apps/server/src/app.test.ts
technical-dev-docs/FRONTEND-UI.md
technical-dev-docs/API-ROUTES.md
technical-dev-docs/BUILD-SEQUENCE.md
```

### Build Scope

Implement frontend states:

```text
groups
selected group
active group task
group messages
plan nodes
context injections
notes
grants
```

Implement UI:

```text
group creation modal with Agent toggles
group roster
group task composer
shared group timeline
DAG/node status panel
context injection viewer
memory review queue
grant ledger view
landed memory view
```

Implement API client methods:

```text
groups
createGroup
updateGroup
startGroupTask
groupTask
notes
reviewNote
revokeNote
taskGrants
agentMemory
```

Implement polling:

```text
poll active group task every 2s until terminal
refresh notes after task completes
refresh grants after review actions
```

Prepare demo fixtures and QA:

```text
Backend, Frontend, Security Agents
Upload Feature Team group
preseeded upload-feature DAG
fake extractor memory notes
grant/withheld audit view
revocation action
```

### Integration Contract

Person 4 depends on Person 1 route shapes first. Person 4 can build against mock
responses while Person 2 and Person 3 finish backend behavior.

The demo should visibly prove:

```text
only selected Agents joined
each Agent has separate groupThreadId
all Agents edit shared ./code
branch context does not leak sibling output
join owner receives branch outputs
memory lands only in target private Agent workspace
withheld records exist for non-target Agents
```

### Done When

- User can create a group with toggles.
- User can start a group task.
- Timeline and DAG status update while task runs.
- Context packet viewer shows injected and withheld messages.
- Review queue supports approve/edit/reject/revoke.
- Grant ledger clearly shows who received or did not receive memory.

---

## Cross-Team Integration Points

## Bridge Contracts

These are the explicit handoff points between workstreams. Each bridge lists the
producer, consumer, contract, and mock strategy.

### Bridge 1 - Person 1 To Everyone: Shared Types And Store

Producer:

```text
Person 1
```

Consumers:

```text
Person 2 group runner
Person 3 memory pipeline
Person 4 frontend
```

Contract:

```text
apps/server/src/types.ts exports all group/memory types
apps/web/src/types.ts mirrors response DTOs
Database includes all new arrays
JsonStore.initialize() backfills missing arrays
```

Required types:

```text
AgentGroup
GroupTask
GroupMessage
GroupParticipantState
GroupPlanNode
GroupContextInjection
GroupRuntimeLock
MemoryNote
LandedMemoryFile
GrantRecord
```

How others connect:

```text
Person 2 imports group/task/node/participant/context types.
Person 3 imports task/node/span/note/grant/landed-file types.
Person 4 imports web DTOs from apps/web/src/types.ts only.
```

Mock strategy before Person 1 lands:

```text
Use local test-only interfaces in fixtures.
Delete local duplicates once shared types land.
Do not commit divergent permanent type definitions.
```

Done signal:

```text
npm typecheck passes with new empty arrays in Database.
Old .data/launchpad.json still loads.
```

### Bridge 2 - Person 1 To Person 2: Route Stub To Group Runner

Producer:

```text
Person 1 route stubs
```

Consumer:

```text
Person 2 GroupRunner
```

Contract:

```ts
interface GroupServiceApi {
  createGroup(input: CreateGroupInput): Promise<AgentGroup>;
  updateGroup(id: string, input: UpdateGroupInput): Promise<AgentGroup>;
  listGroups(): AgentGroup[];
  getGroup(id: string): AgentGroup;
  startGroupTask(groupId: string, prompt: string): Promise<GroupTask>;
  getGroupTask(taskId: string): GroupTaskResponse;
}
```

How to connect:

```text
Person 1 wires Fastify route handlers to AgentService methods.
Person 2 adds GroupRunner as a dependency of AgentService.
AgentService delegates group methods to GroupRunner.
```

Mock strategy:

```text
Routes may return 501 or fixture data until GroupRunner is available.
Person 4 can build UI against fixture-shaped responses.
```

Done signal:

```text
POST /api/groups creates a real group.
POST /api/groups/:id/tasks creates a real task and returns 202.
GET /api/groups/:id/tasks/:taskId returns task, nodes, messages, and context injections.
```

### Bridge 3 - Person 2 To Existing Runner: Group Node To Codex

Producer:

```text
Person 2 GroupRunner
```

Consumer:

```text
Existing AgentRunner implementation
```

Contract:

```ts
runner.run({
  agentId,
  runId,
  workspacePath: participant.agentWorkspacePath,
  threadId: participant.groupThreadId,
  prompt,
  onThreadId,
  onSpan,
});
```

How to connect:

```text
Use participant.groupThreadId for group work.
Do not read or write Agent.codexThreadId for group tasks.
Use participant.agentWorkspacePath as cwd.
Tell the Agent to edit shared code under ./code.
Persist returned threadId back to GroupParticipantState.groupThreadId.
Persist spans into Database.spans through the same callback pattern as solo runs.
```

Mock strategy:

```text
Use FakeRunner in tests to return canned output and fake thread IDs.
Do not require real Codex for unit tests.
```

Done signal:

```text
Solo codexThreadId is unchanged after a group task.
GroupParticipantState.groupThreadId is set after first group node run.
Group node spans are visible through run trace APIs.
```

### Bridge 4 - Person 2 To Person 3: Task Completion To Memory Pipeline

Producer:

```text
Person 2 GroupRunner
```

Consumer:

```text
Person 3 MemoryPipeline
```

Contract:

```ts
interface MemoryPipeline {
  runMemoryPipeline(groupTaskId: string, sinkNodeIds: string[]): Promise<void>;
}
```

When to call:

```text
After flush-trigger returns shouldFlush=true.
Usually after final join node completes in demo DAG.
```

Required state before calling:

```text
GroupTask status is completed or partial.
GroupPlanNode rows have runId, output, status, and completedAt.
GroupMessage rows exist for agent outputs.
GroupContextInjection rows exist for each node run.
TraceSpan rows exist for each run.
Runtime locks are released.
```

Failure behavior:

```text
MemoryPipeline errors are caught and logged.
GroupTask remains completed or partial.
No memory files are written if pipeline fails before review/landing.
```

Mock strategy:

```text
Person 2 uses NoopMemoryPipeline until Person 3 lands real implementation.
Person 3 tests pipeline with fixture group task data before real GroupRunner integration.
```

Done signal:

```text
After final join, fake extractor creates notes and review/ledger state appears.
```

### Bridge 5 - Person 2 To Person 3: Task Buffer Inputs

Producer:

```text
Person 2 GroupRunner
```

Consumer:

```text
Person 3 TaskBufferBuilder
```

Contract:

```text
Every completed GroupPlanNode must have:
  runId
  output
  status
  completedAt

Every run must have:
  AgentRun row
  TraceSpan rows

Every context injection must have:
  planNodeId
  agentId
  injectedMessageIds
  injectedDependencyNodeIds
  withheldMessageIds
```

How to connect:

```text
TaskBufferBuilder reads from JsonStore snapshot.
It should not call GroupRunner directly.
GroupRunner should not shape consolidator prompts directly.
```

Mock strategy:

```text
Person 3 creates fixture Database objects with completed nodes and spans.
Person 2 adds integration test using FakeRunner once both sides compile.
```

Done signal:

```text
TaskBufferBuilder can reconstruct ordered task entries from a real completed demo task.
```

### Bridge 6 - Person 3 Internal: Consolidator To Safety To Review

Producer:

```text
Person 3 Consolidator
```

Consumers:

```text
SafetyService
ReviewService
LandingService
LedgerService
```

Contract:

```text
Consolidator returns CandidateMemoryNote[].
Safety returns SafetyResult per candidate.
Review creates MemoryNote with status active/pending/quarantined/rejected/revoked.
Landing writes files only after review allows activation.
Ledger records every grant and withholding.
```

How to connect:

```text
runMemoryPipeline()
  -> TaskBufferBuilder.build()
  -> Consolidator.consolidate()
  -> Safety.evaluateNoteSafety()
  -> Review.processCandidate()
  -> Landing.landMemory() for active notes
  -> Ledger records grants and denials
```

Mock strategy:

```text
Use FakeExtractorClient for deterministic notes.
Use temporary workspaces for landing tests.
```

Done signal:

```text
One fake note can flow from task buffer to landed private Agent file with grant records.
One non-target Agent gets a withheld ledger record and no file.
```

### Bridge 7 - Person 3 To Person 1: Review And Ledger APIs

Producer:

```text
Person 3 ReviewService, LandingService, LedgerService
```

Consumer:

```text
Person 1 API routes
```

Contract:

```ts
listNotes(query): MemoryNote[];
reviewNote(noteId: string, input: ReviewNoteInput): Promise<MemoryNote>;
revokeNote(noteId: string, input: RevokeNoteInput): Promise<MemoryNote>;
listAgentMemory(agentId: string): LandedMemoryFile[];
listTaskGrants(taskId: string): GrantRecord[];
```

How to connect:

```text
API routes call service methods only.
Routes do not write files.
Routes do not mutate ledger directly.
```

Mock strategy:

```text
Person 1 can return empty arrays until services are ready.
Person 4 can build empty-state UI first.
```

Done signal:

```text
Approve/edit/reject/revoke calls update note state and grant/landed-file views.
```

### Bridge 8 - Person 1 To Person 4: API DTOs To Frontend

Producer:

```text
Person 1 API route shapes and web DTOs
```

Consumer:

```text
Person 4 frontend
```

Contract:

```ts
interface GroupTaskResponse {
  task: GroupTask;
  nodes: GroupPlanNode[];
  messages: GroupMessage[];
  contextInjections: GroupContextInjection[];
}
```

How to connect:

```text
Person 4 uses api.ts methods only.
Frontend should not infer server state from local-only mock objects once APIs exist.
Polling refreshes the whole GroupTaskResponse.
```

Mock strategy:

```text
Create mock GroupTaskResponse in App.tsx or a test helper.
Replace with api.groupTask() once route works.
```

Done signal:

```text
The UI can poll a running task and render node status, timeline, and context packets.
```

### Bridge 9 - Person 2 To Person 4: Demo Visibility

Producer:

```text
Person 2 GroupRunner
```

Consumer:

```text
Person 4 frontend
```

Contract:

```text
GroupTaskResponse includes:
  task.status
  task.sharedCodePath
  nodes with kind, nodeRole, dependsOn, status, runId, output, runtimeLocks
  messages with seq, speakerAgentId, planNodeId, content
  contextInjections with injected and withheld IDs
```

How to connect:

```text
GroupRunner persists enough detail for UI to explain the demo.
Frontend renders that persisted data without needing live access to runner internals.
```

Mock strategy:

```text
Person 4 can mock a completed upload-feature DAG response.
Person 2 should later provide the same shape from real store data.
```

Done signal:

```text
Demo screen can explain:
  who ran
  what node ran
  what each Agent saw
  what was withheld
  which files/locks were owned
```

### Bridge 10 - Person 3 To Person 4: Memory Review Demo

Producer:

```text
Person 3 memory services
```

Consumer:

```text
Person 4 frontend
```

Contract:

```text
MemoryNote rows expose:
  content
  severity
  status
  targetAgentIds
  description
  sourceRunIds
  sourceSpanIds
  redactionFired
  quarantineHit
  safetyReasons

GrantRecord rows expose:
  decision
  reason
  agentId
  filePath
  reviewerName
  createdAt
```

How to connect:

```text
Review UI calls reviewNote/revokeNote APIs.
After each action, refresh notes, grants, and landed memory.
```

Mock strategy:

```text
Person 4 can start with one pending note and one active note fixture.
Person 3 should provide fake extractor output that creates the same states.
```

Done signal:

```text
Demo can show an approved memory landing in Backend workspace and a withheld
record for Security or Frontend.
```

### Bridge 11 - Person 2 To Person 1: Runtime Lock State

Producer:

```text
Person 2 GroupRunner
```

Consumer:

```text
Person 1 store/API
Person 4 frontend
```

Contract:

```text
GroupRuntimeLock rows are created when a node starts.
releasedAt is set in finally.
Task response includes active or historical runtime locks if needed by UI.
```

How to connect:

```text
GroupRunner owns lock acquire/release.
API only exposes lock state.
Frontend only displays lock state.
```

Mock strategy:

```text
Use fixture locks in GroupTaskResponse until GroupRunner writes real locks.
```

Done signal:

```text
Parallel node validation fails before launch when two nodes request the same lock.
Completed task shows no unreleased locks.
```

## Shared Types

Person 1 should land `TYPES-AND-STORE` first. Everyone else should import those
types instead of defining local duplicates.

## Store Writes

All writes go through `JsonStore.mutate()`. Avoid module-level mutable state for
tasks, nodes, locks, notes, or grants.

## Workspace Writes

Only two areas should write files:

```text
WorkspaceManager:
  shared code setup
  group-task AGENTS.md sections

LandingService:
  governed memory files
  revoke/delete landed memory
```

## Codex Calls

Only two areas should call the runner:

```text
AgentService:
  solo Agent runs

GroupRunner:
  group DAG node runs
```

## Demo Order

Build and test in this order:

```text
1. Person 1 lands types, store arrays, and route stubs.
2. Person 2 lands group runner with fake runner.
3. Person 4 connects group UI to route stubs and fake task data.
4. Person 3 lands fake memory pipeline, safety, landing, and ledger.
5. Person 2 connects real group runner to memory pipeline.
6. Person 4 completes review/ledger UI and final demo path.
```

## Merge Risk

Highest overlap files:

```text
apps/server/src/types.ts
apps/server/src/app.ts
apps/server/src/workspace.ts
apps/web/src/types.ts
apps/web/src/api.ts
apps/web/src/App.tsx
```

Coordinate changes to these files before parallel coding. Everything under
`apps/server/src/memory/` can be split by component with lower conflict risk.
