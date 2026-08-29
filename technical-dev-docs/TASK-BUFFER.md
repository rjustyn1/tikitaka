# Task Buffer Technical Design

## Component

`apps/server/src/memory/task-buffer.ts`

## Purpose

Build the exact input packet for the consolidator after a group task reaches a
flush point.

The task buffer does not store a second copy of all spans during execution. It
stores group task references, then reads runs, messages, plan nodes, context
injections, and spans back from the store when the flush trigger fires.

## Inputs

```ts
interface BuildTaskBufferInput {
  groupTaskId: string;
  sinkNodeIds: string[];
}
```

## Output

```ts
interface TaskBuffer {
  groupTaskId: string;
  groupId: string;
  prompt: string;
  status: GroupTaskStatus;
  orderedNodeIds: string[];
  entries: TaskBufferEntry[];
}

interface TaskBufferEntry {
  planNodeId: string;
  agentId: string;
  nodeRole: string;
  runId: string;
  output: string;
  spans: TraceSpan[];
  injectedMessageIds: string[];
  injectedDependencyNodeIds: string[];
}
```

## Code-Level Spec

Export a builder class:

```ts
export class TaskBufferBuilder {
  constructor(private readonly store: JsonStore) {}

  build(input: BuildTaskBufferInput): TaskBuffer;
}
```

Implementation sketch:

```ts
build(input) {
  const db = store.snapshot();
  const task = mustFind(db.groupTasks, input.groupTaskId);
  const nodes = db.groupPlanNodes.filter((n) => n.groupTaskId === task.id);
  const orderedNodes = topologicalSort(nodes);

  return {
    groupTaskId: task.id,
    groupId: task.groupId,
    prompt: task.prompt,
    status: task.status,
    orderedNodeIds: orderedNodes.map((n) => n.id),
    entries: orderedNodes.flatMap((node) => buildEntry(db, node)),
  };
}
```

`buildEntry()`:

```ts
function buildEntry(db: Database, node: GroupPlanNode): TaskBufferEntry[] {
  if (!node.runId) return [];

  const run = db.runs.find((item) => item.id === node.runId);
  if (!run) return [];

  const spans = db.spans
    .filter((span) => span.runId === run.id)
    .filter(shouldIncludeSpan)
    .map(trimSpanForConsolidator);

  const injection = db.contextInjections.find((item) =>
    item.planNodeId === node.id && item.agentId === node.agentId,
  );

  return [{
    planNodeId: node.id,
    agentId: node.agentId,
    nodeRole: node.nodeRole,
    runId: run.id,
    output: node.output ?? run.output ?? "",
    spans,
    injectedMessageIds: injection?.injectedMessageIds ?? [],
    injectedDependencyNodeIds: injection?.injectedDependencyNodeIds ?? [],
  }];
}
```

Topological sort should throw on cycles. `GroupRunner` should catch that and mark
the task failed before consolidation.

## Ordering

Sequential tasks use planned order.

DAG tasks use topological order. If two sibling nodes are independent, order by
`completedAt`, then `planNodeId` as a deterministic tie-breaker. Join nodes
always appear after their dependencies.

## Filtering

The first version should include:

- `agent_message`
- terminal `reasoning` summaries if useful
- `file_write`
- failed `command_exec` summaries
- `error`

The first version should exclude noisy successful command output unless the
command failure or final output needs it.

Code-level span filter:

```ts
function shouldIncludeSpan(span: TraceSpan): boolean {
  if (span.type === "agent_message") return true;
  if (span.type === "file_write") return true;
  if (span.type === "error") return true;
  if (span.type === "reasoning") {
    return span.payload.kind === "reasoning" && span.payload.terminal === true;
  }
  if (span.type === "command_exec") {
    return span.status === "failed";
  }
  return false;
}
```

Use `MAX_TASK_BUFFER_CHARS`, default `40_000`, to cap the final serialized
buffer before sending it to the extractor.

## Redaction Boundary

Task buffer does not perform final redaction. It may trim huge content, but
secret redaction belongs to `safety.ts`. The consolidator input should never
include raw environment variables if the span parser already marks them as
truncated.

## Failure Behavior

If one run is missing, include the node as an incomplete buffer entry with its
status and continue. The consolidator can still extract useful memories from
completed entries.

## Tests

- builds a sequential buffer in chain order;
- builds a DAG buffer in topological order;
- includes context injection IDs for audit;
- handles failed/cancelled nodes without throwing;
- caps huge span payloads before returning the buffer.
