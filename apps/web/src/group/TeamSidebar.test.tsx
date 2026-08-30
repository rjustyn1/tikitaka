/**
 * The sidebar is the fix for "Teams have no selector when there is one team", so
 * the single-team case is the case that matters most here.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentGroup } from "../types";
import { TeamSidebar } from "./TeamSidebar";

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

const team: AgentGroup = {
  id: "g1",
  name: "Upload Feature Team",
  description: "Ship the file upload endpoint end to end.",
  members: [
    { agentId: "a1", role: "backend" },
    { agentId: "a2", role: "frontend" },
    { agentId: "a3", role: "security" },
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("TeamSidebar", () => {
  it("lists a single team, so there is always a selector", () => {
    render(
      <TeamSidebar
        groups={[team]}
        agents={agents}
        selectedId="g1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Upload Feature Team/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 members")).toBeInTheDocument();
  });

  it("names every member so the roster is readable without opening the team", () => {
    render(
      <TeamSidebar
        groups={[team]}
        agents={agents}
        selectedId="g1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Upload Feature Team/ }),
    ).toHaveAttribute(
      "title",
      "Backend Agent · Frontend Agent · Security Agent",
    );
  });

  it("selects a team on click", async () => {
    const onSelect = vi.fn();
    const second = { ...team, id: "g2", name: "Payments Team" };
    render(
      <TeamSidebar
        groups={[team, second]}
        agents={agents}
        selectedId="g1"
        onSelect={onSelect}
        onCreate={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Payments Team/ }));
    expect(onSelect).toHaveBeenCalledWith("g2");
  });

  it("invites the first team when there are none", async () => {
    const onCreate = vi.fn();
    render(
      <TeamSidebar
        groups={[]}
        agents={agents}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create a team" }));
    expect(onCreate).toHaveBeenCalled();
  });

  it("does not represent an in-flight request as an empty Teams state", () => {
    render(
      <TeamSidebar
        groups={[]}
        agents={agents}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        loading
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading teams…");
    expect(screen.queryByRole("button", { name: "Create a team" })).not.toBeInTheDocument();
  });

  it("does not represent a failed request as an empty Teams state", () => {
    render(
      <TeamSidebar
        groups={[]}
        agents={agents}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        error="The server is unavailable."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load teams.");
    expect(screen.queryByRole("button", { name: "Create a team" })).not.toBeInTheDocument();
  });
});
