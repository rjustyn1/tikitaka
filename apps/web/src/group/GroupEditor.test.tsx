/**
 * Render tests for the group editor.
 *
 * These assert the behaviour the design docs call for by name, not
 * implementation detail: nothing selected by default (membership is a
 * governance boundary), exactly one Agent per role, and no submit until the
 * plan can actually be built.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../types";
import { GroupEditor } from "./GroupEditor";

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: name + " work",
    instructions: "",
    status: "ready",
    workspacePath: "/w/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const agents = [
  agent("a1", "Backend Agent"),
  agent("a2", "Frontend Agent"),
  agent("a3", "Security Agent"),
  agent("a4", "Ops Agent"),
];

function renderEditor(onSubmit = vi.fn()) {
  render(
    <GroupEditor
      agents={agents}
      group={null}
      busy={false}
      onCancel={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe("GroupEditor", () => {
  it("starts with no Agent selected", () => {
    renderEditor();
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).not.toBeChecked();
    }
  });

  it("cannot submit until all three roles are filled", () => {
    renderEditor();
    const submit = screen.getByRole("button", { name: "Create team" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Upload Feature Team" },
    });
    expect(submit, "a name alone is not enough").toBeDisabled();

    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement);
    expect(submit, "one member is not enough").toBeDisabled();
    fireEvent.click(boxes[1] as HTMLElement);
    expect(submit, "two members are not enough").toBeDisabled();
    fireEvent.click(boxes[2] as HTMLElement);
    expect(submit).toBeEnabled();
  });

  it("names the roles still missing", () => {
    renderEditor();
    expect(screen.getByText(/still need: backend, frontend, security/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    expect(screen.getByText(/still need: frontend, security/)).toBeTruthy();
  });

  it("submits one member per role, in the A4 shape", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Upload Feature Team" },
    });
    const boxes = screen.getAllByRole("checkbox");
    for (const index of [0, 1, 2]) {
      fireEvent.click(boxes[index] as HTMLElement);
    }
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const input = onSubmit.mock.calls[0]?.[0] as {
      name: string;
      members: { agentId: string; role: string }[];
    };
    expect(input.name).toBe("Upload Feature Team");
    expect(input.members).toHaveLength(3);
    expect(new Set(input.members.map((m) => m.role))).toEqual(
      new Set(["backend", "frontend", "security"]),
    );
    expect(new Set(input.members.map((m) => m.agentId))).toEqual(
      new Set(["a1", "a2", "a3"]),
    );
  });

  it("moves a role rather than letting two Agents hold it", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    const boxes = screen.getAllByRole("checkbox");
    for (const index of [0, 1, 2]) {
      fireEvent.click(boxes[index] as HTMLElement);
    }
    // Hand "backend" to the Agent that currently holds "frontend".
    const frontendRow = screen.getByLabelText("Role for Frontend Agent");
    fireEvent.click(
      frontendRow.querySelector("button:nth-child(1)") as HTMLElement,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    // Still exactly three, still one per role -- the old backend holder was
    // dropped rather than duplicating the role.
    const input = onSubmit.mock.calls[0]?.[0] as {
      members: { agentId: string; role: string }[];
    };
    const roles = input.members.map((m) => m.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("previews the chain the team will run once it is valid", () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    const boxes = screen.getAllByRole("checkbox");
    for (const index of [0, 1, 2]) {
      fireEvent.click(boxes[index] as HTMLElement);
    }
    expect(screen.getByText("The plan this team will run")).toBeTruthy();
    // Five steps: Backend and Frontend each take two turns.
    expect(screen.getByRole("list").querySelectorAll("li")).toHaveLength(5);
  });
});
