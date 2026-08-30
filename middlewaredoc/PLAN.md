# Plan — Workstreams, Bridges, And Build Order

> **The one question this answers: who builds what, in what order.**
> Rationale lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> Contracts live in [`SPEC.md`](./SPEC.md).
> Decisions and their evidence live in [`DECISIONS.md`](./DECISIONS.md).
> Module internals live in [`components/`](./components/).

## Goal

Split the remaining implementation into four balanced workstreams for a
four-person team.

> ⚠️ **Read "Resolved Blockers (A1-A5)" and "Ownership Corrections" at the end of
> this file before starting.** They were added after a design review and they
> **supersede** anything above that contradicts them. The current integrated
> contract replaces `memberAgentIds` with 2-12 unique
> `members: [{agentId, role}]`; roles are display labels, and the planner reads
> Agent descriptions to produce a bounded, validated DAG. Nodes execute
> sequentially in topological order; parallel execution remains stretch scope.

The implementation should follow the component TDs in this folder, especially:

- `SPEC.md`
- `GROUP-CHAT-DESIGN.md`
- `GROUP-RUNNER.md`
- `WORKSPACE-EXTENSIONS.md`
- `TASK-BUFFER.md`
- `CONSOLIDATOR.md`
- `SAFETY.md`
- `LANDING.md`
- `REVIEW.md`
- `LEDGER.md`
- `SPEC.md`
- `FRONTEND-UI.md`

Core architecture:

```text
private Agent roots
+ shared group code under ./code
+ app-owned group transcript
+ planner-authored DAG, executed sequentially in validated topological order
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
SPEC.md
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
GET /api/groups/:id
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

## Person 2 - Group Runner, Sequential Chain, And Shared Code Setup

### Ownership

This person owns the group execution path and shared code mechanics.

Primary files:

```text
apps/server/src/memory/group-runner.ts
apps/server/src/memory/flush-trigger.ts
apps/server/src/workspace.ts
apps/server/src/agent-service.ts
GROUP-CHAT-DESIGN.md
components/GROUP-RUNNER.md
components/FLUSH-TRIGGER.md
components/WORKSPACE-EXTENSIONS.md
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
<agent.workspacePath>/code  (A2: symlink for local-process,
                             bind-mount target dir for container)
```

Implement planner-written group-task sections in each selected Agent's private
`AGENTS.md`.

Implement planner-backed task execution:

```text
give the planner the task plus every member's name and description
accept at most eight validated nodes using short integer Agent/dependency indexes
reject unknown Agents, malformed dependencies, duplicate edges and cycles
persist each node's instruction and expected output
derive ownership hints and locks from a fixed server-side area map
```

```text
STRETCH - current execution remains one node at a time:
  run independent planner nodes concurrently
  no duplicate Agent in one parallel phase
  no overlapping write paths
  no duplicate runtime locks
```

Implement execution (a plain `for` loop over topologically ordered nodes):

```text
acquire the A3 Agent lease
build prompt
call AgentRunner with participant.groupThreadId
  pass sharedCodePath so the runner mounts/--add-dirs shared code (A2)
persist groupThreadId back to participant state
save node output
save group message
release the lease in finally
finish at the last node
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

- A group task can run through the sequential chain with a fake runner.
- Group messages appear in order.
- Group thread IDs are separate from solo `codexThreadId`.
- Shared `./code` exists for every selected Agent.
- Solo and group runs never collide on the same Agent (A3 lease).
- Shared ./code is writable from inside a real Codex run in BOTH runtimes (A2).

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
apps/server/src/memory/workspace-memory.ts   # NOT workspace.ts (Person 2 owns that)
components/TASK-BUFFER.md
components/EXTRACTOR-CLIENT.md
components/CONSOLIDATOR.md
components/SAFETY.md
components/LANDING.md
components/REVIEW.md
components/LEDGER.md
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
apps/web/src/mock.ts
apps/server/src/app.groups.test.ts   # app.test.ts belongs to Person 1
components/FRONTEND-UI.md
SPEC.md
PLAN.md
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
each node receives only its transitive dependency outputs
planner-selected Agents execute their persisted mini-plans
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
- The proof beat runs from the landed-memory view: a fresh-thread solo run on
  the target Agent answers using the landed memory, and the same prompt on a
  withheld Agent cannot. See A5.

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

---

# Ownership Corrections

The original split left real work unassigned and double-assigned one file.

## Newly Assigned

```text
config.ts                     -> Person 1
  MEMORY_EXTRACTOR, MEMORY_EXTRACT_TIMEOUT_MS, REVIEW_ALL_SKILLS
  (referenced by the TDs, previously in nobody's file list)

codex-runner.ts --add-dir     -> Person 2  (A2)
agent lease seam              -> Person 1 defines, Person 2 calls  (A3)
freshThread flag              -> Person 1  (A5)

deleteAgent() cascade         -> Person 1
  currently purges runs/spans/messages only; must also handle
  groups, groupParticipants, notes, grants, landedMemoryFiles

cancel a running group task   -> Person 1 route, Person 2 impl, Person 4 UI
  CODEX_TIMEOUT_MS is 600s and the demo DAG has seven nodes

restart recovery for groups   -> Person 1/2
  initialize() resets stale runs and busy Agents but not
  GroupTask.status=running, group.activeTaskId, or unreleased runtimeLocks
```

## Deconflicted

```text
workspace.ts    Person 2 OWNS the file (shared code + group-task sections).
                Person 3 does NOT edit it. Memory file writes go in a new
                apps/server/src/memory/workspace-memory.ts that Person 3 owns.
                Both call the same replaceManagedBlock/removeManagedBlock
                helpers, which Person 2 lands first.

app.test.ts     Person 1 keeps app.test.ts for route validation.
                Person 4 adds app.groups.test.ts for the group/memory flows.
```

---

# Day-0 Checklist

```text
[ ] Renew ARK_API_KEY. The current .env key returns
    401 "The API key doesn't exist". It is gitignored and untracked, so this is
    an expiry, not a leak. Nothing can run end to end until it is replaced.

[ ] Do one real codex exec run that writes a file. The database currently holds
    one run and ZERO spans, so no one has yet exercised a Codex run that does
    file work. Every span-consuming component (TASK-BUFFER, the trace UI) is so
    far built against assumptions.

[ ] Confirm the A1 skill result on your own machine:
    codex app-server, initialize, then skills/list with a workspace cwd.

[ ] Agree the frozen GroupTaskResponse DTO. It is Person 4's only hard
    dependency and the most likely source of integration pain.

[ ] Lower CODEX_TIMEOUT_MS for demo builds. Seven nodes at 600s is 70 minutes
    of worst-case wall clock.
```

---

# Build Order

Dependency order across the component TDs. This prevents anyone starting in
the middle and building a module before its contracts exist.

This section governs **what may be built when**; the workstream sections above
govern **who builds it**. Where the two appear to differ, dependency order wins
on sequencing, the workstream sections win on ownership.

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

### Hard ordering constraint — WORKSPACE-EXTENSIONS blocks LANDING

`WORKSPACE-EXTENSIONS` (#2) must land its **managed-block-preserving
`writeInstructions()`** before `LANDING` (#10) writes any governed memory.

```text
Today writeInstructions() regenerates AGENTS.md from scratch
  (workspace.ts:38), and updateAgent() calls it on every Agent edit
  (agent-service.ts:129).

If LANDING runs first, editing an Agent silently WIPES the
  <!-- memory:<noteId> --> block, and the demo shows memory vanishing
  for no visible reason.
```

This crosses a person boundary: Person 2 owns `workspace.ts` and must land the
`replaceManagedBlock()` / `removeManagedBlock()` helpers before Person 3 builds
`LANDING` on top of them. Person 3 imports those helpers rather than
reimplementing them. See `WORKSPACE-EXTENSIONS.md`.

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
SPEC (Part 1)
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

## Testing Seams

Cross-cutting testing strategy. Per-component test lists live in each component
TD's own `## Tests` section.

- **Extractor behind an interface** → `FakeExtractorClient` feeds canned notes;
  no network in `npm run check`.
- **`safety.ts` is pure** → fixture-driven. A fake key must never survive into a
  landed file; prompt-injection shapes must quarantine.
- **`landing.ts` asserts on the filesystem** → file presence in the target Agent
  workspace and absence in every other. This is the security boundary, so test it
  directly rather than through a service return value.
- **A fake runner** is needed for group-runner tests. One exists today only as a
  local class inside `agent-service.test.ts`; Person 2 should extract it to a
  shared test helper rather than writing a second one.
- **Skill discovery** can be verified with no API key via
  `scripts/verify-codex-skills.sh` (the `codex app-server` `skills/list` RPC).
- **One optional live smoke test** against real Ark + real Codex, excluded from
  `npm run check`.
