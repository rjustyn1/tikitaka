/**
 * Laying a plan out as the graph it actually is.
 *
 * The plan is a DAG: steps fan out to run in parallel and rejoin at a join
 * node. Rendered as a numbered list every plan looks like a straight chain, so
 * this computes real positions -- one row per dependency depth, siblings side
 * by side -- and the edges between them.
 *
 * Kept free of React so the layout and the progress arithmetic are tested on
 * their own.
 */
import type { GroupPlanNode, GroupTaskStatus } from "../types";

export const NODE_W = 132;
export const NODE_H = 46;
export const GAP_X = 16;
export const GAP_Y = 34;

export interface PlanBox {
  node: GroupPlanNode;
  level: number;
  x: number;
  y: number;
}

export interface PlanEdge {
  id: string;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /**
   * An edge feeding a step that is running right now, so the highlight points
   * at where the plan actually is. Deliberately not "parent done, child not":
   * that lit up edges into a join still blocked on other branches, which read
   * as a live path when nothing was moving along it.
   */
  active: boolean;
}

export interface PlanLayout {
  boxes: PlanBox[];
  edges: PlanEdge[];
  width: number;
  height: number;
}

/**
 * Depth of each node = longest path from any root, so a join always sits below
 * every branch feeding it. Memoised, with a guard against a dependency cycle:
 * a malformed plan must still render rather than hang the panel.
 */
function levelsOf(nodes: GroupPlanNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (id: string): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    // Cycle, or an edge pointing outside this task: treat as a root rather
    // than recursing forever.
    if (visiting.has(id)) return 0;
    const node = byId.get(id);
    if (!node) return 0;
    visiting.add(id);
    const parents = node.dependsOn.filter((parent) => byId.has(parent));
    const value = parents.length === 0
      ? 0
      : Math.max(...parents.map((parent) => depth(parent) + 1));
    visiting.delete(id);
    level.set(id, value);
    return value;
  };

  for (const node of nodes) depth(node.id);
  return level;
}

/** Positions and edges for the whole plan, in a top-to-bottom flow. */
export function layoutPlan(nodes: GroupPlanNode[]): PlanLayout {
  if (nodes.length === 0) return { boxes: [], edges: [], width: 0, height: 0 };

  const level = levelsOf(nodes);
  const rows = new Map<number, GroupPlanNode[]>();
  // Input order is the server's topological order, so rows stay stable.
  for (const node of nodes) {
    const row = level.get(node.id) ?? 0;
    const list = rows.get(row);
    if (list) list.push(node);
    else rows.set(row, [node]);
  }

  const widest = Math.max(...[...rows.values()].map((row) => row.length));
  const width = widest * NODE_W + (widest - 1) * GAP_X;
  const depth = Math.max(...rows.keys()) + 1;
  const height = depth * NODE_H + (depth - 1) * GAP_Y;

  const boxes: PlanBox[] = [];
  for (const [row, list] of rows) {
    // Centre each row against the widest one so the graph reads symmetrically.
    const rowWidth = list.length * NODE_W + (list.length - 1) * GAP_X;
    const left = (width - rowWidth) / 2;
    list.forEach((node, index) => {
      boxes.push({
        node,
        level: row,
        x: left + index * (NODE_W + GAP_X),
        y: row * (NODE_H + GAP_Y),
      });
    });
  }

  const byId = new Map(boxes.map((box) => [box.node.id, box]));
  const edges: PlanEdge[] = [];
  for (const box of boxes) {
    for (const parentId of box.node.dependsOn) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      edges.push({
        id: parentId + "->" + box.node.id,
        from: parentId,
        to: box.node.id,
        x1: parent.x + NODE_W / 2,
        y1: parent.y + NODE_H,
        x2: box.x + NODE_W / 2,
        y2: box.y,
        active: box.node.status === "running",
      });
    }
  }

  return { boxes, edges, width, height };
}

export interface PlanProgress {
  done: number;
  total: number;
  /** Percent complete, for the bar. */
  percent: number;
  running: GroupPlanNode[];
  failed: GroupPlanNode[];
  /** Steps whose dependencies are all met but which have not started. */
  ready: GroupPlanNode[];
}

const FINISHED: GroupTaskStatus[] = ["completed"];

/** Where the plan is right now: how much is done, and what is in flight. */
export function planProgress(nodes: GroupPlanNode[]): PlanProgress {
  const done = nodes.filter((node) => FINISHED.includes(node.status)).length;
  const total = nodes.length;
  const doneIds = new Set(
    nodes.filter((node) => FINISHED.includes(node.status)).map((node) => node.id),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    running: nodes.filter((node) => node.status === "running"),
    failed: nodes.filter((node) => node.status === "failed"),
    ready: nodes.filter(
      (node) =>
        node.status === "queued" &&
        node.dependsOn
          .filter((id) => byId.has(id))
          .every((id) => doneIds.has(id)),
    ),
  };
}
