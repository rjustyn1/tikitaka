/**
 * "One shared conversation to the user" is the feature's own one-line summary.
 * These tests pin the parts of that sentence a reader can actually see.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentGroup, GroupMessage } from "../types";
import { ConversationPanel } from "./ConversationPanel";

const agents: Agent[] = ["a1", "a2"].map((id, index) => ({
  id,
  name: ["Backend Agent", "Frontend Agent"][index] as string,
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
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function message(
  over: Partial<GroupMessage> & { id: string; seq: number },
): GroupMessage {
  return {
    groupId: "g1",
    speakerType: "agent",
    speakerAgentId: "a1",
    groupTaskId: "t1",
    planNodeId: null,
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderPanel(
  over: Partial<React.ComponentProps<typeof ConversationPanel>> = {},
) {
  return render(
    <ConversationPanel
      messages={[
        message({ id: "m2", seq: 2, content: "Contract agreed." }),
        message({
          id: "m1",
          seq: 1,
          speakerType: "human",
          speakerAgentId: null,
          content: "Ship uploads.",
        }),
      ]}
      agents={agents}
      group={group}
      prompt=""
      onPromptChange={vi.fn()}
      onSubmit={vi.fn()}
      running={false}
      busy={false}
      pendingNotes={[]}
      reviewer="operator"
      busyNoteId={null}
      onReview={vi.fn()}
      onRevoke={vi.fn()}
      {...over}
    />,
  );
}

describe("ConversationPanel", () => {
  it("orders turns by seq, not by arrival", () => {
    renderPanel();
    const turns = screen.getAllByRole("article");
    expect(turns[0]).toHaveTextContent("Ship uploads.");
    expect(turns[1]).toHaveTextContent("Contract agreed.");
  });

  it("names the speaker on an Agent turn and calls the human turn You", () => {
    renderPanel();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Backend Agent")).toBeInTheDocument();
  });

  it("invites a goal when nothing has been said", () => {
    renderPanel({ messages: [] });
    expect(screen.getByText("No conversation yet")).toBeInTheDocument();
  });

  it("submits the goal from the conversation composer", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    renderPanel({ prompt: "Ship uploads", onSubmit });
    await userEvent.click(screen.getByRole("button", { name: "Start task" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("locks the composer while a task is running and says why", () => {
    renderPanel({ running: true });
    expect(
      screen.getByPlaceholderText("A task is already running for this team…"),
    ).toBeDisabled();
  });
});
