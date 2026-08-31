import { describe, expect, it } from "vitest";
import type { GroupMessage, GroupMember, GroupPlanNode } from "../types.js";
import {
  MAX_GROUP_MEMBERS,
  buildChainNodes,
  findMembershipError,
} from "./group-chain.js";
import {
  buildContextPacket,
  buildGroupTaskCharter,
  buildTurnPrompt,
} from "./group-prompt.js";
import { buildPlanNodes, validatePlan, parsePlannerJson } from "./planner.js";

const MEMBERS: GroupMember[] = [
  { agentId: "agent-backend", role: "backend" },
  { agentId: "agent-frontend", role: "frontend" },
  { agentId: "agent-security", role: "security" },
];

function message(seq: number, content: string, agentId?: string): GroupMessage {
  return {
    id: "m" + seq,
    groupId: "group-1",
    seq,
    speakerType: agentId ? "agent" : "human",
    speakerAgentId: agentId ?? null,
    groupTaskId: "task-1",
    planNodeId: null,
    content,
    createdAt: "2026-01-01T00:00:0" + seq + ".000Z",
  };
}

/** A real planner plan, materialised — what the runner will actually execute. */
function plannedNodes(raw: unknown[]): GroupPlanNode[] {
  const parsed = parsePlannerJson(JSON.stringify({ nodes: raw }));
  if (!parsed) throw new Error("fixture is not valid planner output");
  const validated = validatePlan(parsed, [
    { id: "agent-backend", name: "Backend", description: "backend work" },
    { id: "agent-frontend", name: "Frontend", description: "frontend work" },
    { id: "agent-security", name: "Security", description: "security review" },
  ]);
  if (!validated.ok) throw new Error("fixture rejected: " + validated.reason);
  return buildPlanNodes("task-1", validated.nodes, "2026-01-01T00:00:00.000Z");
}

describe("group membership", () => {
  it("accepts between two and twelve explicitly selected Agents", () => {
    // A4's exactly-three rule is gone, but a team still needs two members.
    expect(findMembershipError(MEMBERS)).toBeNull();
    expect(findMembershipError(MEMBERS.slice(0, 2))).toBeNull();
    expect(findMembershipError(MEMBERS.slice(0, 1))).toContain("members");
  });

  it("no longer requires any particular role to be present", () => {
    expect(
      findMembershipError([
        { agentId: "a", role: "data" },
        { agentId: "b", role: "docs" },
      ]),
    ).toBeNull();
  });

  it("allows two members to share a label, since labels no longer assign work", () => {
    expect(
      findMembershipError([
        { agentId: "a", role: "backend" },
        { agentId: "b", role: "backend" },
      ]),
    ).toBeNull();
  });

  it("still rejects an empty group and one past the cap", () => {
    expect(findMembershipError([])).toContain("members");
    const tooMany = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_u, i) => ({
      agentId: "agent-" + i,
      role: "member",
    }));
    expect(findMembershipError(tooMany)).toContain("members");
  });

  it("still rejects the same Agent listed twice", () => {
    // The A3 lease is not re-entrant, so one Agent twice could hold itself.
    expect(
      findMembershipError([
        { agentId: "same", role: "backend" },
        { agentId: "same", role: "frontend" },
      ]),
    ).toContain("only once");
  });
});

describe("the deterministic fallback plan", () => {
  it("is one node per member, sequential, with a single sink", () => {
    const nodes = buildChainNodes("task-1", MEMBERS, "2026-01-01T00:00:00.000Z");
    expect(nodes).toHaveLength(MEMBERS.length);
    expect(nodes[0]!.dependsOn).toEqual([]);
    for (let index = 1; index < nodes.length; index += 1) {
      expect(nodes[index]!.dependsOn).toEqual([nodes[index - 1]!.id]);
    }
    const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
    expect(nodes.filter((node) => !dependedOn.has(node.id))).toHaveLength(1);
  });

  it("scales with the group instead of assuming three members", () => {
    const two = buildChainNodes("t", MEMBERS.slice(0, 2), "2026-01-01T00:00:00.000Z");
    expect(two).toHaveLength(2);
    expect(two.map((node) => node.agentId)).toEqual([
      "agent-backend",
      "agent-frontend",
    ]);
  });

  it("gives every node an instruction, so nothing renders blank", () => {
    const nodes = buildChainNodes("t", MEMBERS, "2026-01-01T00:00:00.000Z");
    expect(nodes.every((node) => node.instruction.trim().length > 0)).toBe(true);
  });

  it("accumulates ancestors so a node can read every earlier output", () => {
    const nodes = buildChainNodes("t", MEMBERS, "2026-01-01T00:00:00.000Z");
    expect(nodes[0]!.allowedPlanNodeIds).toEqual([]);
    expect(nodes[2]!.allowedPlanNodeIds).toEqual(
      nodes.slice(0, 2).map((node) => node.id),
    );
  });
});

describe("context packets", () => {
  const node = plannedNodes([
    { agent: 1, instruction: "Define the contract.", dependsOn: [] },
    { agent: 2, instruction: "Plan the UI.", dependsOn: [0] },
  ])[1]!;
  const messages = [
    message(1, "Plan an upload feature."),
    message(2, "Use POST /uploads", "agent-backend"),
    message(3, "I need the schema", "agent-frontend"),
    message(4, "Do not expose secrets", "agent-security"),
  ];

  it("injects only what this Agent has not seen", () => {
    const packet = buildContextPacket({
      node,
      messages,
      lastSeenSeq: 2,
      contextSnapshotSeq: 4,
    });
    expect(packet.injectedMessageIds).toEqual(["m3", "m4"]);
    // Already seen -- transcript dedupe, NOT a policy denial.
    expect(packet.withheldMessageIds).toEqual(["m1", "m2"]);
    expect(packet.fromSeqExclusive).toBe(2);
    expect(packet.toSeqInclusive).toBe(4);
  });

  it("withholds anything past the snapshot so timing cannot change what is seen", () => {
    const packet = buildContextPacket({
      node,
      messages,
      lastSeenSeq: 0,
      contextSnapshotSeq: 2,
    });
    expect(packet.injectedMessageIds).toEqual(["m1", "m2"]);
    expect(packet.withheldMessageIds).toEqual(["m3", "m4"]);
  });

  it("names the dependency nodes it is allowed to read", () => {
    const packet = buildContextPacket({
      node,
      messages,
      lastSeenSeq: 4,
      contextSnapshotSeq: 4,
    });
    expect(packet.injectedMessageIds).toEqual([]);
    expect(packet.injectedDependencyNodeIds).toEqual(node.dependsOn);
  });
});

describe("turn prompts", () => {
  const nodes = plannedNodes([
    {
      agent: 3,
      nodeRole: "threat-model",
      instruction: "Review auth and secret boundaries. Do not write code.",
      expectedOutput: "A security review.",
      dependsOn: [],
      area: "none",
      writes: false,
    },
    {
      agent: 1,
      nodeRole: "backend-impl",
      instruction: "Implement the upload endpoint under ./code/apps/server.",
      expectedOutput: "Backend implementation.",
      dependsOn: [0],
      area: "server",
      writes: true,
    },
  ]);

  function prompt(
    node: GroupPlanNode,
    injected: GroupMessage[] = [],
    governedMemory: Parameters<typeof buildTurnPrompt>[0]["governedMemory"] = [],
  ) {
    return buildTurnPrompt({
      taskPrompt: "Plan an upload feature.",
      node,
      agentName: "Backend",
      agentDescription: "backend implementation",
      role: "backend",
      injectedMessages: injected,
      dependencyOutputs: [
        { nodeRole: "threat-model", output: "Validate content length." },
      ],
      agentNames: new Map([
        ["agent-backend", "Backend"],
        ["agent-frontend", "Frontend"],
      ]),
      governedMemory,
    });
  }

  it("shows the node's own planner-written instruction", () => {
    // The whole point of persisting `instruction`: the Agent is told what to
    // do, and the same string is what the Plan tab renders.
    const text = prompt(nodes[1]!);
    expect(text).toContain(
      "Implement the upload endpoint under ./code/apps/server.",
    );
    expect(text).toContain("Expected output: Backend implementation.");
  });

  it("needs no template to produce a complete prompt", () => {
    // No `template` argument is passed anywhere in this suite.
    const text = prompt(nodes[0]!);
    expect(text).toContain("Review auth and secret boundaries.");
    expect(text).not.toContain("Complete this plan node from your role.");
  });

  it("falls back only when a node carries no instruction at all", () => {
    // Rows persisted before the planner landed.
    const legacy: GroupPlanNode = { ...nodes[1]!, instruction: "" };
    expect(prompt(legacy)).toContain("Complete this plan node from your role.");
  });

  it("carries identity, node role, ownership and the shared code location", () => {
    const text = prompt(nodes[1]!);
    expect(text).toContain("You are Backend.");
    expect(text).toContain("Node role: backend-impl");
    expect(text).toContain("code/apps/server/**");
    expect(text).toContain("./code");
    // The stable identity is never replaced by another Agent's identity.
    expect(text).not.toContain("You are Frontend.");
  });

  it("injects active governed memory with its landing semantics", () => {
    const text = prompt(nodes[1]!, [], [
      {
        severity: "severe",
        description: "Upload limit",
        content: "Reject uploads over 10MB.",
      },
      {
        severity: "normal",
        description: "when documenting uploads",
        content: "Mention HTTP 413 in the API guide.",
      },
    ]);
    expect(text).toContain("[Your governed memory]");
    expect(text).toContain("(always apply) Reject uploads over 10MB.");
    expect(text).toContain(
      "(apply when: when documenting uploads) Mention HTTP 413 in the API guide.",
    );
  });

  it("labels injected messages by speaker", () => {
    const text = prompt(nodes[1]!, [
      message(3, "I need the schema", "agent-frontend"),
    ]);
    expect(text).toContain("[New group messages since your last turn]");
    expect(text).toContain("Frontend:");
    expect(text).toContain("I need the schema");
  });

  it("omits the transcript section entirely when nothing is new", () => {
    expect(prompt(nodes[1]!)).not.toContain(
      "[New group messages since your last turn]",
    );
  });

  it("marks a read-only node as read-only", () => {
    const text = prompt(nodes[0]!);
    expect(text).toContain("read-only for this turn");
    expect(text).toContain("Runtime locks: none");
  });
});

describe("the group-task charter", () => {
  it("states the roster and keeps memory out of shared code", () => {
    const charter = buildGroupTaskCharter({
      groupName: "Upload Feature Team",
      taskPrompt: "Plan an upload feature.",
      roster: [
        { name: "Backend", role: "backend" },
        { name: "Frontend", role: "frontend" },
        { name: "Security", role: "security" },
      ],
    });
    expect(charter).toContain("Upload Feature Team");
    expect(charter).toContain("Backend - backend");
    expect(charter).toContain("never written into shared code");
    // It must not rewrite Agent identity -- that belongs to the turn prompt.
    expect(charter).not.toContain("You are");
  });
});
