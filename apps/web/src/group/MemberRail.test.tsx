/**
 * The rail is where the product's claim becomes a person-shaped thing: this
 * Agent, this role, this step, exactly this memory. Each of those is pinned
 * here, including the two ways an empty rail can lie — a revoked file counted as
 * held, and a failed fetch rendered as an empty workspace.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentGroup,
  GroupPlanNode,
  LandedMemoryFile,
} from "../types";
import { MemberRail } from "./MemberRail";

const agents: Agent[] = ["a1", "a2", "a3"].map((id, index) => ({
  id,
  name: ["Backend Agent", "Frontend Agent", "Security Agent"][index] as string,
  description: "",
  instructions: "",
  status: "ready" as const,
  workspacePath: "/w/" + id,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

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

const runningNode: GroupPlanNode = {
  id: "n1",
  groupTaskId: "t1",
  agentId: "a1",
  kind: "work",
  nodeRole: "backend-contract",
  dependsOn: [],
  contextSnapshotSeq: 0,
  allowedPlanNodeIds: [],
  status: "running",
  runId: "r1",
  output: null,
  error: null,
  readOnly: false,
  fileOwnershipHints: [],
  runtimeLocks: [],
  expectedOutput: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
};

const file: LandedMemoryFile = {
  id: "f1",
  noteId: "note1",
  agentId: "a2",
  kind: "skill",
  path: "/w/a2/.agents/skills/upload-contract/SKILL.md",
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
};

function renderRail(
  over: Partial<React.ComponentProps<typeof MemberRail>> = {},
) {
  return render(
    <MemberRail
      group={group}
      agents={agents}
      nodes={[runningNode]}
      taskStatus="running"
      memory={{ a2: [file] }}
      pendingNotes={[]}
      onReviewNote={() => undefined}
      memoryLoading={false}
      memoryFailed={false}
      onOpenTrace={vi.fn()}
      {...over}
    />,
  );
}

describe("MemberRail", () => {
  it("shows every member with name and role", () => {
    renderRail();
    expect(screen.getByText("Backend Agent")).toBeInTheDocument();
    expect(screen.getByText("Frontend Agent")).toBeInTheDocument();
    expect(screen.getByText("Security Agent")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
  });

  it("reports the live step for the Agent that is running", () => {
    renderRail();
    expect(screen.getByText("Running backend-contract")).toBeInTheDocument();
  });

  it("names the memory an Agent holds, and says plainly when it holds none", () => {
    renderRail();
    expect(screen.getByText("upload-contract/SKILL.md")).toBeInTheDocument();
    expect(screen.getAllByText("Holds no governed memory")).toHaveLength(2);
  });

  it("does not count a revoked file as held", () => {
    renderRail({
      memory: { a2: [{ ...file, removedAt: "2026-01-02T00:00:00.000Z" }] },
    });
    expect(screen.getAllByText("Holds no governed memory")).toHaveLength(3);
  });

  it("says the memory state is unavailable rather than implying an empty workspace", () => {
    renderRail({ memory: {}, memoryFailed: true });
    expect(screen.getAllByText("Memory state unavailable")).toHaveLength(3);
    expect(
      screen.queryByText("Holds no governed memory"),
    ).not.toBeInTheDocument();
  });
});

describe("MemberRail outstanding approvals", () => {
  const pending = {
    id: "note-1",
    groupTaskId: "task-1",
    groupId: "g1",
    content: "Keys are namespaced by tenant.",
    severity: "severe" as const,
    status: "pending" as const,
    targetAgentIds: ["a2"],
    description: "Storage key layout",
    sourceRunIds: [],
    sourceSpanIds: [],
    rationale: "",
    redactionFired: false,
    quarantineHit: false,
    safetyReasons: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("lists what an Agent is waiting on, and opens the review", () => {
    const onReviewNote = vi.fn();
    renderRail({ pendingNotes: [pending], onReviewNote });

    expect(screen.getByText("Waiting for you · 1")).toBeInTheDocument();
    expect(screen.getByText("Storage key layout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReviewNote).toHaveBeenCalledWith(pending);
  });

  it("shows nothing waiting on an Agent the note is not routed to", () => {
    // The note targets a2; a1 must not be told it has something to approve.
    renderRail({ pendingNotes: [{ ...pending, targetAgentIds: ["a1"] }] });
    const cards = document.querySelectorAll(".member-card");
    const withPending = [...cards].filter((card) =>
      card.querySelector(".member-pending"),
    );
    expect(withPending).toHaveLength(1);
  });
});
