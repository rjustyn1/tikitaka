/**
 * Display helpers shared by the group panels.
 *
 * Every governed-memory row references Agents, groups, tasks and spans by UUID.
 * Rendered raw that is an unreadable wall of hex, and the demo's whole point is
 * that a human can read a governance decision. Everything here exists to turn
 * an id into something a person can act on.
 */
import type {
  Agent,
  GrantRecord,
  GroupMember,
  GroupPlanNode,
  GroupRole,
  GroupTaskStatus,
  MemoryNote,
  MemoryStatus,
} from "../types";

/** Task/node statuses that will never change again. */
const TERMINAL_STATUSES: readonly GroupTaskStatus[] = [
  "completed",
  "partial",
  "cancelled",
  "failed",
];

/**
 * A task is `queued` BEFORE it is `running`, so `status !== "running"` passes
 * instantly and every poll loop built on it exits immediately. Always test
 * membership of the terminal set instead.
 */
export function isTerminal(status: GroupTaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const ROLES: readonly GroupRole[] = ["backend", "frontend", "security"];

/** Resolve an Agent id to a name, falling back to a short id rather than "". */
export function agentName(agents: Agent[], agentId: string | null): string {
  if (!agentId) return "—";
  return agents.find((agent) => agent.id === agentId)?.name ?? shortId(agentId);
}

/** Last resort when an id has no matching row: readable, still unique enough. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function roleOf(
  members: GroupMember[],
  agentId: string,
): GroupRole | null {
  return members.find((member) => member.agentId === agentId)?.role ?? null;
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

/** Duration between two ISO timestamps, for the node table. */
export function durationOf(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

/** Maps a status onto the pill modifier class in styles.css. */
export function statusTone(
  status: GroupTaskStatus | MemoryStatus,
): "ok" | "warn" | "bad" | "busy" | "idle" {
  switch (status) {
    case "completed":
    case "active":
      return "ok";
    case "partial":
    case "pending":
      return "warn";
    case "failed":
    case "rejected":
    case "quarantined":
      return "bad";
    case "running":
      return "busy";
    default:
      return "idle";
  }
}

export function grantTone(
  decision: GrantRecord["decision"],
): "ok" | "warn" | "bad" | "idle" {
  switch (decision) {
    case "granted":
      return "ok";
    case "withheld":
      return "warn";
    case "rejected":
    case "revoked":
      return "bad";
    default:
      return "idle";
  }
}

/**
 * Withholding reasons, phrased for a human.
 *
 * `out_of_group` is the one that carries the demo: the Agent was never a member,
 * so nothing was ever written into its workspace.
 */
export function withheldReason(reason: string): string {
  switch (reason) {
    case "granted":
      // The ledger stores "granted" as the reason on a grant row. Echoing it
      // into the Reason column reads as "granted / granted".
      return "routed to this Agent by the note";
    case "out_of_group":
      return "not a member of this group";
    case "not_targeted":
      return "a member, but this note was not routed to it";
    case "private":
      return "marked private to its source Agent";
    case "quarantined":
      return "note was quarantined by the safety check";
    case "rejected":
      return "a human rejected this note";
    case "revoked":
      return "a human revoked this note";
    case "landing_failed":
      return "the file write failed";
    default:
      return reason;
  }
}

/** Why a note needs a human before it can activate. */
export function reviewReasons(note: MemoryNote): string[] {
  const reasons: string[] = [];
  if (note.severity === "severe") reasons.push("severe");
  if (note.redactionFired) reasons.push("redaction fired");
  if (note.quarantineHit) reasons.push("quarantine hit");
  if (note.targetAgentIds.length > 2) reasons.push("broad routing");
  return reasons;
}

export function isAwaitingReview(note: MemoryNote): boolean {
  return note.status === "pending" || note.status === "quarantined";
}

/** Chain order for display: dependency order, which for v1 is a straight line. */
export function orderedNodes(nodes: GroupPlanNode[]): GroupPlanNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = (node: GroupPlanNode, seen = new Set<string>()): number => {
    if (seen.has(node.id)) return 0; // defensive: never loop on a bad cycle
    seen.add(node.id);
    const parents = node.dependsOn
      .map((id) => byId.get(id))
      .filter((parent): parent is GroupPlanNode => parent !== undefined);
    if (parents.length === 0) return 0;
    return 1 + Math.max(...parents.map((parent) => depth(parent, seen)));
  };
  return [...nodes].sort((left, right) => {
    const delta = depth(left) - depth(right);
    return delta !== 0 ? delta : left.id.localeCompare(right.id);
  });
}
