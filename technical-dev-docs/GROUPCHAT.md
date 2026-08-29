# Group Chat Mechanism

> Rough idea consolidation.
> This document is about how multiple Agents can talk to each other on one
> shared task. The memory-governance layer can be added on top later.

---

## Goal

Allow a user to create a group containing multiple Agents, send one prompt-like
task to that group, and see the Agents collaborate in a shared chat.

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
  Backend Agent: I propose POST /uploads...
  Frontend Agent: I only need the public API contract...
  Security Agent: Do not expose backend secrets...
```

The group chat should feel like one shared conversation to the user, but it
should not be implemented as one shared Codex thread.

Groups must not automatically include all existing Agents. The user chooses
which Agents join the group.

---

## Core Decision

Use an app-level shared group chat, with separate Codex execution contexts per
Agent.

```text
App database:
  one shared group chat timeline

Codex:
  Agent A has its own thread
  Agent B has its own thread
  Agent C has its own thread
```

This avoids a major identity problem. If all Agents resume the same Codex
thread, the first Agent's instructions and session framing can dominate the
whole conversation. A Backend Agent, Frontend Agent, and Security Agent should
not all become roleplay inside one Backend-flavoured thread.

The group chat is shared because our app stores and replays the transcript. The
Codex thread is not shared.

---

## Mental Model

There are two layers:

```text
Shared group chat history
  - stored by our app
  - visible to the user
  - labelled by speaker
  - used to build each Agent's turn prompt

Private Agent execution history
  - stored by Codex
  - resumed through that Agent's thread ID
  - not shared directly with other Agents
```

So the group chat is real, but the sharedness is controlled by the app.

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

Instead:

```text
Group chat timeline is shared.
Codex threads stay separate.
The app decides what each Agent sees on each turn.
```

---

## Thread Model

Recommended model:

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

MVP simplification:

- If separate group-scoped thread IDs are too much for the first build, use the
  existing per-Agent `codexThreadId`.
- But the final design should acknowledge that solo and group contexts are
  different.

---

## Incremental Transcript Sync

The group chat should not paste the full conversation from the beginning on
every turn.

Each Agent has a cursor that records the latest group message it has already
seen.

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

## Turn Execution Flow

For each group turn:

```text
1. Select current Agent.
2. Load that Agent's group participant state.
3. Fetch group messages where seq > lastSeenSeq.
4. Build a group-turn prompt.
5. Run Codex using that Agent's own group thread.
6. Save the Agent output as a new group message.
7. Update that Agent's lastSeenSeq.
8. Repeat for the next Agent.
```

The prompt should contain:

```text
[Group task]
<original user task or current task summary>

[New group messages since your last turn]
<speaker-labelled messages>

[Your identity for this turn]
You are <Agent name>.
Role: <group role or agent description>.
Instructions: <short role instructions>.

[Your turn]
Continue the group task from your role.
```

Example:

```text
[Group task]
Plan an upload feature.

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
- removing an Agent from a group should stop future group turns for that Agent,
  but should not delete old timeline messages it already produced.

This matters because membership is a governance boundary. If the app silently
adds every Agent to every group, then `out_of_group` denial becomes meaningless.

---

## Orchestration Options

The group chat needs a rule for who speaks next.

### Option 1 - Sequential Turn Order

```text
Backend -> Frontend -> Security
```

This is the recommended MVP.

Pros:

- easy to build;
- deterministic;
- demo-friendly;
- enough to prove Agents can talk through a shared transcript.

Cons:

- order matters;
- earlier Agents do not see later messages until their next turn.

### Option 2 - Simple DAG

```text
Backend
  -> Frontend
  -> Security
```

This is still simple, but lets the group runner express dependencies.

Use this if we want a cleaner architecture story without building a dynamic
planner.

### Option 3 - Coordinator Agent

```text
Coordinator decides:
  who should act next
  what each Agent should do
  when the task is finished
```

This is more flexible, but it is also less deterministic and should not be the
MVP unless everything else is already stable.

### Recommended Choice

Start with a deterministic sequence or tiny DAG. The contribution is not the
planner. The contribution is controlled shared context and later memory
governance.

---

## Workspace Model

There are two possible workspace models.

### Option A - Per-Agent Workspaces

Each Agent keeps its own workspace.

```text
Backend workspace
Frontend workspace
Security workspace
Shared group transcript
```

Pros:

- safest;
- matches current app;
- each Agent keeps its own `AGENTS.md`;
- no file conflicts.

Cons:

- less like working on one shared artifact.

### Option B - Shared Group Workspace

All Agents work in one group workspace.

```text
Group workspace
Backend writes files
Frontend edits files
Security reviews files
```

Pros:

- better for demos where Agents build one artifact together;
- feels more like real collaboration.

Cons:

- one workspace has only one `AGENTS.md`;
- per-Agent identity must be injected in the turn prompt;
- file conflicts and sequencing matter;
- secrets and dependency outputs need redaction before entering other Agents'
  threads.

### Recommended Choice

For the first implementation:

```text
shared group transcript
separate Agent threads
per-Agent workspaces
```

For a stronger later demo:

```text
shared group transcript
separate Agent group threads
shared group workspace
per-turn identity prompt
sequential or DAG execution
```

---

## Data Concepts

Rough data shape:

```ts
interface AgentGroup {
  id: string;
  name: string;
  description: string;
  memberAgentIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface GroupMessage {
  id: string;
  groupId: string;
  seq: number;
  speakerType: "human" | "agent";
  speakerAgentId: string | null;
  content: string;
  createdAt: string;
}

interface GroupParticipantState {
  groupId: string;
  agentId: string;
  role: string;
  groupThreadId: string | null;
  lastSeenSeq: number;
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
  status: GroupTaskStatus;
  currentNodeId: string | null;
  nodeRunIds: string[];
  createdAt: string;
  completedAt: string | null;
}

interface GroupPlanNode {
  id: string;
  groupTaskId: string;
  agentId: string;
  dependsOn: string[];
  status: GroupTaskStatus;
  runId: string | null;
}
```

This can be simplified during implementation. The most important fields are:

- `GroupMessage.seq`
- `GroupParticipantState.groupThreadId`
- `GroupParticipantState.lastSeenSeq`
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

---

## Demo Flow

Minimal demo:

```text
1. Create Backend, Frontend, and Security Agents.
2. Create Upload Feature Team group.
3. Send group task: "Plan an upload feature."
4. Backend speaks first.
5. Frontend receives Backend's message through transcript sync and replies.
6. Security receives Backend + Frontend messages and replies.
7. Backend takes another turn and receives only new messages since its last turn.
8. UI shows one shared group timeline with speaker labels.
9. UI or trace shows each Agent's lastSeenSeq / injected transcript delta.
```

What this proves:

- multiple real Agents participate in one task;
- Agents do not share one Codex thread;
- the group chat history is shared through the app;
- each Agent receives only the transcript delta it has not seen;
- the user sees one coherent group conversation.

---

## Open Questions

1. Should group tasks use per-Agent workspaces first, or a shared group
   workspace?
2. Should each Agent have a separate `groupThreadId` per group from day one, or
   should MVP reuse the current `codexThreadId`?
3. Should the first implementation be a simple sequence or a tiny DAG?
4. Should the user be able to manually choose the next speaker?
5. Should a group task end after one pass through all Agents, or after a fixed
   number of rounds?

Recommended first answers:

```text
workspace: per-Agent workspaces
thread: separate groupThreadId per Agent per group if feasible
orchestration: deterministic sequence
speaker control: automatic first, manual later
termination: one pass for MVP, configurable rounds later
```

---

## One-Sentence Summary

Group chat should be implemented as a shared app-level transcript with
speaker-labelled messages and per-Agent transcript cursors. Each Agent runs in
its own Codex context, receives only the new messages it has not seen, and writes
its reply back into the shared group timeline.
