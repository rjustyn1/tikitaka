/**
 * Flush trigger -- `middlewaredoc/components/FLUSH-TRIGGER.md`.
 *
 * Decides when a group task is terminal and ready for memory consolidation.
 * This is the boundary between orchestration and memory extraction, and it is
 * the ONLY thing that changes when the v1 sequential chain is later upgraded to
 * a DAG (`ARCHITECTURE.md` section 9). The pipeline behind it never changes.
 *
 * Pure by contract: it returns a decision and never mutates the store. The
 * caller marks `GroupTask.flushedAt` after task-buffer creation succeeds.
 */

import type { GroupPlanNode, GroupTask, GroupTaskStatus } from "../types.js";

export interface FlushTriggerInput {
  groupTask: GroupTask;
  planNodes: GroupPlanNode[];
  /**
   * Skip the once-only `flushedAt` guard and answer the plan question alone:
   * "is every sink of this task settled?"
   *
   * Segment consolidation needs exactly that. `GroupTask.flushedAt` now marks
   * that a task has been ACCOUNTED FOR by segment bookkeeping, not that its
   * memory was extracted -- extraction is guarded by `TopicSegment.flushedAt`.
   * Without this flag a segment could never consolidate, because by the time it
   * closes every task inside it is already stamped.
   */
  ignoreFlushMark?: boolean;
}

export type FlushDecision =
  | { shouldFlush: true; reason: "completed" | "partial" }
  | { shouldFlush: false; reason: "not_terminal" | "no_completed_runs" };

const NODE_TERMINAL: readonly GroupTaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

function isNodeTerminal(node: GroupPlanNode): boolean {
  return NODE_TERMINAL.includes(node.status);
}

function isTerminalTask(task: GroupTask): boolean {
  return ["completed", "partial", "failed", "cancelled"].includes(task.status);
}

/**
 * The nearest ancestor of `node` that failed or was cancelled, or null.
 *
 * SHARED WITH THE EXECUTOR. `GroupRunner.executeGroupTask()` asks the same
 * question for a different reason -- "may I skip this node?" -- and must get
 * the same answer, so both callers use this one traversal. Two implementations
 * of "is this node blocked" that can disagree would be worse than the bug it
 * fixes: the runner would abandon a node the flush trigger still waits on, or
 * vice versa.
 *
 * Breadth-first on purpose: the first failure found is the CLOSEST one, which
 * is the useful thing to name in a skipped node's error message.
 */
export function findFailedAncestor(
  node: GroupPlanNode,
  byId: Map<string, GroupPlanNode>,
): GroupPlanNode | null {
  const seen = new Set<string>([node.id]);
  const queue = [...node.dependsOn];
  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (!dependency) continue;
    if (dependency.status === "failed" || dependency.status === "cancelled") {
      return dependency;
    }
    queue.push(...dependency.dependsOn);
  }
  return null;
}

/**
 * A node that can never run, because something it transitively depends on
 * failed or was cancelled.
 *
 * The TD's sketch checks sink status alone, which is not sufficient: when a
 * mid-chain node fails the runner stops, leaving every later node `queued`
 * forever. Reading sink status alone would report `not_terminal` and the task
 * would never consolidate -- contradicting the TD's own rule that "failed or
 * cancelled branches do not block the task forever". Treating unreachable
 * nodes as settled is what makes that rule true.
 */
export function isUnreachable(
  node: GroupPlanNode,
  byId: Map<string, GroupPlanNode>,
): boolean {
  return findFailedAncestor(node, byId) !== null;
}

export function decideFlush(input: FlushTriggerInput): FlushDecision {
  // A task flushes at most once.
  if (!input.ignoreFlushMark && input.groupTask.flushedAt) {
    return { shouldFlush: false, reason: "not_terminal" };
  }

  const nodes = input.planNodes.filter(
    (node) => node.groupTaskId === input.groupTask.id,
  );
  if (nodes.length === 0) {
    return {
      shouldFlush: false,
      reason: isTerminalTask(input.groupTask)
        ? "no_completed_runs"
        : "not_terminal",
    };
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
  // Sink = a node nothing else depends on. In the v1 chain that is the single
  // last node; in a DAG it is every leaf.
  const sinkNodes = nodes.filter((node) => !dependedOn.has(node.id));

  const settled = (node: GroupPlanNode): boolean =>
    isNodeTerminal(node) || isUnreachable(node, byId);

  if (!sinkNodes.every(settled)) {
    return { shouldFlush: false, reason: "not_terminal" };
  }

  const completed = nodes.filter((node) => node.status === "completed");
  if (completed.length === 0) {
    // Every sink is settled and nothing usable came out of the task.
    return { shouldFlush: false, reason: "no_completed_runs" };
  }

  return sinkNodes.every((node) => node.status === "completed")
    ? { shouldFlush: true, reason: "completed" }
    : { shouldFlush: true, reason: "partial" };
}
