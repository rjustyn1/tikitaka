/**
 * Panel render tests.
 *
 * These pin the claims the panels make on screen. Two of them are honesty
 * constraints rather than features: the context viewer must not call transcript
 * de-duplication a governance decision, and the workspace view must show an
 * outsider holding nothing rather than implying it was told to keep a secret.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentGroup,
  GrantRecord,
  GroupContextInjection,
  GroupPlanNode,
  LandedMemoryFile,
} from "../types";
import { ContextPanel, LandedMemoryPanel, LedgerPanel } from "./panels";

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/w/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const backend = agent("a1", "Backend Agent");
const frontend = agent("a2", "Frontend Agent");
const security = agent("a3", "Security Agent");
const ops = agent("a4", "Ops Agent");
const agents = [backend, frontend, security, ops];

const group: AgentGroup = {
  id: "g1",
  name: "Upload Feature Team",
  description: "",
  members: [
    { agentId: "a1", role: "backend" },
    { agentId: "a2", role: "frontend" },
    { agentId: "a3", role: "security" },
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("LedgerPanel", () => {
  const grants: GrantRecord[] = [
    {
      id: "gr1",
      groupTaskId: "t1",
      noteId: "n1",
      agentId: "a1",
      decision: "granted",
      reason: "targeted",
      filePath: "/w/a1/.agents/skills/upload-contract/SKILL.md",
      reviewerName: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "gr2",
      groupTaskId: "t1",
      noteId: "n1",
      agentId: "a4",
      decision: "withheld",
      reason: "out_of_group",
      filePath: null,
      reviewerName: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  it("shows the denial, not just the grant", () => {
    render(<LedgerPanel grants={grants} agents={agents} />);
    // Scope to the table body: "granted" also appears in the summary above it.
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("granted");
    expect(rows[1]).toHaveTextContent("withheld");
  });

  it("names Agents rather than printing raw UUIDs", () => {
    render(<LedgerPanel grants={grants} agents={agents} />);
    expect(screen.getByText("Backend Agent")).toBeInTheDocument();
    expect(screen.getByText("Ops Agent")).toBeInTheDocument();
    expect(screen.queryByText("a1")).not.toBeInTheDocument();
  });

  it("explains a withholding reason in plain language", () => {
    render(<LedgerPanel grants={grants} agents={agents} />);
    expect(screen.getByText("not a member of this group")).toBeInTheDocument();
    expect(screen.queryByText("out_of_group")).not.toBeInTheDocument();
  });

  it("says plainly when no file was written", () => {
    render(<LedgerPanel grants={grants} agents={agents} />);
    expect(screen.getByText("no file written")).toBeInTheDocument();
  });
});

describe("ContextPanel", () => {
  const nodes = [
    {
      id: "n1",
      groupTaskId: "t1",
      agentId: "a1",
      kind: "work",
      nodeRole: "backend-contract",
      dependsOn: [],
      contextSnapshotSeq: 1,
      allowedPlanNodeIds: [],
      status: "completed",
      runId: "r1",
      output: "done",
      error: null,
      readOnly: false,
      fileOwnershipHints: [],
      runtimeLocks: [],
      expectedOutput: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
    } satisfies GroupPlanNode,
  ];
  const injections: GroupContextInjection[] = [
    {
      id: "i1",
      groupTaskId: "t1",
      planNodeId: "n1",
      agentId: "a1",
      fromSeqExclusive: 0,
      toSeqInclusive: 2,
      injectedMessageIds: ["m1", "m2"],
      injectedDependencyNodeIds: [],
      withheldMessageIds: ["m0"],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  it('labels de-duplicated messages "Already seen", never "withheld"', () => {
    // In a sequential chain nothing is withheld by policy -- every node
    // legitimately sees all prior output. Calling dedupe "withheld" would
    // misrepresent the system to anyone reading this screen.
    render(
      <ContextPanel injections={injections} nodes={nodes} agents={agents} />,
    );
    expect(screen.getByText("Already seen")).toBeInTheDocument();
    expect(screen.queryByText(/^Withheld$/i)).not.toBeInTheDocument();
  });

  it("points at the ledger for actual governance decisions", () => {
    render(
      <ContextPanel injections={injections} nodes={nodes} agents={agents} />,
    );
    expect(screen.getByText(/grant ledger/)).toBeInTheDocument();
  });
});

describe("LandedMemoryPanel", () => {
  const memoryByAgent: Record<string, LandedMemoryFile[]> = {
    a1: [
      {
        id: "f1",
        noteId: "n1",
        agentId: "a1",
        kind: "skill",
        path: "/w/a1/.agents/skills/upload-contract/SKILL.md",
        createdAt: "2026-01-01T00:00:00.000Z",
        removedAt: null,
      },
    ],
    a4: [],
  };

  it("shows a member holding its landed file", () => {
    render(
      <LandedMemoryPanel
        group={group}
        agents={agents}
        memoryByAgent={memoryByAgent}
      />,
    );
    expect(screen.getByText("Backend Agent")).toBeInTheDocument();
    expect(screen.getByText(/upload-contract/)).toBeInTheDocument();
  });

  it("shows the non-member holding nothing, and says why that matters", () => {
    render(
      <LandedMemoryPanel
        group={group}
        agents={agents}
        memoryByAgent={memoryByAgent}
      />,
    );
    expect(screen.getByText("not a member")).toBeInTheDocument();
    // Frontend and Security are members but were not targeted, so they show the
    // same empty state. The message is per-workspace, not per-outsider.
    expect(
      screen.getAllByText(/no governed memory\. Nothing was written here/).length,
    ).toBeGreaterThan(0);
  });

  it("hides a revoked file, because presence is the enforcement state", () => {
    render(
      <LandedMemoryPanel
        group={group}
        agents={agents}
        memoryByAgent={{
          a1: [
            {
              ...(memoryByAgent.a1 as LandedMemoryFile[])[0]!,
              removedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(screen.queryByText(/upload-contract/)).not.toBeInTheDocument();
  });
});

describe("ledger reason wording", () => {
  it("does not echo the decision back as its own reason", async () => {
    const { withheldReason } = await import("./format");
    expect(withheldReason("granted")).not.toBe("granted");
    expect(withheldReason("granted")).toContain("routed");
  });
});
