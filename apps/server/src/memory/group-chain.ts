/**
 * Group membership rules, and the deterministic fallback plan.
 *
 * WHAT CHANGED. This file used to hold `V1_CHAIN` -- A4's fixed five-node,
 * three-role template that was the source of EVERY plan, for every task. A4 is
 * superseded: `memory/planner.ts` now reads the task prompt and each Agent's
 * description and decides the graph. What remains here is the membership
 * boundary and a fallback for callers that do not have a planner to hand.
 *
 * Membership is no longer role-shaped. `GROUP-CHAT-DESIGN.md`'s locked decision
 * described membership as "explicit Agent toggles" with no fixed count; the
 * exactly-three-one-per-role rule was A4 scope control, not the design. A group
 * now holds any explicitly selected number of Agents, and the planner decides
 * which of them a given task actually needs.
 */

import { HttpError } from "../errors.js";
import type { GroupPlanNode } from "../types.js";
import type { AgentGroup, GroupMember, GroupRole } from "../types.js";
import {
  MAX_PLAN_NODES,
  buildPlanNodes,
  fallbackPlan,
  type PlannerAgent,
} from "./planner.js";

/** A team needs at least two Agents to collaborate. */
export const MIN_GROUP_MEMBERS = 2;

/** The group cap matches the planner and fallback node cap. */
export const MAX_GROUP_MEMBERS = 8;

export const MEMBERSHIP_MESSAGE =
  "A group needs between " +
  MIN_GROUP_MEMBERS +
  " and " +
  MAX_GROUP_MEMBERS +
  " members.";

/**
 * Retained so `group-prompt.ts` keeps a stable type while `GroupRunner` still
 * passes a template through. New code reads `node.instruction` instead.
 *
 * @deprecated Plans are planner-authored; there is no template table any more.
 */
export interface ChainNodeTemplate {
  nodeRole: string;
  role: GroupRole;
  readOnly: boolean;
  fileOwnershipHints: string[];
  runtimeLocks: string[];
  instruction: string;
  expectedOutput: string;
}

/**
 * There is no template table any more, so there is nothing to look up.
 *
 * Kept as a no-op shim purely so `GroupRunner` compiles unchanged during the
 * handoff; `buildTurnPrompt` already prefers the node's own persisted
 * instruction, so removing the call site is a pure deletion.
 *
 * @deprecated Read `node.instruction`. Remove this call, then this function.
 */
export function templateFor(_nodeRole: string): ChainNodeTemplate | undefined {
  return undefined;
}

/**
 * The agent holding a role, or a 409.
 *
 * @deprecated Role lookup is not how work is assigned any more -- the planner
 * assigns nodes to Agent ids directly. Kept for callers still migrating.
 */
export function resolveRole(
  members: readonly GroupMember[],
  role: GroupRole,
): string {
  const member = members.find((item) => item.role === role);
  if (!member) {
    throw new HttpError(409, "No member of this group holds the " + role + " role.");
  }
  return member.agentId;
}

/**
 * The deterministic fallback plan, materialised for one task.
 *
 * SIGNATURE PRESERVED so `GroupRunner.startGroupTask()` keeps compiling and
 * keeps working while Person 1 wires in the async `TaskPlanner`. It no longer
 * stamps a constant: it produces one node per member, sequential, which is the
 * same shape `TaskPlanner` degrades to when a model plan is unusable.
 *
 * It has only members, not Agent rows, so it has no descriptions to work from.
 * That is exactly why it is the fallback and not the planner.
 */
export function buildChainNodes(
  groupTaskId: string,
  members: readonly GroupMember[],
  createdAt: string,
): GroupPlanNode[] {
  const agents: PlannerAgent[] = members.map((member) => ({
    id: member.agentId,
    name: member.role || "member",
    description: "",
  }));
  return buildPlanNodes(
    groupTaskId,
    fallbackPlan({ prompt: "", agents }).slice(0, MAX_PLAN_NODES),
    createdAt,
  );
}

// ---------------------------------------------------------------------------
// Membership validation
// ---------------------------------------------------------------------------

/**
 * The three v1 labels, kept only as defaults for callers that still need to
 * name one (`pipeline.ts`'s synthetic group). They are no longer required, and
 * no longer drive assignment.
 */
export const GROUP_ROLES: readonly GroupRole[] = [
  "backend",
  "frontend",
  "security",
];

/** Membership from a stored group. */
export function readMembers(group: AgentGroup): GroupMember[] {
  return Array.isArray(group.members) ? group.members : [];
}

/**
 * The only two membership rules left: a workable size, and no Agent twice.
 *
 * Roles are free-form labels now. Two members may share one, or carry none --
 * the planner reads descriptions, not labels, so a duplicate label costs
 * nothing. A duplicated AGENT still does: the A3 lease is not re-entrant, so
 * one Agent listed twice could be asked to hold itself.
 */
export function findMembershipError(
  members: readonly GroupMember[],
): string | null {
  if (members.length < MIN_GROUP_MEMBERS || members.length > MAX_GROUP_MEMBERS) {
    return MEMBERSHIP_MESSAGE;
  }
  const agentIds = new Set(members.map((member) => member.agentId));
  if (agentIds.size !== members.length) {
    return "Each Agent may appear only once in a group.";
  }
  return null;
}
