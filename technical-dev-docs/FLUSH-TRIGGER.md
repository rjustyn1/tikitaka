# Flush Trigger Technical Design

## Component

`apps/server/src/memory/flush-trigger.ts`

## Purpose

Decide when a group task is terminal and ready for memory consolidation.

The flush trigger is the boundary between orchestration and memory extraction:
the group runner executes nodes, then the flush trigger says whether the whole
task has enough completed work to produce candidate memories.

## Inputs

```ts
interface FlushTriggerInput {
  groupTask: GroupTask;
  planNodes: GroupPlanNode[];
}
```

## Output

```ts
type FlushDecision =
  | { shouldFlush: true; reason: "completed" | "partial"; sinkNodeIds: string[] }
  | { shouldFlush: false; reason: "not_terminal" | "no_completed_runs" };
```

## Rules

- Sequential task flushes when the last planned node is terminal.
- DAG task flushes when every sink node is terminal.
- Demo DAG flushes after the final join node completes.
- Failed or cancelled branches do not block the task forever.
- Partial consolidation is allowed only if at least one useful node completed.
- A task flushes at most once.

## Terminal Conditions

```text
completed:
  all required sink nodes completed

partial:
  at least one node completed
  and at least one required node failed or cancelled

not_terminal:
  at least one required runnable or running node remains

no_completed_runs:
  task ended but no agent produced usable output
```

## Store Effects

The trigger itself should not mutate the store. It returns a decision. The
caller marks the `GroupTask` as flushed after task-buffer creation succeeds.

## Code-Level Spec

Export a pure function first:

```ts
export function decideFlush(input: FlushTriggerInput): FlushDecision {
  if (input.groupTask.flushedAt) {
    return { shouldFlush: false, reason: "not_terminal" };
  }

  const nodes = input.planNodes.filter((n) => n.groupTaskId === input.groupTask.id);
  const completed = nodes.filter((n) => n.status === "completed");
  if (completed.length === 0 && isTerminalTask(input.groupTask)) {
    return { shouldFlush: false, reason: "no_completed_runs" };
  }

  const sinkNodes = nodes.filter((node) =>
    !nodes.some((candidate) => candidate.dependsOn.includes(node.id)),
  );

  const requiredSinksTerminal = sinkNodes.every((node) =>
    ["completed", "failed", "cancelled"].includes(node.status),
  );

  if (!requiredSinksTerminal) {
    return { shouldFlush: false, reason: "not_terminal" };
  }

  if (sinkNodes.every((node) => node.status === "completed")) {
    return {
      shouldFlush: true,
      reason: "completed",
      sinkNodeIds: sinkNodes.map((node) => node.id),
    };
  }

  return {
    shouldFlush: true,
    reason: "partial",
    sinkNodeIds: sinkNodes.map((node) => node.id),
  };
}
```

Helper:

```ts
function isTerminalTask(task: GroupTask): boolean {
  return ["completed", "partial", "failed", "cancelled"].includes(task.status);
}
```

For the demo DAG, the final join should be the only sink. That keeps the
decision simple while still allowing the same function to work for future DAGs.

## Failure Behavior

If the trigger cannot evaluate the DAG, return `shouldFlush: false`. Memory
consolidation must fail open: the user task should still finish even when memory
does not run.

## Tests

- sequential chain flushes after last node completes;
- DAG flushes after final join completes;
- unfinished branch returns `not_terminal`;
- failed branch plus completed branch returns `partial`;
- all failed nodes returns `no_completed_runs`;
- repeated trigger after flush does not create a second flush.
