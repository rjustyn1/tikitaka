/**
 * Contracts from the A1-A5 design review that Person 1 has not landed in
 * `types.ts` yet. See `middlewaredoc/DECISIONS.md` and `middlewaredoc/SPEC.md`.
 *
 * ---------------------------------------------------------------------------
 * DELETE THIS FILE when Person 1 lands the A1-A5 deltas.
 * ---------------------------------------------------------------------------
 *
 * This is the ONLY place in the tree that defines a contract Person 1 owns, so
 * the cutover is one import rewrite per call site and no divergent permanent
 * type definition is ever committed (`PLAN.md` -> Bridge 1 -> Mock strategy).
 *
 * Three deltas live here:
 *
 *   A4  `members: [{agentId, role}]`   replaces `AgentGroup.memberAgentIds`
 *   A2  `RunnerRequest.sharedCodePath` carries the group's shared code dir
 *   A3  `AgentLease`                   one lease shared by solo and group runs
 */

import type { Agent, AgentGroup, RunnerRequest } from "../types.js";

// ---------------------------------------------------------------------------
// A4 - role-bound membership
// ---------------------------------------------------------------------------

/** The five-node chain binds to roles, never to agent names or list order. */
export type GroupRole = "backend" | "frontend" | "security";

export const GROUP_ROLES: readonly GroupRole[] = [
  "backend",
  "frontend",
  "security",
];

export interface GroupMember {
  agentId: string;
  role: GroupRole;
}

/**
 * `AgentGroup` as A4 specifies it.
 *
 * `members` is authoritative. `memberAgentIds` is inherited from Person 1's
 * `AgentGroup` and kept as a DERIVED MIRROR (see `deriveMemberAgentIds`) so
 * that the landed server type, the web DTOs and `apps/web/src/api.ts` all stay
 * valid while the two contracts coexist. When Person 1 lands A4, delete the
 * mirror and this alias becomes plain `AgentGroup`.
 */
export type GovernedGroup = AgentGroup & { members: GroupMember[] };

export interface CreateGovernedGroupInput {
  name: string;
  description?: string | undefined;
  members: GroupMember[];
}

export interface UpdateGovernedGroupInput {
  name?: string | undefined;
  description?: string | undefined;
  members?: GroupMember[] | undefined;
}

/**
 * Recompute the legacy mirror. Called on every group write so the two fields
 * can never drift apart.
 */
export function deriveMemberAgentIds(members: readonly GroupMember[]): string[] {
  return members.map((member) => member.agentId);
}

/**
 * Read membership from a stored group.
 *
 * Rows written by this workstream always carry `members`. The fallback maps
 * `memberAgentIds` onto roles positionally, which is best-effort only: it
 * exists so a pre-A4 row cannot crash a read path. No such row can exist today,
 * because `createGroup` threw 501 until this workstream landed.
 */
export function readMembers(group: AgentGroup): GroupMember[] {
  const candidate = (group as Partial<GovernedGroup>).members;
  if (Array.isArray(candidate)) {
    return candidate;
  }
  return group.memberAgentIds.flatMap((agentId, index) => {
    const role = GROUP_ROLES[index];
    return role ? [{ agentId, role }] : [];
  });
}

/** Roles present exactly once, with no agent used twice. */
export function findMembershipError(
  members: readonly GroupMember[],
): string | null {
  if (members.length !== GROUP_ROLES.length) {
    return "This plan needs one backend, one frontend, and one security member.";
  }
  const agentIds = new Set(members.map((member) => member.agentId));
  if (agentIds.size !== members.length) {
    return "Each Agent may hold only one role in a group.";
  }
  for (const role of GROUP_ROLES) {
    if (members.filter((member) => member.role === role).length !== 1) {
      return "This plan needs one backend, one frontend, and one security member.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// A2 - shared code on the runner request
// ---------------------------------------------------------------------------

/**
 * `RunnerRequest` plus the group's shared code directory.
 *
 * `sharedCodePath` is optional, so a plain `RunnerRequest` remains assignable
 * to this type and every existing solo call site keeps compiling untouched.
 *
 *   container runtime -> extra bind mount at `/workspace/code`
 *   local-process     -> `codex exec --add-dir <path>`
 *
 * Omitted for solo runs.
 */
export interface GroupRunnerRequest extends RunnerRequest {
  sharedCodePath?: string | undefined;
}

// ---------------------------------------------------------------------------
// A3 - the agent lease
// ---------------------------------------------------------------------------

export type AgentLeaseHolder =
  | { kind: "solo"; runId: string }
  | { kind: "group"; groupTaskId: string; planNodeId: string };

/**
 * One lease, shared by solo runs and group nodes.
 *
 * Both `CodexRunner.active` and `ContainerCodexRunner`'s `--name` are keyed by
 * `agentId`, so without this a solo message sent during a group node surfaces
 * as a raw 500 and `stopAgent()` would kill a running group node.
 *
 * Deliberately NOT re-entrant: the v1 chain is sequential, so an agent taking
 * two turns acquires and releases twice with no overlap (A4).
 */
export interface AgentLease {
  acquireAgent(agentId: string, holder: AgentLeaseHolder): Promise<Agent>;
  releaseAgent(agentId: string, holder: AgentLeaseHolder): Promise<void>;
}
