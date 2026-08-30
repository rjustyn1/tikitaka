# Group Runner Technical Design

## Component

`apps/server/src/memory/group-runner.ts`

## Purpose

> The planner emits a bounded, validated DAG from the task and member
> descriptions. The runner executes its topological order sequentially.
> Concurrent phases and runtime-lock collision handling remain stretch scope.

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
4. Ask the planner for a validated DAG and persist each mini-plan.
5. Derive file ownership and runtime lock records server-side.
6. Write per-Agent group-task AGENTS.md sections.
7. Execute DAG nodes in validated topological order.
8. Save group messages, runs, spans, node outputs, and context injections.
9. Finish when every reachable node is terminal.
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
  members: GroupMember[];    // 2-12 unique Agents; role is a display label
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
  // 3. reject unless there are 2-12 unique Agent members
  // 4. create GroupTask with status queued
  // 5. create sharedCodePath
  // 6. create/update GroupParticipantState for each member
  // 7. plan from the prompt + Agent descriptions and persist GroupPlanNode rows
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

## Planner-authored DAG

`planner.ts` receives the task plus all 2-12 member descriptions and may select
the relevant subset. It returns no more than eight nodes, each with an Agent
index, dependencies, instruction, expected output, work area and write flag.
The server resolves indices to ids, rejects malformed or cyclic plans, derives
ownership from a fixed work-area map, and falls back to one sequential node per
member if planning fails.

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

- runs planner nodes in validated topological order;
- accepts 2-12 members and planner-selected subsets;
- an Agent taking multiple turns works without lease deadlock;
- a solo message during a group task returns 409, not 500 (A3);
- shared ./code is writable from a real Codex run in BOTH runtimes (A2);
- STRETCH: prevents duplicate Agent in one parallel set;
- STRETCH: prevents overlapping runtime locks;
- stores groupThreadId separately from solo codexThreadId;
- calls flush-trigger after final join.
