/**
 * The v1 plan template -- A4 in `middlewaredoc/DECISIONS.md`.
 *
 * v1 is a hardcoded FIVE-NODE SEQUENTIAL CHAIN, not a DAG. It is built as a
 * degenerate DAG (`node[i].dependsOn = [node[i-1].id]`) so the data model and
 * every downstream consumer -- flush trigger, task buffer, ledger -- are
 * identical to what a real DAG would produce. Upgrading later is a planner
 * change, not a pipeline change, which is exactly the claim
 * `ARCHITECTURE.md` section 9 makes.
 *
 * Nodes bind to ROLES, never to Agent names or member-list order, so any three
 * Agents can play the demo.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { GroupPlanNode } from "../types.js";
import type { GroupMember, GroupRole } from "./pending-contracts.js";

export const MEMBERSHIP_MESSAGE =
  "This plan needs one backend, one frontend, and one security member.";

export interface ChainNodeTemplate {
  nodeRole: string;
  role: GroupRole;
  readOnly: boolean;
  fileOwnershipHints: string[];
  /**
   * Lock ROWS are written per node so the UI can show which area a node held.
   * Collision VALIDATION is STRETCH: it cannot fire while one node runs at a
   * time (A4).
   */
  runtimeLocks: string[];
  instruction: string;
  expectedOutput: string;
}

/**
 * Backend and Frontend each take two turns, so the demo still tells the
 * plan-then-implement story. Because the chain is sequential, node 4 starts
 * only after node 3 completes, so an Agent's two turns never overlap and the
 * A3 lease needs no re-entrancy.
 */
export const V1_CHAIN: readonly ChainNodeTemplate[] = [
  {
    nodeRole: "backend-contract",
    role: "backend",
    readOnly: false,
    fileOwnershipHints: ["code/apps/server/**"],
    runtimeLocks: ["code/apps/server/**"],
    instruction:
      "Propose the endpoint contract and the storage flow for this task. State the public request and response shape explicitly, and say what must NOT cross the boundary to other Agents.",
    expectedOutput: "An endpoint contract and storage flow.",
  },
  {
    nodeRole: "frontend-plan",
    role: "frontend",
    readOnly: true,
    fileOwnershipHints: [],
    runtimeLocks: [],
    instruction:
      "Plan the UI and API integration against the contract above. Ask for any public API detail you still need. Do not write code in this turn.",
    expectedOutput: "A UI/API integration plan.",
  },
  {
    nodeRole: "security-review",
    role: "security",
    readOnly: true,
    fileOwnershipHints: [],
    runtimeLocks: [],
    instruction:
      "Review auth, validation, and secret boundaries across the contract and the frontend plan. Call out anything that would leak a credential between Agents. Do not write code in this turn.",
    expectedOutput: "A security review with explicit constraints.",
  },
  {
    nodeRole: "backend-impl",
    role: "backend",
    readOnly: false,
    fileOwnershipHints: ["code/apps/server/**"],
    runtimeLocks: ["code/apps/server/**"],
    instruction:
      "Implement the backend changes under ./code/apps/server, honouring the security constraints raised above.",
    expectedOutput: "Backend implementation in shared code.",
  },
  {
    nodeRole: "frontend-impl",
    role: "frontend",
    readOnly: false,
    fileOwnershipHints: ["code/apps/web/**"],
    runtimeLocks: ["code/apps/web/**"],
    instruction:
      "Implement the frontend changes under ./code/apps/web against the implemented backend contract.",
    expectedOutput: "Frontend implementation in shared code.",
  },
];

/** The agent that plays a role, or a 409 naming what the plan needs. */
export function resolveRole(
  members: readonly GroupMember[],
  role: GroupRole,
): string {
  const member = members.find((item) => item.role === role);
  if (!member) {
    throw new HttpError(409, MEMBERSHIP_MESSAGE);
  }
  return member.agentId;
}

/**
 * Materialise the chain for one task.
 *
 * `allowedPlanNodeIds` carries every ancestor, which in a chain is simply every
 * earlier node. `contextSnapshotSeq` is left at 0 and stamped when the node
 * actually becomes runnable.
 */
export function buildChainNodes(
  groupTaskId: string,
  members: readonly GroupMember[],
  createdAt: string,
): GroupPlanNode[] {
  const nodes: GroupPlanNode[] = [];
  const ancestors: string[] = [];
  let previousId: string | null = null;

  for (const template of V1_CHAIN) {
    const id = randomUUID();
    nodes.push({
      id,
      groupTaskId,
      agentId: resolveRole(members, template.role),
      kind: "work",
      nodeRole: template.nodeRole,
      dependsOn: previousId ? [previousId] : [],
      contextSnapshotSeq: 0,
      allowedPlanNodeIds: [...ancestors],
      status: "queued",
      runId: null,
      output: null,
      error: null,
      readOnly: template.readOnly,
      fileOwnershipHints: [...template.fileOwnershipHints],
      runtimeLocks: [...template.runtimeLocks],
      expectedOutput: template.expectedOutput,
      createdAt,
      startedAt: null,
      completedAt: null,
    });
    ancestors.push(id);
    previousId = id;
  }

  return nodes;
}

export function templateFor(nodeRole: string): ChainNodeTemplate | undefined {
  return V1_CHAIN.find((template) => template.nodeRole === nodeRole);
}
