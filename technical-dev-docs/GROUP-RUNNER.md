# Group Runner Technical Design

## Component

`apps/server/src/memory/group-runner.ts`

## Purpose

Execute a group task across selected Agents using the branch-and-join DAG from
`GROUPCHAT.md`.

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
  memberAgentIds: string[];
}

interface UpdateGroupInput {
  name?: string;
  description?: string;
  memberAgentIds?: string[];
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
  // 3. reject if group has fewer than two members
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
while (task has runnable nodes) {
  const runnable = findRunnableNodes(task, nodes);
  validateParallelSet(runnable);
  await Promise.all(runnable.map((node) => runPlanNode(node.id)));
}

const decision = decideFlush({ groupTask, planNodes });
if (decision.shouldFlush) {
  const buffer = await taskBuffer.build({ groupTaskId, sinkNodeIds: decision.sinkNodeIds });
  await memoryPipeline.run(buffer);
}
```

`runPlanNode()` should:

```ts
// Store transition: queued -> running
// Build context packet and persist GroupContextInjection before Codex runs.
// Acquire locks in store.
// Call runner.run() with participant.groupThreadId.
// Persist captured thread id back to GroupParticipantState.groupThreadId.
// Save output to GroupPlanNode.output and GroupMessage.
// Store transition: running -> completed/failed/cancelled.
// Release locks in finally.
```

Use `GroupParticipantState.groupThreadId`, not `Agent.codexThreadId`. The solo
thread must stay untouched by group tasks.

## Preseeded Demo DAG

For the first demo, create this deterministic DAG:

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

## Parallel Safety

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

- runs a preseeded DAG in dependency order;
- prevents duplicate Agent in one parallel set;
- prevents overlapping runtime locks;
- stores groupThreadId separately from solo codexThreadId;
- calls flush-trigger after final join.
