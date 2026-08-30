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

/** Map a free-form display role onto one of the available visual accents. */
/**
 * The role label for an Agent, derived from the Agent itself.
 *
 * Role labels are cosmetic: the planner picks who works on a node by reading
 * each Agent's `description`, and never looks at this. Letting a human type one
 * anyway produced labels that contradicted the Agent they were attached to -- a
 * "Security Agent" carrying the label `frontend`, with the wrong colour dot
 * everywhere it appeared. Deriving it means the label can never disagree with
 * the Agent it describes.
 */
export function deriveRole(agentName: string): string {
  const slug = agentName
    .trim()
    .toLowerCase()
    .replace(/\bagent\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "member";
}

export function roleClass(role: GroupRole | null): string {
  const normalized = role?.trim().toLowerCase();
  return normalized === "backend" ||
    normalized === "frontend" ||
    normalized === "security"
    ? normalized
    : "member";
}

/** Resolve an Agent id to a name, falling back to a short id rather than "". */
export function agentName(agents: Agent[], agentId: string | null): string {
  if (!agentId) return "—";
  return agents.find((agent) => agent.id === agentId)?.name ?? shortId(agentId);
}

/** Last resort when an id has no matching row: readable, still unique enough. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The tail of a landed-memory path — `upload-contract/SKILL.md`.
 *
 * The server records whatever separator its own filesystem uses, so a Windows
 * host stores `C:\Users\…\.agents\skills\x\SKILL.md`. Splitting on "/" alone
 * leaves the whole absolute path on screen, which is unreadable and leaks the
 * operator's home directory into the demo. Split on both separators.
 */
export function fileTail(path: string, segments = 2): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.slice(-segments).join("/");
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

/** Preserve the validated planner order persisted and returned by the server. */
export function orderedNodes(nodes: GroupPlanNode[]): GroupPlanNode[] {
  return [...nodes];
}
