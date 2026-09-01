/**
 * The plan drawn as a DAG, with a progress line for where the run is now.
 *
 * Sits above the per-step cards in the Plan tab: the graph answers "what is
 * the shape and where are we", the cards answer "what exactly was this step
 * told to do".
 */
import { useMemo } from "react";
import type { Agent, AgentGroup, GroupPlanNode } from "../types";
import { agentName, roleClass, roleOf } from "./format";
import {
  GAP_Y,
  NODE_H,
  NODE_W,
  layoutPlan,
  planProgress,
} from "./plan-graph";

/** Padding so the focus ring on an edge node is not clipped by the viewBox. */
const PAD = 6;

function statusWord(node: GroupPlanNode): string {
  if (node.status === "queued") return "waiting";
  return node.status;
}

export function PlanGraph({
  nodes,
  agents,
  group,
  selectedId,
  onSelect,
}: {
  nodes: GroupPlanNode[];
  agents: Agent[];
  group: AgentGroup;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const layout = useMemo(() => layoutPlan(nodes), [nodes]);
  const progress = useMemo(() => planProgress(nodes), [nodes]);
  if (layout.boxes.length === 0) return null;

  const running = progress.running[0];
  const where = progress.failed.length > 0 && progress.running.length === 0
    ? "Stopped at " + progress.failed.map((node) => node.nodeRole).join(", ")
    : running
      ? "Running " +
        progress.running.map((node) => node.nodeRole).join(" + ") +
        (progress.running.length > 1 ? " in parallel" : "")
      : progress.done === progress.total
        ? "All steps finished"
        : progress.ready.length > 0
          ? "Next up: " + progress.ready.map((node) => node.nodeRole).join(", ")
          : "Waiting";

  return (
    <section className="plan-graph" aria-label="Plan graph">
      <div className="plan-progress">
        <div className="plan-progress-head">
          <strong>{where}</strong>
          <span className="plan-progress-count">
            {progress.done} of {progress.total} steps done
          </span>
        </div>
        <div
          className="plan-progress-track"
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Plan progress"
        >
          <div
            className={
              "plan-progress-fill" +
              (progress.failed.length > 0 ? " has-failure" : "")
            }
            style={{ width: progress.percent + "%" }}
          />
        </div>
      </div>

      <div className="plan-graph-scroll">
        <svg
          className="plan-graph-svg"
          viewBox={
            -PAD + " " + -PAD + " " +
            (layout.width + PAD * 2) + " " + (layout.height + PAD * 2)
          }
          width={layout.width + PAD * 2}
          height={layout.height + PAD * 2}
          role="img"
          aria-label={
            "Plan graph: " + layout.boxes.length + " steps, " +
            progress.done + " done"
          }
        >
          {layout.edges.map((edge) => {
            // A vertical S-curve: leaves the parent downward and arrives at the
            // child downward, so fan-out and rejoin stay readable.
            const midY = edge.y1 + GAP_Y / 2;
            return (
              <path
                key={edge.id}
                className={"plan-edge" + (edge.active ? " is-active" : "")}
                d={
                  "M " + edge.x1 + " " + edge.y1 +
                  " C " + edge.x1 + " " + midY +
                  ", " + edge.x2 + " " + midY +
                  ", " + edge.x2 + " " + edge.y2
                }
                fill="none"
              />
            );
          })}
          {layout.boxes.map(({ node, x, y }) => {
            const role = roleOf(group.members, node.agentId);
            const selected = node.id === selectedId;
            return (
              <g
                key={node.id}
                className={
                  "plan-node status-" + node.status +
                  (selected ? " selected" : "")
                }
                transform={"translate(" + x + "," + y + ")"}
                onClick={() => onSelect(node.id)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
              >
                <title>
                  {node.nodeRole + " — " + statusWord(node) + " — " +
                    agentName(agents, node.agentId)}
                </title>
                <rect
                  className="plan-node-box"
                  width={NODE_W}
                  height={NODE_H}
                  rx={9}
                />
                <circle
                  className={"plan-node-dot role-" + roleClass(role)}
                  cx={13}
                  cy={NODE_H / 2}
                  r={4}
                />
                <text className="plan-node-role" x={24} y={19}>
                  {node.nodeRole}
                </text>
                <text className="plan-node-status" x={24} y={33}>
                  {statusWord(node)}
                  {node.kind === "join" ? " · join" : ""}
                </text>
                {node.status === "running" && (
                  <circle className="plan-node-pulse" cx={NODE_W - 13} cy={NODE_H / 2} r={4} />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
