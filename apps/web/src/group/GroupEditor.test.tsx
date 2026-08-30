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

function renderEditor(onSubmit = vi.fn(), candidates = agents) {
  render(
    <GroupEditor
      agents={candidates}
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

  it("accepts a named team with one member", () => {
    renderEditor();
    const submit = screen.getByRole("button", { name: "Create team" });
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Upload Feature Team" },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    expect(submit).toBeEnabled();
  });

  it("submits the server membership shape with free-form labels", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Upload Feature Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Role for Backend Agent"), {
      target: { value: "API owner" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "Upload Feature Team",
      description: "",
      members: [
        { agentId: "a1", role: "API owner" },
        { agentId: "a2", role: "member" },
      ],
    });
  });

  it("normalizes an empty selected label to member", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Role for Backend Agent"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(onSubmit.mock.calls[0]?.[0].members).toEqual([
      { agentId: "a1", role: "member" },
    ]);
  });

  it("caps membership at twelve Agents", () => {
    const candidates = Array.from({ length: 13 }, (_, index) =>
      agent("a" + index, "Agent " + index),
    );
    renderEditor(vi.fn(), candidates);
    const boxes = screen.getAllByRole("checkbox");
    for (const box of boxes.slice(0, 12)) fireEvent.click(box);
    expect(boxes[12]).toBeDisabled();
    expect(screen.getByText("12 of 12 selected")).toBeInTheDocument();
  });
});
