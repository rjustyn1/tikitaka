// Segment buffer: builds the exact input packet for the consolidator after a
// TOPIC SEGMENT closes.
//
// It does NOT keep a second live copy of spans during execution. It reads runs,
// nodes, context injections, spans, and the chat timeline back from the store
// snapshot when a segment closes, orders each task's nodes topologically,
// filters noisy spans, and caps the total size. See components/TASK-BUFFER.md.

import type { Database, GroupPlanNode, TraceSpan } from "../types.js";
import type { JsonStore } from "../store.js";
import { messagesIn, tasksIn } from "./topic-segment.js";
import type {
  SegmentBuffer,
  SegmentTranscriptLine,
  TaskBufferEntry,
} from "./types.js";

export interface BuildSegmentBufferInput {
  segmentId: string;
}

/** Cap on the final serialized buffer handed to the extractor. */
export const MAX_SEGMENT_BUFFER_CHARS = 120_000;

/**
 * Share of the buffer reserved for the chat transcript; node entries get the
 * rest. The transcript is what the consolidator reasons over, so it gets the
 * larger half, but entries must keep enough room to carry citable provenance.
 */
export const TRANSCRIPT_BUDGET_SHARE = 0.6;

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
 * Enforce a char budget over the whole entry list. Walks entries in order,
 * keeping the EARLIEST nodes fullest; once the running budget is spent, later
 * entries drop their spans and truncate their output. Deterministic.
 *
 * Earliest-first is deliberate and is the opposite of how the transcript trims:
 * entry order carries provenance (a cited run index must still resolve), while
 * transcript order carries relevance.
 */
export function enforceBufferCap(
  entries: TaskBufferEntry[],
  budget: number,
): TaskBufferEntry[] {
  if (JSON.stringify(entries).length <= budget) return entries;

  const result: TaskBufferEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    const withoutSpans: TaskBufferEntry = { ...entry, spans: [] };
    const skeletonCost = JSON.stringify(withoutSpans).length;

    if (used + skeletonCost > budget) {
      // No room even for the skeleton with full output — truncate the output.
      // Measure the empty-output skeleton rather than reserving a constant:
      // a fixed guess overflows whenever ids and role names run long, which is
      // exactly the case where the budget is already tight.
      const emptyOutputCost = JSON.stringify({
        ...withoutSpans,
        output: "",
      }).length;
      const room = Math.max(
        0,
        budget - used - emptyOutputCost - TRUNCATION_SUFFIX.length,
      );
      result.push({
        ...withoutSpans,
        output: entry.output.slice(0, room) + TRUNCATION_SUFFIX,
      });
      used = budget;
      continue;
    }

    used += skeletonCost;
    const kept: TraceSpan[] = [];
    for (const span of entry.spans) {
      const cost = JSON.stringify(span).length;
      if (used + cost > budget) break;
      used += cost;
      kept.push(span);
    }
    result.push({ ...entry, spans: kept });
  }
  return result;
}

/**
 * Enforce a char budget over the transcript by dropping the OLDEST lines.
 *
 * Opposite direction to `enforceBufferCap` on purpose: in a chat, the most
 * recent exchanges are the ones the durable facts came out of, so an
 * over-long segment should lose its beginning rather than its end.
 */
export function trimTranscript(
  lines: SegmentTranscriptLine[],
  budget: number,
): SegmentTranscriptLine[] {
  if (JSON.stringify(lines).length <= budget) return lines;

  const kept: SegmentTranscriptLine[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    const cost = JSON.stringify(line).length + 1;
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(line);
  }
  return kept;
}

export class SegmentBufferBuilder {
  constructor(private readonly store: JsonStore) {}

  build(input: BuildSegmentBufferInput): SegmentBuffer {
    const db = this.store.snapshot();
    const segment = mustFind(
      db.topicSegments,
      (item) => item.id === input.segmentId,
      `topic segment ${input.segmentId}`,
    );

    const tasks = tasksIn(segment, db.groupTasks);

    // Nodes are ordered topologically WITHIN each task, and tasks are ordered
    // by creation. A segment's tasks are sequential by construction (the group
    // rejects a new task while one runs), so there is no cross-task DAG to sort.
    const orderedNodes: GroupPlanNode[] = tasks.flatMap((task) =>
      topologicalSort(
        db.groupPlanNodes.filter((node) => node.groupTaskId === task.id),
      ),
    );

    const transcript: SegmentTranscriptLine[] = messagesIn(
      segment,
      db.groupMessages,
    ).map((message) => ({
      seq: message.seq,
      speakerType: message.speakerType,
      agentId: message.speakerAgentId,
      content: message.content,
    }));

    // Measure the envelope exactly, then split what is actually left. Reserving
    // a fixed constant instead would overflow the cap whenever the prompts run
    // long, which is precisely when the buffer is already under pressure.
    const envelope: SegmentBuffer = {
      segmentId: segment.id,
      groupId: segment.groupId,
      prompts: tasks.map((task) => task.prompt),
      groupTaskIds: tasks.map((task) => task.id),
      transcript: [],
      entries: [],
    };
    const available = Math.max(
      0,
      MAX_SEGMENT_BUFFER_CHARS - JSON.stringify(envelope).length,
    );
    const transcriptBudget = Math.floor(available * TRANSCRIPT_BUDGET_SHARE);
    const trimmedTranscript = trimTranscript(transcript, transcriptBudget);

    // Hand the transcript's unspent budget to the entries rather than waste it:
    // a short chat should not starve provenance it has room for.
    const allEntries = orderedNodes.flatMap((node) => buildEntry(db, node));
    let entriesBudget = Math.max(
      0,
      available - JSON.stringify(trimmedTranscript).length,
    );

    // Converge on the real serialized size instead of predicting JSON framing
    // overhead. Two budgets, nested arrays, and per-entry truncation suffixes
    // make an exact formula brittle; measuring is both simpler and correct.
    // enforceBufferCap shrinks monotonically with its budget, so this settles
    // in one or two passes -- the loop bound is a guard, not the mechanism.
    let buffer!: SegmentBuffer;
    for (let pass = 0; pass < 4; pass++) {
      buffer = {
        ...envelope,
        transcript: trimmedTranscript,
        entries: enforceBufferCap(allEntries, entriesBudget),
      };
      const overflow =
        JSON.stringify(buffer).length - MAX_SEGMENT_BUFFER_CHARS;
      if (overflow <= 0) break;
      entriesBudget = Math.max(0, entriesBudget - overflow - 16);
    }
    return buffer;
  }
}
