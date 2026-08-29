# Implementation Direction

## Goal

Split the remaining implementation into four balanced workstreams for a
four-person team.

> ⚠️ **Read "Resolved Blockers (A1-A5)" and "Ownership Corrections" at the end of
> this file before starting.** They were added after a design review and they
> **supersede** anything above that contradicts them — most importantly the group
> membership contract (`memberAgentIds: string[]` is replaced by
> `members: [{agentId, role}]`, and the seven-node DAG is now STRETCH scope --
> v1 is a hardcoded sequential chain, see A4) and the file ownership of
> `workspace.ts` and `app.test.ts`.

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
+ hardcoded sequential chain (branch-and-join DAG is STRETCH - see A4)
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
<agent.workspacePath>/code  (A2: symlink for local-process,
                             bind-mount target dir for container)
```

Implement planner-written group-task sections in each selected Agent's private
`AGENTS.md`.

Implement the sequential chain (**v1 - see A4; the DAG below is STRETCH**):

```text
one GroupPlanNode per member, in member-list order
node[0].dependsOn = []
node[i].dependsOn = [node[i-1].id]
the last node is the single sink
```

```text
STRETCH - do not build until the sequential demo runs end to end:
  backend-contract -> frontend-plan / security-review -> join-plan
    -> backend-impl / frontend-impl -> final-join
  no duplicate Agent in one parallel phase
  no overlapping write paths
  no duplicate runtime locks
  join nodes depend on all branches they integrate
```

Implement execution (a plain `for` loop over the chain in v1):

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
apps/web/src/mock.ts
apps/server/src/app.groups.test.ts   # app.test.ts belongs to Person 1
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
branch context does not leak sibling output   (STRETCH - no branches in v1, see A4)
join owner receives branch outputs            (STRETCH - see A4)
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

# Resolved Blockers (A1-A5)

Design review found five cross-cutting items that were unowned or unverified.
All five are now closed. A1 and A2 were settled empirically against the pinned
runtime (`@openai/codex@0.111.0` inside `volc-agent-launchpad:local`); A3-A5 are
decisions recorded here. Read this section before starting your workstream.

## A1 - Skill Placement: VERIFIED WORKING

Method: `codex app-server` + `skills/list` RPC across three prepared workspaces.
No model call required, so anyone can re-run this check.

Results:

```text
<cwd>/.agents/skills/<name>/SKILL.md   -> discovered, scope "repo"   USE THIS
<cwd>/.codex/skills/<name>/SKILL.md    -> discovered, scope "repo"   also valid
$CODEX_HOME/skills/<name>/SKILL.md     -> discovered, scope "user"   GLOBAL - NEVER USE
empty workspace                        -> zero repo skills           no leakage
non-git-repo cwd                       -> repo skills still found    no git needed
```

Consequences:

```text
Placement-based security works as designed. Keep .agents/skills.
The "empty workspace cannot leak" demo beat is real and reproducible.
```

Hard rule for Person 3 (LandingService):

```text
Governed memory is NEVER written under $CODEX_HOME.
This deployment shares one codex-home volume across every Agent, so a skill
landed there is visible to all Agents and silently voids the security claim.
Add a startup assertion that $CODEX_HOME/skills contains no governed memory.
```

Residual check, folded into the first end-to-end run: `skills/list` proves
discovery, not that `codex exec` *fires* the skill. Verify once a valid API key
exists. Use explicit `$skill-name` invocation for the demo.

## A2 - Shared Code Writability: RESOLVED

**Both runtimes matter.** `npm run poc` runs `scripts/start-local-poc.sh`, which
exports `RUNTIME_PROVIDER=container`, so `ContainerCodexRunner` is the runner for
local dev and the demo. The committed `.env` says `local-process`, which is the
ECS/Compose deployment path. Solve both; the container path is the one you will
actually use day to day.

### Container runtime - use a nested bind mount, no symlink

`buildContainerRunArgs()` currently mounts only the Agent workspace and
`codex-home`. A `code -> ../shared-code/<taskId>` symlink therefore **dangles
inside the container** - verified: `cannot create code/y.txt: Directory
nonexistent`. Add one mount, nested inside the workspace mount:

```ts
// container-codex-runner.ts, buildContainerRunArgs()
"--mount", "type=bind,src=" + request.workspacePath + ",dst=/workspace",
...(request.sharedCodePath
  ? ["--mount", "type=bind,src=" + request.sharedCodePath + ",dst=/workspace/code"]
  : []),
"--mount", "type=bind,src=" + config.codexHome + ",dst=/codex-home",
```

Verified behaviour of this layout:

```text
./code inside the container is a REAL directory, not a symlink
reads and writes both work; writes land on the host
nothing leaks into the private Agent workspace
Docker creates the mountpoint if <workspace>/code does not exist
two Agents mounting the same shared-code concurrently is fine
```

The decisive advantage: `/workspace/code` is **inside** the cwd, so Codex's
`workspace-write` sandbox permits it natively and **no `--add-dir` is needed in
container mode.** One contiguous writable tree, no path-resolution footguns.

### Local-process runtime - symlink plus `--add-dir`

Bind mounts need root, so this path keeps the symlink. Here `./code` resolves
outside the cwd, so it does need `--add-dir` (present in 0.111.0 and accepted by
`codex exec`):

```ts
// types.ts
interface RunnerRequest {
  // ...existing fields
  sharedCodePath?: string;   // container: extra mount; local-process: --add-dir
}

// codex-runner.ts buildCodexArgs() - after the -C flag
if (request.sharedCodePath) args.push("--add-dir", request.sharedCodePath);
```

`WorkspaceManager.prepareSharedCode(agent, sharedCodePath)` branches once on
`config.runtimeProvider`: create the symlink for `local-process`, create an empty
mountpoint directory for `container`. That is the only place the two runtimes
differ. Solo runs pass no `sharedCodePath` and are unaffected.

### Also fix in container mode

`containerName()` is keyed by `agentId`, and `docker run --name` fails on a
duplicate. This is a second instance of the A3 collision: a solo run and a group
node for the same Agent will collide on the container name, not just on
`CodexRunner.active`. The A3 lease fixes both; do not add a second mechanism.

### Sandbox posture

Codex's Linux Landlock sandbox is unavailable on Docker Desktop for Mac (the
linuxkit kernel exposes landlock syscalls as unimplemented weak symbols;
`codex sandbox linux` fails with `Sandbox(LandlockRestrict)` even when
privileged). `docs/LOCAL_POC.md` already documents the degradation: startup warns
and disables the inner Codex sandbox while the outer container limits remain.

```text
The outer container is the real boundary: cap_drop ALL, no-new-privileges,
cpu/memory/pids limits, and a per-turn disposable container.
Do not claim OS-enforced per-Agent sandboxing. See ARCHITECTURE.md 10.6.
```

Minor known quirk: files written by the container come back to the host with
gid 0 rather than the host gid (Docker Desktop virtiofs). The uid matches, so
they stay host-writable. Not blocking.

## A3 - Agent Concurrency Lease: RESOLVED

Problem: `CodexRunner.active` is keyed by `agentId` and throws
`"Agent already has an active Codex process"` on a second concurrent run.
`cancel(agentId)` is agent-keyed too. Nothing in the group design set
`agent.status = "busy"`, so a solo message sent during a group task bypassed the
existing 409 guard and surfaced as a raw 500, and `stopAgent()` would kill a
running group node.

Decision: one shared lease, owned by `AgentService`, used by both paths.

Person 1 adds the seam:

```ts
interface AgentLease {
  acquireAgent(agentId: string, holder: AgentLeaseHolder): Promise<Agent>;
  releaseAgent(agentId: string, holder: AgentLeaseHolder): Promise<void>;
}

type AgentLeaseHolder =
  | { kind: "solo"; runId: string }
  | { kind: "group"; groupTaskId: string; planNodeId: string };
```

Rules:

```text
acquireAgent sets status busy inside one store.mutate() and throws 409 if held.
The existing sendMessage() busy check becomes a call to acquireAgent.
releaseAgent runs in a finally block on both paths.
stopAgent on a group-held Agent returns 409 naming the group task.
Cancelling a group task releases every lease it holds.
initialize() clears stale leases on restart, alongside the existing run reset.
```

Person 2 calls `acquireAgent`/`releaseAgent` in `runPlanNode()`. Person 2 does
not touch `CodexRunner.active` directly.

## A4 - Sequential v1 With A Fixed 5-Node Chain: RESOLVED

First, a contradiction that had to be settled before anyone codes.

```text
ARCHITECTURE.md section 9 : "Today that's a hardcoded sequential chain
                             (backend -> frontend -> security); later it can
                             be a dependency-graph (DAG) planner."

GROUPCHAT.md              : branch-and-join DAG as the FIRST demo
GROUP-RUNNER.md           : seven-node preseeded DAG, parallel-set validation
```

**Decision: ARCHITECTURE.md wins. v1 is a hardcoded sequential chain.**
Branch-and-join is stretch scope, built only if the sequential demo ships first.

### The v1 chain

A fixed five-node template. Backend and Frontend each take two turns, so the
demo still tells the plan-then-implement story:

```text
1  backend-contract   Backend    propose endpoint contract and storage flow
2  frontend-plan      Frontend   plan UI/API integration from that contract
3  security-review    Security   review auth, validation, secret boundaries
4  backend-impl       Backend    implement backend changes under code/apps/server
5  frontend-impl      Frontend   implement frontend changes under code/apps/web
```

Built as a degenerate DAG so the data model and the whole downstream pipeline
are unchanged:

```text
node[0].dependsOn = []
node[i].dependsOn = [node[i-1].id]
node[4] is the single sink
```

`decideFlush()` in `FLUSH-TRIGGER.md` already handles this and needs no edit.
TASK-BUFFER's topological sort over a chain is just the chain. Upgrading to a
real DAG later is a **planner** change, not a pipeline change - which is exactly
the claim ARCHITECTURE.md section 9 makes.

### Membership contract - role-bound

The template references **roles**, never Agent names or list order, so any three
Agents can play the demo:

```ts
type GroupRole = "backend" | "frontend" | "security";

interface GroupMemberInput {
  agentId: string;
  role: GroupRole;
}

interface CreateGroupInput {
  name: string;
  description?: string;
  members: GroupMemberInput[];   // replaces memberAgentIds: string[]
}
```

```ts
const createGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  members: z.array(z.object({
    agentId: z.string().uuid(),
    role: z.enum(["backend", "frontend", "security"]),
  })).length(3),
});
```

Rules:

```text
Exactly three members, one per role, each Agent used once.
Chain nodes bind to role, so node 1 and node 4 both resolve to the backend member.
role feeds GroupParticipantState.role and the per-turn identity prompt.
startGroupTask rejects a group missing a role with 409:
  "This plan needs one backend, one frontend, and one security member."
```

Person 4's group modal: Agent toggles plus a role selector per selected Agent,
submit blocked until all three roles are filled exactly once. Render the
resulting chain above the composer so the order is never a surprise.

### Interaction with A3

An Agent taking two turns is safe under the A3 lease **without re-entrancy**,
because the chain is sequential: node 1 acquires and releases the backend lease,
then node 4 acquires it again later. There is never an overlap. Do not build a
re-entrant lease.

### Scope split

```text
V1 - BUILD NOW
  the five-node chain above, executed by a plain for-loop
  GroupRuntimeLock ROWS written per node (see below)
  membershipEpoch / removedAt / fresh groupThreadId on re-add
  context injection records with injectedMessageIds / withheldMessageIds
  lastSeenSeq dedupe - it does real work here, since Backend runs twice

STRETCH - only after the sequential demo runs end to end
  branch and join nodes, join-owner selection rule
  parallel-set validation (no Agent twice in a phase, no write-path overlap)
  runtime-lock COLLISION VALIDATION
  Promise.all over runnable node sets
```

Two notes on what was kept:

```text
Runtime locks: keep writing GroupRuntimeLock rows per node. A node declaring it
held code/apps/server/** is legible evidence in the UI. Skip only the collision
validation, which cannot fire while one node runs at a time.

Context injections: keep the records and the lastSeenSeq logic. But in a chain,
"withheld" means ALREADY SEEN, not DENIED BY POLICY. Label it that way in the UI
and in the demo script. Calling dedupe "governance" would misrepresent the
system on stage.
```

> Demo narrative note: the "branch context does not leak sibling output" beat
> **does not exist in a sequential chain** - there are no siblings. Do not
> promise it. The v1 governance story is the memory grant/denial pair (A5),
> which is the actual contribution and does not depend on the DAG at all.

## A5 - The Proof Beat: RESOLVED

Problem: the demo's payoff is "memory landed, and a later run uses it", but a
resumed Codex thread may not re-read a changed `AGENTS.md` (see `GROUPCHAT.md`
and ARCHITECTURE.md section 10.2). No workstream owned this, so the demo had no
verified closing beat.

Decision: the proof run is a **fresh-thread solo run** against the target Agent.

Person 1 adds one optional field to the existing solo message route:

```ts
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  freshThread: z.boolean().default(false),
});
```

`AgentService.sendMessage()` passes `threadId: null` when `freshThread` is true,
so Codex starts a new thread and reads `AGENTS.md` plus `.agents/skills` from
disk. Nothing else changes; `Agent.codexThreadId` is still updated from the
result.

Person 4 builds the beat as two clicks from the landed-memory view:

```text
positive: fresh-thread run on the TARGET Agent
          prompt invokes the skill explicitly by $skill-name
          Agent answers using the landed memory

negative: same prompt, same moment, on a WITHHELD Agent
          that workspace has no such file
          Agent cannot answer, and the ledger says why it was withheld
```

Run both beats back to back. That pair is the whole contribution in fifteen
seconds: a grant, a denial, and a named reason.

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

## Corrections To Component TDs

```text
CONSOLIDATOR.md
  Do not ask the extractor to echo UUIDs. z.string().uuid() on sourceSpanIds
  will reject nearly every real response. Give the extractor short integer
  indices into TaskBuffer.entries and map back to run/span IDs server-side.

SAFETY.md
  generic_api_key /\b[A-Za-z0-9_-]{32,}\b/g matches every UUID, including the
  agent, run, and span IDs a note legitimately cites. env_assignment matches
  ordinary prose like "MAX_SIZE = 10MB". As written, redactionFired trips on
  almost every note and everything routes to review. Either narrow the patterns
  or make this behaviour a deliberate, documented demo choice.

API-ROUTES.md
  Drop /timeline and /context-injections. GroupTaskResponse already carries
  messages and contextInjections; three polling endpoints is drift waiting to
  happen.

FRONTEND-UI.md
  api.ts request() takes a pre-stringified body. Every snippet in that TD passes
  a raw object, which would POST "[object Object]". Fix request() to stringify
  objects once, then the snippets are correct.

LEDGER.md / FRONTEND-UI.md
  Notes and grants carry only UUIDs. Resolve Agent and group names into the
  response DTOs, or the ledger view is an unreadable wall of hex on stage.
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
