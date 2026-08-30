/**
 * What one Agent is doing on the current task, derived from persisted plan
 * nodes.
 *
 * This exists because the member rail makes a live claim about someone's Agent,
 * and that claim has to be traceable to a row the server wrote. Nothing here
 * reads the clock or guesses: `running` means a node row says `running`.
 *
 * Precedence is deliberate — failed beats running beats unstarted beats done —
 * so a rail that says "Running" can never be hiding a failure underneath.
 */
import type { GroupPlanNode, GroupTaskStatus } from "../types";
import { isTerminal } from "./format";

export type LiveState =
  | "idle"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "stopped";

export interface AgentLiveStatus {
  state: LiveState;
  /** A sentence for the rail. Present tense while live, past tense when not. */
  label: string;
  /** The node the label is about, when there is one. */
  nodeRole: string | null;
  completed: number;
  total: number;
}

export function liveStatusFor(
  agentId: string,
  nodes: GroupPlanNode[],
  taskStatus: GroupTaskStatus | null,
): AgentLiveStatus {
  const mine = nodes.filter((node) => node.agentId === agentId);
  const total = mine.length;
  const completed = mine.filter((node) => node.status === "completed").length;
  const base = { nodeRole: null, completed, total };

  if (total === 0) {
    return { ...base, state: "idle", label: "No step in this task" };
  }

  const failed = mine.find((node) => node.status === "failed");
  if (failed) {
    return {
      ...base,
      state: "failed",
      nodeRole: failed.nodeRole,
      label: "Failed on " + failed.nodeRole,
    };
  }

  const running = mine.find((node) => node.status === "running");
  if (running) {
    return {
      ...base,
      state: "running",
      nodeRole: running.nodeRole,
      label: "Running " + running.nodeRole,
    };
  }

  const unstarted = mine.find(
    (node) => node.status === "queued" || node.status === "cancelled",
  );
  if (unstarted) {
    // A terminal task will never start this node. Saying "waiting" there would
    // promise something that is not coming.
    const stopped = taskStatus !== null && isTerminal(taskStatus);
    return {
      ...base,
      state: stopped ? "stopped" : "waiting",
      nodeRole: unstarted.nodeRole,
      label: (stopped ? "Stopped before " : "Waiting for ") + unstarted.nodeRole,
    };
  }

  return {
    ...base,
    state: "done",
    label: "Finished " + completed + (completed === 1 ? " step" : " steps"),
  };
}
