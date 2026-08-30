// Task buffer: builds the exact input packet for the consolidator after a group
// task reaches a flush point.
//
// It does NOT keep a second live copy of spans during execution. It reads runs,
// nodes, context injections, and spans back from the store snapshot when the
// flush trigger fires, orders the nodes topologically, filters noisy spans, and
// caps the total size. See components/TASK-BUFFER.md.

import type { Database, GroupPlanNode, TraceSpan } from "../types.js";
import type { JsonStore } from "../store.js";
import type { TaskBuffer, TaskBufferEntry } from "./types.js";

export interface BuildTaskBufferInput {
  groupTaskId: string;
  sinkNodeIds: string[];
}

/** Cap on the final serialized buffer handed to the extractor. */
export const MAX_TASK_BUFFER_CHARS = 40_000;

/** Per-span cap on any single textual payload field. */
const SPAN_TEXT_CAP = 4_000;

const TRUNCATION_SUFFIX = "…[truncated]";

function mustFind<T>(items: T[], predicate: (item: T) => boolean, what: string): T {
  const found = items.find(predicate);
  if (!found) throw new Error(`Task buffer could not find ${what}`);
  return found;
}

/**
 * Deterministic topological order. Sequential chains come out in chain order;
 * independent siblings are ordered by completedAt, then planNodeId. Join nodes
 * always follow their dependencies. Throws on a cycle.
 */
export function topologicalSort(nodes: GroupPlanNode[]): GroupPlanNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    // Only count dependencies that are part of THIS node set.
    const deps = node.dependsOn.filter((dep) => byId.has(dep));
    inDegree.set(node.id, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    }
  }

  const tieBreak = (a: GroupPlanNode, b: GroupPlanNode): number => {
    const ac = a.completedAt ?? "";
    const bc = b.completedAt ?? "";
    if (ac !== bc) {
      // Nodes without a completedAt sort last.
      if (ac === "") return 1;
      if (bc === "") return -1;
      return ac < bc ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  };

  const ordered: GroupPlanNode[] = [];
  let ready = nodes.filter((node) => inDegree.get(node.id) === 0).sort(tieBreak);

  while (ready.length > 0) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const dependentId of dependents.get(node.id) ?? []) {
      const next = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, next);
      if (next === 0) {
        ready.push(byId.get(dependentId)!);
      }
    }
    ready = ready.sort(tieBreak);
  }

  if (ordered.length !== nodes.length) {
    throw new Error("Task buffer detected a cycle in the plan DAG");
  }
  return ordered;
}

export function shouldIncludeSpan(span: TraceSpan): boolean {
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

function capText(text: string): string {
  if (text.length <= SPAN_TEXT_CAP) return text;
  return text.slice(0, SPAN_TEXT_CAP) + TRUNCATION_SUFFIX;
}

/** Clone a span and truncate any oversized textual payload field. */
export function trimSpanForConsolidator(span: TraceSpan): TraceSpan {
  const payload = span.payload;
  let trimmed = payload;
  switch (payload.kind) {
    case "reasoning":
      trimmed = { ...payload, text: capText(payload.text) };
      break;
    case "agent_message":
      trimmed = { ...payload, text: capText(payload.text) };
      break;
    case "command_exec":
      trimmed = { ...payload, output: capText(payload.output) };
      break;
    case "error":
      trimmed = { ...payload, message: capText(payload.message) };
      break;
    default:
      trimmed = payload;
  }
  return { ...span, payload: trimmed };
}

function buildEntry(db: Database, node: GroupPlanNode): TaskBufferEntry[] {
  // Missing run: keep the node as an incomplete entry so the consolidator still
  // sees it, but it carries no spans. (Failure behaviour: never throw here.)
  if (!node.runId) {
    return [
      {
        planNodeId: node.id,
        agentId: node.agentId,
        nodeRole: node.nodeRole,
        runId: "",
        output: node.output ?? "",
        spans: [],
        injectedMessageIds: [],
        injectedDependencyNodeIds: [],
      },
    ];
  }

  const run = db.runs.find((item) => item.id === node.runId);
  const spans = db.spans
    .filter((span) => span.runId === node.runId)
    .filter(shouldIncludeSpan)
    .map(trimSpanForConsolidator);

  const injection = db.contextInjections.find(
    (item) => item.planNodeId === node.id && item.agentId === node.agentId,
  );

  return [
    {
      planNodeId: node.id,
      agentId: node.agentId,
      nodeRole: node.nodeRole,
      runId: node.runId,
      output: node.output ?? run?.output ?? "",
      spans,
      injectedMessageIds: injection?.injectedMessageIds ?? [],
      injectedDependencyNodeIds: injection?.injectedDependencyNodeIds ?? [],
    },
  ];
}

/**
 * Enforce MAX_TASK_BUFFER_CHARS over the whole entry list. Walks entries in
 * order, keeping the earliest nodes fullest; once the running budget is spent,
 * later entries drop their spans and truncate their output. Deterministic.
 */
function enforceBufferCap(entries: TaskBufferEntry[]): TaskBufferEntry[] {
  if (JSON.stringify(entries).length <= MAX_TASK_BUFFER_CHARS) return entries;

  const result: TaskBufferEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    const withoutSpans: TaskBufferEntry = { ...entry, spans: [] };
    const skeletonCost = JSON.stringify(withoutSpans).length;

    if (used + skeletonCost > MAX_TASK_BUFFER_CHARS) {
      // No room even for the skeleton with full output — truncate the output.
      const room = Math.max(0, MAX_TASK_BUFFER_CHARS - used - 200);
      result.push({
        ...withoutSpans,
        output: entry.output.slice(0, room) + TRUNCATION_SUFFIX,
      });
      used = MAX_TASK_BUFFER_CHARS;
      continue;
    }

    used += skeletonCost;
    const kept: TraceSpan[] = [];
    for (const span of entry.spans) {
      const cost = JSON.stringify(span).length;
      if (used + cost > MAX_TASK_BUFFER_CHARS) break;
      used += cost;
      kept.push(span);
    }
    result.push({ ...entry, spans: kept });
  }
  return result;
}

export class TaskBufferBuilder {
  constructor(private readonly store: JsonStore) {}

  build(input: BuildTaskBufferInput): TaskBuffer {
    const db = this.store.snapshot();
    const task = mustFind(
      db.groupTasks,
      (item) => item.id === input.groupTaskId,
      `group task ${input.groupTaskId}`,
    );

    const nodes = db.groupPlanNodes.filter(
      (node) => node.groupTaskId === task.id,
    );
    const orderedNodes = topologicalSort(nodes);
    const entries = enforceBufferCap(
      orderedNodes.flatMap((node) => buildEntry(db, node)),
    );

    return {
      groupTaskId: task.id,
      groupId: task.groupId,
      prompt: task.prompt,
      status: task.status,
      orderedNodeIds: orderedNodes.map((node) => node.id),
      entries,
    };
  }
}
