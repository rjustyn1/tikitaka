# Group Chat Mechanism

> ⚠️ **SCOPE BANNER - read before building from this document.**
>
> This is the full design, including the branch-and-join DAG. **V1 is a
> hardcoded five-node SEQUENTIAL chain** (see A4 in
> `DECISIONS.md`). Treat as **STRETCH**, and do not build yet:
>
> ```text
> branch nodes, join nodes, join-owner selection
> parallel phases and parallel-set validation
> runtime-lock COLLISION VALIDATION (lock RECORDS are still v1)
> contextSnapshotSeq / allowedPlanNodeIds sibling-leak prevention
>   (keep the fields and the lastSeenSeq dedupe - both are v1)
> ```
>
> Two corrections to this document that are **not** optional:
>
> ```text
> AgentGroup.memberAgentIds is replaced by members: [{agentId, role}] (A4)
> the ./code symlink is LOCAL-PROCESS ONLY. Container runtime uses a nested
>   bind mount at /workspace/code - a symlink is BROKEN there (A2, verified)
> ```

> Locked rough design.
> This document keeps one direction only: app-owned group chat, private Agent
> roots, shared group code, separate Codex group threads per Agent, and a
> branch-and-join DAG.

---

## Goal

Allow a user to create a group containing selected Agents, send one prompt-like
task to that group, and see the Agents collaborate in a shared chat while
working on one shared code artifact.

Example:

```text
User creates:
  Agent A - Backend
  Agent B - Frontend
  Agent C - Security

User creates:
  Group "Upload Feature Team" with A, B, C

User sends:
  "Plan and implement an upload feature."

Group chat:
  User: Plan and implement an upload feature.
  Backend Agent: I will define POST /uploads and the storage flow.
  Frontend Agent: I will build the upload UI against that public contract.
  Security Agent: I will review validation, auth, and secret boundaries.
  Backend Agent: Here is the consolidated implementation result.
```

The group chat should feel like one shared conversation to the user, but it
should not be implemented as one shared Codex thread.

Groups must not automatically include all existing Agents. The user chooses
which Agents join the group.

---

## Core Decision

Use an app-level shared group chat, private Agent workspace roots, one shared
group code directory, and separate Codex execution contexts per Agent.

```text
App database:
  one shared group chat timeline

Workspaces:
  each Agent keeps a private root for AGENTS.md, skills, and memory
  the group task creates one shared code directory mounted or linked as ./code

Codex:
  Agent A has its own group thread
  Agent B has its own group thread
  Agent C has its own group thread
```

This avoids a major identity problem. If all Agents resume the same Codex
thread, the first Agent's instructions and session framing can dominate the
whole conversation. A Backend Agent, Frontend Agent, and Security Agent should
not all become roleplay inside one Backend-flavored thread.

The group chat is shared because our app stores and replays the transcript. The
code is shared because the Agents are building the same artifact. Agent memory
stays private because each Agent still runs from its own workspace root. The
Codex thread is not shared.

The orchestration model is a branch-and-join DAG. For demo feasibility, the
first planner result can be preseeded or template-generated, but the runner
should still execute real DAG nodes, real Agent turns, and real transcript
sync.

---

## Mental Model

There are four layers:

```text
Shared group chat history
  - stored by our app
  - visible to the user
  - labelled by speaker
  - used to build each Agent's turn prompt

Shared group code directory
  - the actual project files for this group task
  - edited through ./code from each selected Agent's private root
  - contains code only, not governed memory files

Private Agent workspace root
  - contains that Agent's AGENTS.md
  - contains that Agent's .agents/skills
  - is the Codex cwd for that Agent's runs
  - is the memory placement boundary

Private Agent execution history
  - stored by Codex
  - resumed through that Agent's thread ID
  - not shared directly with other Agents
```

So the collaboration is real, but the sharedness is deliberate: chat is shared
by the app, code is shared through `./code`, and memory remains private by file
placement.

---

## Why Not One Shared Codex Thread

Do not implement group chat like this:

```text
Backend Agent starts thread G
Frontend Agent resumes thread G
Security Agent resumes thread G
```

Problems:

- The first Agent's `AGENTS.md` and identity may become the permanent framing.
- Later Agents may not receive their own real workspace instructions.
- The accumulated group transcript can cause context and cost blowup.
- Concurrent resumes of the same thread can create race or corruption risk.
- Revocation or selective withholding becomes weak once information is already
  inside the shared thread.

The correct model is:

```text
Group chat timeline is shared by the app.
Group code directory is shared by the Agents.
Agent workspace roots stay private.
Codex threads stay separate per Agent.
The app decides what each Agent sees each turn.
```

---

## Thread Model

Model:

```text
Agent solo thread:
  used when the user talks to Agent A directly

Agent group thread:
  used when Agent A participates in Group X
```

This gives us:

- private solo continuity for each Agent;
- separate group continuity for each Agent inside a group;
- less accidental leakage from group work into solo work;
- a clean place for memory middleware to decide what should carry over later.

Example:

```text
Backend Agent:
  soloThreadId
  groupThreadIds["Upload Feature Team"]

Frontend Agent:
  soloThreadId
  groupThreadIds["Upload Feature Team"]

Security Agent:
  soloThreadId
  groupThreadIds["Upload Feature Team"]
```

---

## Incremental Transcript Sync

The group chat should not paste the full conversation from the beginning on
every turn.

Each Agent has a cursor that records the latest group message it has already
seen.

That cursor is useful, but it is not the whole context rule once branches exist.
`lastSeenSeq` prevents duplicate transcript injection. The DAG decides which
messages and dependency outputs are allowed for the current node.

```text
Group messages:
  seq 1 - User: Plan upload feature
  seq 2 - Backend Agent: Use POST /uploads
  seq 3 - Frontend Agent: I need request/response schema
  seq 4 - Security Agent: Do not expose backend secrets

Backend Agent lastSeenSeq = 1
Frontend Agent lastSeenSeq = 2
Security Agent lastSeenSeq = 3
```

When it is Backend Agent's turn again, the app only sends messages after
`lastSeenSeq`.

```text
New messages for Backend Agent:
  seq 2 - Backend Agent: Use POST /uploads
  seq 3 - Frontend Agent: I need request/response schema
  seq 4 - Security Agent: Do not expose backend secrets
```

After Backend Agent runs, update:

```text
Backend Agent lastSeenSeq = 4
```

This works because Backend Agent's own Codex group thread already contains what
it saw on previous turns. The app only needs to send the delta.

Benefits:

- lower prompt size;
- less duplicated transcript;
- clearer audit of which Agent saw which messages;
- no need for one shared Codex thread;
- easier future memory governance.

---

## Branch-Aware Context

`lastSeenSeq` alone is not enough for branches.

Example problem:

```text
seq 1 - User asks for upload feature
seq 2 - Backend writes API contract

Branch starts from seq 2:
  Frontend node depends on Backend
  Security node depends on Backend

Frontend finishes first:
seq 3 - Frontend output

Security starts later.
```

If Security receives every message where `seq > lastSeenSeq`, it may see
Frontend's branch output even though the DAG did not declare Frontend as a
dependency. That makes branch behavior depend on wall-clock timing, not the
plan.

The chosen rule:

```text
lastSeenSeq = dedupe helper
DAG context packet = source of truth
```

Each runnable node gets a context packet:

```text
contextSnapshotSeq:
  transcript upper bound captured when this branch/phase becomes runnable

allowedPlanNodeIds:
  completed ancestor or dependency nodes this node may use

injectedMessageIds:
  exact group messages injected into this run

injectedDependencyNodeIds:
  exact dependency outputs injected into this run
```

For branch nodes, the app sends:

```text
messages since the Agent's last seen point
AND messages at or before contextSnapshotSeq
AND messages from allowed ancestor/shared nodes
```

For join nodes, the app sends:

```text
the completed dependency outputs from all joined branches
plus the relevant transcript delta
```

After a join completes, the join output becomes the next shared checkpoint. The
next phase should continue from that checkpoint instead of blindly replaying
every raw sibling branch message to every Agent.

This keeps branches deterministic:

- branch Agents start from the same shared state;
- sibling branch outputs are not leaked just because one branch finished first;
- join nodes intentionally receive all dependency outputs;
- later phases continue from the joined state.

---

## Turn Execution Flow

For each runnable DAG node:

```text
1. Select the Agent assigned to the node.
2. Load that Agent's group participant state.
3. Build a DAG-aware context packet for the node.
4. Fetch completed dependency outputs for this node.
5. Redact dependency outputs before injection.
6. Build a group-turn prompt.
7. Acquire the node's file/runtime locks.
8. Run Codex using that Agent's own group thread.
9. Save the Agent output as a new group message.
10. Save node output and run trace.
11. Update that Agent's lastSeenSeq.
12. Release the node's file/runtime locks.
13. Mark the node completed, failed, or cancelled.
14. Unlock dependent nodes whose dependencies are complete.
```

The prompt should contain:

```text
[Group task]
<original user task or current task summary>

[DAG node]
Node: <node id>
Role: <node role>
Depends on: <completed dependency node ids>
File ownership: <paths or read-only>
Runtime locks: <exclusive shared resources or none>

[New group messages since your last turn]
<speaker-labelled messages>

[Relevant dependency outputs]
<redacted summaries from dependency nodes>

[Your identity for this turn]
You are <Agent name>.
Role: <group role or agent description>.
Instructions: <short role instructions>.

[Your turn]
Complete this DAG node from your role. Respect file ownership and preserve
other Agents' work.
```

Example:

```text
[Group task]
Plan an upload feature.

[DAG node]
Node: frontend-plan
Role: frontend planning
Depends on: backend-contract
File ownership: read-only planning
Runtime locks: none

[New group messages since your last turn]
Backend Agent:
I propose POST /uploads returning fileId and url.

[Your identity for this turn]
You are Frontend Agent.
Role: frontend implementation and integration.

[Your turn]
Respond as Frontend Agent. Ask for any public API details you need.
```

---

## Group Membership UI

Agents can already be created directly in the current app, so group creation
needs an explicit membership step.

When creating or editing a group, show the existing Agents as a selectable list:

```text
Create Group

Name: Upload Feature Team

Agents:
  [x] Backend Agent
  [x] Frontend Agent
  [x] Security Agent
  [ ] Ops Agent
  [ ] Data Agent
```

Expected behavior:

- new groups start with no members selected, unless the user selected Agents
  before opening the modal;
- the user toggles Agents on or off;
- only selected Agents become group members;
- non-member Agents cannot receive group transcript deltas;
- non-member Agents should appear as `out_of_group` for later memory-governance
  checks;
- editing a group can add or remove Agents before a task starts;
- membership is frozen once a group task starts;
- removing an Agent between tasks should stop future group turns for that Agent,
  but should not delete old timeline messages it already produced;
- re-adding an Agent creates a new membership epoch and a fresh
  `groupThreadId` for future group turns.

This matters because membership is a governance boundary. If the app silently
adds every Agent to every group, then `out_of_group` denial becomes meaningless.

For the demo flow, no Agent is removed or re-added during the group task. This
keeps the thread story clean: each selected Agent has exactly one active
group-scoped thread for the task.

---

## Branch-And-Join DAG

The group chat needs a rule for who speaks next. That rule is a branch-and-join
DAG.

The first demo uses a preseeded/template-generated DAG result. That is not
a separate product direction. The planner result is mocked, but the group runner
still executes the same real mechanism: DAG nodes, dependency edges, transcript
deltas, Agent runs, shared code writes, and final consolidation.

```text
                    -> Frontend Agent -
Backend Agent setup                    -> planner-selected join owner
                    -> Security Agent -
```

The planner can branch when a task naturally has independent subproblems, then
join again into one consolidation node before continuing. The end of each major
phase is a single joined state.

Example:

```text
User task:
  "Plan and implement an upload feature."

Phase 1 - shared setup
  Backend Agent:
    propose endpoint contract and storage flow

Phase 2 - branch
  Frontend Agent:
    plan UI/API integration from the endpoint contract

  Security Agent:
    review auth, validation, and secret-sharing boundaries

Phase 3 - join
  Planner-selected join owner:
    merge frontend and security feedback into one implementation plan

Phase 4 - branch again if needed
  Backend Agent:
    implement backend changes

  Frontend Agent:
    implement frontend changes

Phase 5 - final join
  Planner-selected join owner:
    consolidate final result and summarize next steps
```

The rule of thumb:

```text
branch only when there are independent workstreams;
join after each major phase so the group returns to one shared state;
continue from the joined result;
repeat if the task needs another split.
```

Each DAG node declares:

```text
agentId
node kind: work or join
role for this node
dependsOn
readOnly or writeAllowed
file ownership hints
expected output
```

Before a phase starts, the planner validates the runnable sibling set:

```text
No selected Agent appears in more than one parallel node.
No two parallel write nodes own the same file area.
No two parallel nodes hold the same exclusive runtime lock.
Every join node depends on every sibling branch it must integrate.
```

If the same Agent would be assigned to two sibling branches, the planner must
serialize those nodes with an explicit dependency or collapse them into one
node. It must not rely on the Codex runner to quietly block one run behind the
other.

Demo-safe parallel sets:

```text
Phase 2:
  Frontend Agent + Security Agent

Phase 4:
  Backend Agent + Frontend Agent
```

In both phases, each parallel node uses a distinct Agent. The join node starts
only after all sibling branches in that phase complete.

Join nodes are not a hidden fourth Agent. A join node is a normal DAG node
assigned to one of the selected group members. The assigned Agent keeps its
stable identity, but receives a temporary node role such as "consolidation
owner" or "final reviewer" in the turn prompt.

The DAG planner chooses the join owner from the selected group members. It
should prefer the Agent most related to the current phase or artifact being
consolidated.

Join owner selection rule:

```text
1. Prefer the Agent that owns the central artifact for this phase.
2. Prefer the Agent that created the shared contract the branches depend on.
3. Prefer the Agent whose role is closest to the final requested outcome.
4. Use group order only as a deterministic tie-breaker.
```

For the three-Agent upload demo, Backend Agent can be selected as the join owner
because it creates the initial API contract and can reconcile the implementation
plan from the Frontend and Security outputs. For a visual redesign task,
Frontend Agent would likely be the join owner. For a risk review task, Security
Agent would likely be the join owner.

Example join identity:

```text
[Your identity for this turn]
You are Backend Agent.
Stable role: backend implementation.
Node role: consolidation owner.

[Your turn]
Merge the completed Frontend and Security dependency outputs into one shared
implementation plan. Stay within your Backend Agent identity and do not pretend
to be a new fourth Agent.
```

The contribution is not an advanced planner. The contribution is controlled
shared context, Agent identity preservation, shared code coordination, and later
memory governance.

---

## Workspace Model

All selected Agents keep private workspace roots, but edit one shared group code
directory.

```text
workspaces/
  shared-code/<groupTaskId>/
    apps/server/**
    apps/web/**

  backend-agent/
    AGENTS.md
    .agents/skills/
    code -> ../shared-code/<groupTaskId>

  frontend-agent/
    AGENTS.md
    .agents/skills/
    code -> ../shared-code/<groupTaskId>

  security-agent/
    AGENTS.md
    .agents/skills/
    code -> ../shared-code/<groupTaskId>
```

Codex still runs with cwd set to the Agent's private root. The Agent edits the
shared project under `./code`.

This is the chosen model because it matches `ARCHITECTURE.md`: memory security stays
based on file placement into each Agent's private workspace, while the group
still collaborates on one code artifact.

Runtime note:

```text
local-process runtime:
  ./code can be a symlink from each private Agent root to shared-code/<taskId>

container runtime:
  ./code must be visible inside the container mount
  either mount shared-code/<taskId> explicitly, or place shared-code under a
  parent directory that is mounted into the container
```

Do not rely on a symlink that points outside the mounted Agent root in container
mode, because the container may see a broken path.

What gets easier:

- Backend can create API files and Frontend can inspect them later.
- Frontend can add UI files and Security can review the same files.
- The final artifact exists in one place.
- The demo is easier to understand: one group, one task, one shared codebase.
- Memory grants and denials remain inspectable per Agent workspace.

What must be controlled:

- Two Agents must not write the same file at the same time.
- A failed branch can leave partial files for later branches.
- One Agent can accidentally overwrite another Agent's work.
- `AGENTS.md` and `.agents/skills` must stay in the private Agent roots, not in
  shared code.
- Secrets and dependency outputs need redaction before entering other Agents'
  threads.
- Once an Agent sees a transcript delta in its Codex group thread, that context
  may persist in that Agent's group thread.

The DAG planner helps with code conflicts, but it does not remove the need for
shared-code discipline. Parallel branches are safe only when their file
ownership is separated.

Example safe branch:

```text
Backend Agent:
  owns code/apps/server/**

Frontend Agent:
  owns code/apps/web/**

Security Agent:
  read-only review during the branch
```

Example unsafe branch:

```text
Backend Agent and Frontend Agent both edit code/package.json at the same time.
```

Conflict rule:

```text
Each DAG node declares file ownership hints.
Parallel nodes should not target the same file area.
Join nodes reconcile and review after branches finish.
```

This can stay simple. We do not need a full merge engine for the first version.
We only need deterministic planning that avoids obvious overlap.

### Runtime Locks

Parallel branches share more than files. Two Codex processes in the same
workspace can also collide on build-tool state, package-manager state, git
state, cache directories, and ports.

The planner must treat these as exclusive runtime locks:

```text
package-manager:
  package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, node_modules/**

git:
  .git/index.lock and other git write operations

dev-server:
  local ports used by npm/vite/api servers

test-cache:
  shared coverage, build, and cache directories

env:
  .env and generated local config files
```

Demo-safe rule:

```text
Parallel branch nodes do not run package installs.
Parallel branch nodes do not start long-lived dev servers.
Parallel branch nodes do not run git write operations.
Parallel branch nodes do not edit .env or lockfiles.
Setup, dependency installation, final test runs, and dev-server checks happen in
single-owner setup or join nodes.
```

This keeps the shared code model realistic without letting unrelated runtime
collisions break the parallel branch demo.

### Planner-Written AGENTS.md

The DAG planner can create or update a group-task section inside each selected
Agent's private `AGENTS.md` before the group task starts. This is useful because
each Agent gets the same group charter while memory placement remains private.

It should include:

```text
Group task summary
Selected group members
General role of each Agent
Current file ownership map
Shared engineering constraints
Conflict and preservation rules
Secret-handling rules
```

Example:

```text
This Agent is participating in the Upload Feature Team group task.

Shared code lives under ./code.

Members:
  Backend Agent - owns backend API and storage changes.
  Frontend Agent - owns user-facing upload UI changes.
  Security Agent - reviews auth, validation, and secret boundaries.

Rules:
  Follow the active Agent identity supplied in the turn prompt.
  Respect the DAG node's file ownership hints.
  Preserve other Agents' work.
  Do not expose secrets across Agent boundaries.
```

The planner should write this charter into each selected Agent's private
workspace root:

```text
backend-agent/AGENTS.md
frontend-agent/AGENTS.md
security-agent/AGENTS.md
```

The planner should not write governed memory into:

```text
shared-code/<groupTaskId>/AGENTS.md
shared-code/<groupTaskId>/.agents/skills/
```

The planner-written section should not replace stable identity with a different
Agent identity. For example, Backend Agent's private `AGENTS.md` should not say:

```text
You are Frontend Agent.
```

That would corrupt the Agent identity. The file should preserve the stable
Agent identity, then add the group contract. The active DAG node role still
belongs in the per-turn prompt.

One important runtime detail: if `AGENTS.md` changes after an Agent's group
thread already exists, do not assume the resumed Codex thread will receive the
new file as fresh system context. The app should still inject the current role,
DAG node, file ownership, and relevant group charter details in the per-turn
prompt.

### Per-Turn Identity

Using private Agent roots with shared `./code` is acceptable, as long as the
active DAG node role is injected per turn.

The design should be:

```text
private Agent root as cwd
shared code directory at ./code
different groupThreadId per Agent per group
per-turn identity prompt
planner-written group-task section in private AGENTS.md
```

Each run prompt supplies the active identity:

```text
[Your identity for this turn]
You are Backend Agent.
Role: backend implementation.
You own code/apps/server/** for this turn.
```

This avoids the shared-thread identity problem. Each Agent has its own Codex
group thread, so Backend's session framing does not become Frontend's session
framing. The shared code directory only shares project files, not Codex
conversation state or governed memory files.

---

## Data Concepts

Rough data shape:

```ts
interface AgentGroup {
  id: string;
  name: string;
  description: string;
  members: GroupMember[];   // A4: {agentId, role}, replaces memberAgentIds
  createdAt: string;
  updatedAt: string;
}

interface GroupMessage {
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

interface GroupParticipantState {
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

type GroupTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

interface GroupTask {
  id: string;
  groupId: string;
  prompt: string;
  sharedCodePath: string;
  status: GroupTaskStatus;
  currentNodeId: string | null;
  nodeRunIds: string[];
  createdAt: string;
  completedAt: string | null;
}

type GroupPlanNodeKind = "work" | "join";

interface GroupPlanNode {
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
  readOnly: boolean;
  fileOwnershipHints: string[];
  runtimeLocks: string[];
  expectedOutput: string;
}

interface GroupRuntimeLock {
  id: string;
  groupTaskId: string;
  lockKey: string;
  holderPlanNodeId: string;
  acquiredAt: string;
  releasedAt: string | null;
}

interface GroupContextInjection {
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
```

This can be simplified during implementation. The most important fields are:

- `GroupMessage.seq`
- `GroupParticipantState.groupThreadId`
- `GroupParticipantState.lastSeenSeq`
- `GroupParticipantState.membershipEpoch`
- `GroupParticipantState.removedAt`
- `GroupParticipantState.agentWorkspacePath`
- `GroupTask.sharedCodePath`
- `GroupPlanNode.kind`
- `GroupPlanNode.nodeRole`
- `GroupPlanNode.dependsOn`
- `GroupPlanNode.contextSnapshotSeq`
- `GroupPlanNode.allowedPlanNodeIds`
- `GroupPlanNode.fileOwnershipHints`
- `GroupPlanNode.runtimeLocks`
- `GroupRuntimeLock.lockKey`
- `GroupContextInjection.injectedMessageIds`
- `GroupContextInjection.injectedDependencyNodeIds`
- speaker-labelled message content

---

## Relationship To Memory Middleware

Group chat solves immediate collaboration:

```text
What should each Agent see during this shared task?
```

Memory middleware solves carryover:

```text
What should survive after the shared task, and who may receive it later?
```

They should be separate.

```text
Group chat:
  passes recent transcript deltas between Agents

Memory middleware:
  extracts durable memories from completed group work
  scopes them to Agents/groups
  injects them into future solo or group runs
```

This separation matters because not every group message deserves to become
memory. Some messages are temporary coordination. Some are useful future
constraints. Some are private or risky and should not leave the group.

The memory middleware should not rewrite an Agent's role. It should only save
knowledge that is relevant to that Agent or to an authorized future task.

Example:

```text
Backend Agent should remember:
  Frontend does not need backend secrets.
  Upload API contracts should expose public fields only.

Backend Agent should not remember:
  Frontend-specific styling preferences unrelated to backend work.
  Random group chatter.
```

This keeps each Agent on track. A Backend Agent can learn better backend
collaboration habits from group work, but it does not become a Frontend Agent.

---

## Demo Flow

Demo path:

```text
1. Create Backend, Frontend, and Security Agents.
2. Create Upload Feature Team group by toggling those three Agents on.
3. Send group task: "Plan an upload feature."
4. The app creates one shared code directory and links or mounts it as `./code`
   inside each selected Agent's private workspace root.
5. The app creates a branch-and-join DAG for the task.
6. The app validates the DAG before launch:
   distinct Agents per parallel phase, non-overlapping write paths, and no
   duplicate runtime locks.
7. Backend runs the setup node and writes the API contract.
8. Frontend and Security run branch nodes from Backend's output.
9. The planner-selected join owner merges their outputs into one shared plan.
10. Backend and Frontend run implementation nodes with non-overlapping file
   ownership hints and no shared runtime locks.
11. The planner-selected join owner runs the final join, including final tests
   or dev-server checks if needed.
12. The UI shows one group timeline with speaker labels.
13. The trace shows each Agent's transcript delta, groupThreadId, DAG node, file
   ownership hints, runtime locks, and withheld branch messages.
14. Memory review shows which group learnings are proposed for carryover.
```

What this proves:

- multiple real Agents participate in one task;
- selected membership controls who can participate;
- Agents do not share one Codex thread;
- the group chat history is shared through the app;
- each Agent receives only the transcript delta it has not seen;
- Agents work against one shared code artifact while memory stays private;
- branch-and-join orchestration controls parallelism and integration;
- the planner prevents duplicate Agents inside the same parallel phase;
- runtime locks prevent non-file collisions during parallel work;
- memory governance can promote relevant group learnings after the task.

---

## Locked Decisions

The group chat idea now has these fixed choices:

```text
membership: explicit Agent toggles, frozen while a task is running
re-add policy: new membership epoch and fresh groupThreadId
workspace: private Agent roots plus shared group code directory
threading: separate groupThreadId per Agent per group
transcript: app-owned group timeline
history injection: branch-aware context packet, with lastSeenSeq as dedupe only
orchestration: branch-and-join DAG
demo planner: preseeded/template-generated DAG result
join ownership: planner assigns join nodes to the most relevant selected Agent
identity: planner-written per-Agent AGENTS.md task section plus per-turn identity prompt
parallel safety: distinct Agents, non-overlapping file ownership hints, and no duplicate runtime locks
termination: final join node completes the group task
memory: reviewed carryover after task completion
```

---

## First Version Boundary

The first version does not need:

- free-form autonomous planning;
- manual speaker selection;
- shared Codex threads;
- automatic merge conflict resolution;
- unlimited transcript replay from the beginning;
- automatic memory writes without review.

---

## One-Sentence Summary

Group chat is a selected set of Agents working on one shared code directory
through private Agent roots and separate group-scoped Codex threads, coordinated
by an app-owned transcript and a branch-and-join DAG that controls who sees
what, who writes where, and what knowledge can become memory afterward.
