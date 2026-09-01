import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Agent, MemoryNote } from "../types";
import { ReviewDialog } from "./ReviewDialog";

const agents: Agent[] = [
  {
    id: "agent-1",
    name: "Backend Agent",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/w/agent-1",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const note: MemoryNote = {
  id: "note-1",
  groupTaskId: "task-1",
  groupId: "group-1",
  content: "Keys are namespaced by tenant.",
  severity: "severe",
  status: "pending",
  targetAgentIds: ["agent-1"],
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

function open(overrides: Partial<Parameters<typeof ReviewDialog>[0]> = {}) {
  return render(
    <ReviewDialog
      note={note}
      agents={agents}
      reviewer="operator"
      busy={false}
      onReview={() => undefined}
      onClose={() => undefined}
      {...overrides}
    />,
  );
}

describe("ReviewDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A modified file needs both sides; that is the whole point of the pane. */
  it("shows before and after panes for a modified file", async () => {
    vi.spyOn(api, "notePreview").mockResolvedValue({
      files: [
        {
          agentId: "agent-1",
          path: "/w/agent-1/AGENTS.md",
          kind: "agents_md",
          mode: "modify",
          before: "# Instructions\n",
          after: "# Instructions\n## Governed Memories\n- Keys are namespaced.\n",
        },
      ],
    });

    open();

    await waitFor(() => expect(screen.getByText("Before")).toBeInTheDocument());
    expect(screen.getByText(/After · \+2/)).toBeInTheDocument();
    expect(screen.getByText("modified")).toBeInTheDocument();
  });

  /**
   * A file that does not exist has no "before". Rendering an empty left pane
   * would invite the reader to compare against something that was never there.
   */
  it("shows a single pane for a new file", async () => {
    vi.spyOn(api, "notePreview").mockResolvedValue({
      files: [
        {
          agentId: "agent-1",
          path: "/w/agent-1/.agents/skills/keys/SKILL.md",
          kind: "skill",
          mode: "create",
          before: "",
          after: "---\nname: keys\n---\n",
        },
      ],
    });

    open();

    await waitFor(() => expect(screen.getByText("new file")).toBeInTheDocument());
    expect(screen.queryByText("Before")).not.toBeInTheDocument();
    expect(screen.getByText(/New file · 3 lines/)).toBeInTheDocument();
  });

  it("approves with the reviewer's name", async () => {
    vi.spyOn(api, "notePreview").mockResolvedValue({
      files: [
        {
          agentId: "agent-1",
          path: "/w/agent-1/AGENTS.md",
          kind: "agents_md",
          mode: "modify",
          before: "a\n",
          after: "a\nb\n",
        },
      ],
    });
    const onReview = vi.fn();

    open({ onReview });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve and write/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Approve and write/ }));

    expect(onReview).toHaveBeenCalledWith("note-1", {
      type: "approve",
      reviewerName: "operator",
    });
  });

  /** The ledger records why a note was refused, so a bare reject is blocked. */
  it("requires a reason before rejecting", async () => {
    vi.spyOn(api, "notePreview").mockResolvedValue({ files: [] });
    const onReview = vi.fn();

    open({ onReview });
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Rejection reason"), {
      target: { value: "not durable" },
    });
    fireEvent.click(reject);

    expect(onReview).toHaveBeenCalledWith("note-1", {
      type: "reject",
      reviewerName: "operator",
      reason: "not durable",
    });
  });

  it("cannot approve a note that would write nothing", async () => {
    vi.spyOn(api, "notePreview").mockResolvedValue({ files: [] });
    open();
    await waitFor(() =>
      expect(screen.getByText(/no recipients/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Approve and write/ })).toBeDisabled();
  });
});
