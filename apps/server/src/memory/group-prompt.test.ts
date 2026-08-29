import { describe, expect, it } from "vitest";
import type { GroupMessage, GroupPlanNode } from "../types.js";
import {
  V1_CHAIN,
  buildChainNodes,
  resolveRole,
  templateFor,
} from "./group-chain.js";
import {
  buildContextPacket,
  buildGroupTaskCharter,
  buildTurnPrompt,
} from "./group-prompt.js";
import type { GroupMember } from "../types.js";

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

describe("the v1 chain template", () => {
  it("is five nodes, sequential, with a single sink", () => {
    const nodes = buildChainNodes("task-1", MEMBERS, "2026-01-01T00:00:00.000Z");
    expect(nodes).toHaveLength(5);
    expect(nodes[0]!.dependsOn).toEqual([]);
    for (let index = 1; index < nodes.length; index += 1) {
      expect(nodes[index]!.dependsOn).toEqual([nodes[index - 1]!.id]);
    }
    const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
    expect(nodes.filter((node) => !dependedOn.has(node.id))).toHaveLength(1);
  });

  it("binds to roles, not to member-list order", () => {
    const shuffled: GroupMember[] = [
      { agentId: "agent-security", role: "security" },
      { agentId: "agent-backend", role: "backend" },
      { agentId: "agent-frontend", role: "frontend" },
    ];
    const ordered = buildChainNodes("t", MEMBERS, "2026-01-01T00:00:00.000Z");
    const scrambled = buildChainNodes("t", shuffled, "2026-01-01T00:00:00.000Z");
    expect(scrambled.map((node) => node.agentId)).toEqual(
      ordered.map((node) => node.agentId),
    );
  });

  it("accumulates ancestors so a node can read every earlier output", () => {
    const nodes = buildChainNodes("t", MEMBERS, "2026-01-01T00:00:00.000Z");
    expect(nodes[0]!.allowedPlanNodeIds).toEqual([]);
    expect(nodes[4]!.allowedPlanNodeIds).toEqual(
      nodes.slice(0, 4).map((node) => node.id),
    );
  });

  it("gives write nodes an ownership area and planning nodes none", () => {
    const nodes = buildChainNodes("t", MEMBERS, "2026-01-01T00:00:00.000Z");
    expect(nodes[0]!.readOnly).toBe(false);
    expect(nodes[0]!.fileOwnershipHints).toEqual(["code/apps/server/**"]);
    expect(nodes[1]!.readOnly).toBe(true);
    expect(nodes[1]!.runtimeLocks).toEqual([]);
    expect(nodes[4]!.fileOwnershipHints).toEqual(["code/apps/web/**"]);
    // The two backend turns own the same area; safe only because the chain is
    // sequential, which is why collision validation is STRETCH.
    expect(nodes[3]!.fileOwnershipHints).toEqual(nodes[0]!.fileOwnershipHints);
  });

  it("rejects a plan with a missing role", () => {
    expect(() => resolveRole(MEMBERS.slice(0, 2), "security")).toThrow(
      "This plan needs one backend, one frontend, and one security member.",
    );
  });

  it("exposes a template for every node role", () => {
    for (const template of V1_CHAIN) {
      expect(templateFor(template.nodeRole)).toBeDefined();
    }
    expect(templateFor("join-plan")).toBeUndefined();
  });
});

describe("context packets", () => {
  const node = buildChainNodes(
    "task-1",
    MEMBERS,
    "2026-01-01T00:00:00.000Z",
  )[3]!;
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
  const nodes = buildChainNodes("task-1", MEMBERS, "2026-01-01T00:00:00.000Z");

  function prompt(node: GroupPlanNode, injected: GroupMessage[] = []) {
    return buildTurnPrompt({
      taskPrompt: "Plan an upload feature.",
      node,
      template: templateFor(node.nodeRole),
      agentName: "Backend",
      agentDescription: "backend implementation",
      role: "backend",
      injectedMessages: injected,
      dependencyOutputs: [
        { nodeRole: "backend-contract", output: "POST /uploads" },
      ],
      agentNames: new Map([
        ["agent-backend", "Backend"],
        ["agent-frontend", "Frontend"],
      ]),
    });
  }

  it("carries identity, node role, ownership and the shared code location", () => {
    const text = prompt(nodes[3]!);
    expect(text).toContain("You are Backend.");
    expect(text).toContain("Node role: backend-impl");
    expect(text).toContain("code/apps/server/**");
    expect(text).toContain("./code");
    expect(text).toContain("Stay");
    // The stable identity is never replaced by another Agent's identity.
    expect(text).not.toContain("You are Frontend.");
  });

  it("labels injected messages by speaker", () => {
    const text = prompt(nodes[3]!, [
      message(3, "I need the schema", "agent-frontend"),
    ]);
    expect(text).toContain("[New group messages since your last turn]");
    expect(text).toContain("Frontend:");
    expect(text).toContain("I need the schema");
  });

  it("omits the transcript section entirely when nothing is new", () => {
    expect(prompt(nodes[3]!)).not.toContain(
      "[New group messages since your last turn]",
    );
  });

  it("marks a read-only node as read-only", () => {
    const text = prompt(nodes[1]!);
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
