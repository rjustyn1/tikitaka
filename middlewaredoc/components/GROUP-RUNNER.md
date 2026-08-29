# Group Runner Technical Design

## Component

`apps/server/src/memory/group-runner.ts`

## Purpose

> ⚠️ **V1 IS A SEQUENTIAL CHAIN, NOT A DAG.** See A4 in
> `../DECISIONS.md`. Everything in this document describing parallel
> phases, branch nodes, join nodes, join-owner selection, or parallel-set
> validation is **STRETCH scope** - build it only after the sequential demo runs
> end to end. The v1 chain, the runner call, and the failure behaviour below are
> current and correct.

Execute a group task across selected Agents using the branch-and-join DAG from
`../GROUP-CHAT-DESIGN.md`.

The group runner owns task execution, context packets, node status, run IDs, and
group timeline messages. It does not extract or land memory directly.

## Inputs

```ts
interface StartGroupTaskInput {
  groupId: string;
  prompt: string;
}
```

## Main Flow

```text
1. Freeze group membership.
2. Create shared code directory.
3. Link or mount shared code as ./code in each selected Agent root.
4. Create preseeded/template DAG.
5. Validate parallel phases.
6. Write per-Agent group-task AGENTS.md sections.
7. Execute runnable DAG nodes.
8. Save group messages, runs, spans, node outputs, and context injections.
9. Finish at final join node.
10. Ask flush-trigger whether memory consolidation should run.
```

## Runner Call

Use the existing `AgentRunner` interface:

```ts
runner.run({
  agentId,
  runId,
  workspacePath: participant.agentWorkspacePath,
  threadId: participant.groupThreadId,
  prompt: groupNodePrompt,
  // A2: REQUIRED for group nodes. container -> extra bind mount at
  // /workspace/code; local-process -> codex exec --add-dir. Without this the
  // Agent cannot write to shared code at all.
  sharedCodePath: task.sharedCodePath,
});
```

The prompt tells the Agent to work under `./code`.

## Code-Level Spec

Export a service class so it can be constructed from `AgentService`:

```ts
export class GroupRunner {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly flushTrigger: FlushTrigger,
    private readonly taskBuffer: TaskBufferBuilder,
    private readonly memoryPipeline: MemoryPipeline,
  ) {}

  createGroup(input: CreateGroupInput): Promise<AgentGroup>;
  updateGroup(id: string, input: UpdateGroupInput): Promise<AgentGroup>;
  getGroup(id: string): AgentGroup;
  listGroups(): AgentGroup[];
  startGroupTask(groupId: string, prompt: string): Promise<GroupTask>;
  getGroupTask(taskId: string): GroupTaskResponse;
}
```

Request types:

```ts
interface CreateGroupInput {
  name: string;
  description?: string;
  members: GroupMember[];    // A4: {agentId, role}, exactly three
}

interface UpdateGroupInput {
  name?: string;
  description?: string;
  members?: GroupMember[];   // frozen while activeTaskId is set
}

interface GroupTaskResponse {
  task: GroupTask;
  nodes: GroupPlanNode[];
  messages: GroupMessage[];
  contextInjections: GroupContextInjection[];
}
```

`startGroupTask()` should:

```ts
async function startGroupTask(groupId: string, prompt: string) {
  // 1. read group and selected agents
  // 2. reject if group has activeTaskId
  // 3. A4: reject unless exactly three members, one per role
  //    409 "This plan needs one backend, one frontend, and one security member."
  // 4. create GroupTask with status queued
  // 5. create sharedCodePath
  // 6. create/update GroupParticipantState for each member
  // 7. create preseeded/template GroupPlanNode rows
  // 8. write initial human GroupMessage seq
  // 9. set group.activeTaskId = task.id
  // 10. kick executeGroupTask(task.id) in background
  // 11. return task immediately
}
```

`executeGroupTask()` should:

```ts
// V1: plain sequential loop over the chain.
for (const node of chainInOrder) {
  await runPlanNode(node.id);
  if (node.status === "failed") break;   // partial consolidation still allowed
}

// STRETCH: parallel form, build with the DAG.
// while (task has runnable nodes) {
//   const runnable = findRunnableNodes(task, nodes);
//   validateParallelSet(runnable);
//   await Promise.all(runnable.map((node) => runPlanNode(node.id)));
// }

const decision = decideFlush({ groupTask, planNodes });
if (decision.shouldFlush) {
  const buffer = await taskBuffer.build({ groupTaskId, sinkNodeIds: decision.sinkNodeIds });
  await memoryPipeline.run(buffer);
}
```

`runPlanNode()` should:

```ts
// A3: acquire the Agent lease FIRST - this is what stops a solo run and a
// group node colliding on CodexRunner.active and on the container --name.
// await lease.acquireAgent(node.agentId, { kind: "group", groupTaskId, planNodeId });
// Store transition: queued -> running
// Build context packet and persist GroupContextInjection before Codex runs.
// Write GroupRuntimeLock rows for this node (records only in v1 - collision
// validation is STRETCH, it cannot fire while one node runs at a time).
// Call runner.run() with participant.groupThreadId.
// Persist captured thread id back to GroupParticipantState.groupThreadId.
// Save output to GroupPlanNode.output and GroupMessage.
// Store transition: running -> completed/failed/cancelled.
// Release the Agent lease AND the runtime lock rows in finally.
```

Use `GroupParticipantState.groupThreadId`, not `Agent.codexThreadId`. The solo
thread must stay untouched by group tasks.

## Preseeded Chain (V1) And DAG (STRETCH)

**V1 - build this.** A fixed five-node sequential chain, bound by ROLE so any
three Agents can play it:

```text
1  backend-contract   role: backend    owns code/apps/server/**
2  frontend-plan      role: frontend   readOnly, dependsOn backend-contract
3  security-review    role: security   readOnly, dependsOn frontend-plan
4  backend-impl       role: backend    owns code/apps/server/**, dependsOn security-review
5  frontend-impl      role: frontend   owns code/apps/web/**,   dependsOn backend-impl
```

Backend and Frontend each take two turns, so the demo shows plan-then-implement.
Sequential means node 4 starts only after node 3 completes - no overlap, so the
A3 lease needs no re-entrancy.

**STRETCH - do not build yet.** The branch-and-join DAG:

```text
backend-contract
  agent: Backend
  kind: work
  owns: code/apps/server/**

frontend-plan
  agent: Frontend
  kind: work
  dependsOn: backend-contract
  readOnly: true

security-review
  agent: Security
  kind: work
  dependsOn: backend-contract
  readOnly: true

join-plan
  agent: planner-selected join owner
  kind: join
  dependsOn: frontend-plan, security-review

backend-impl
  agent: Backend
  kind: work
  dependsOn: join-plan
  owns: code/apps/server/**

frontend-impl
  agent: Frontend
  kind: work
  dependsOn: join-plan
  owns: code/apps/web/**

final-join
  agent: planner-selected join owner
  kind: join
  dependsOn: backend-impl, frontend-impl
```

## Parallel Safety (STRETCH)

Not applicable to the v1 chain - one node runs at a time. Build with the DAG.

Before launching a parallel set:

- no Agent appears twice;
- no write path overlaps;
- no runtime lock overlaps;
- all dependencies are complete.

If validation fails, serialize or fail the task before launching Codex.

## Failure Behavior

- Failed node marks task `partial` or `failed` based on requiredness.
- Completed branches remain usable for partial consolidation.
- Locks are released in `finally`.
- Memory extraction failure does not fail the group task.

## Tests

- runs the five-node sequential chain in order;
- an Agent taking two turns (Backend, Frontend) works without lease deadlock;
- a solo message during a group task returns 409, not 500 (A3);
- shared ./code is writable from a real Codex run in BOTH runtimes (A2);
- STRETCH: prevents duplicate Agent in one parallel set;
- STRETCH: prevents overlapping runtime locks;
- stores groupThreadId separately from solo codexThreadId;
- calls flush-trigger after final join.
