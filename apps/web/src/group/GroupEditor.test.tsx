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

  it("submits the server membership shape, defaulting each label from the Agent", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Upload Feature Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));

    // Derived, not typed: a label can no longer contradict the Agent it is on.
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Upload Feature Team",
      description: "",
      members: [
        { agentId: "a1", role: "backend" },
        { agentId: "a2", role: "frontend" },
      ],
    });
  });

  it("offers exactly three role labels, and no free text", () => {
    renderEditor();
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    const picker = screen.getByLabelText("Role for Backend Agent");
    expect(
      [...(picker as HTMLSelectElement).options].map((option) => option.value),
    ).toEqual(["backend", "frontend", "security"]);
  });

  it("lets a label be changed, and submits the change", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.change(screen.getByLabelText("Role for Backend Agent"), {
      target: { value: "security" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(onSubmit.mock.calls[0]?.[0].members).toEqual([
      { agentId: "a1", role: "security" },
    ]);
  });

  it("defaults an Agent whose name is not one of the three", () => {
    // "Ops Agent" derives to "ops", which is not offered, so it starts on the
    // first option rather than being added as a fourth.
    const onSubmit = vi.fn();
    renderEditor(onSubmit, [agent("a4", "Ops Agent")]);
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(onSubmit.mock.calls[0]?.[0].members).toEqual([
      { agentId: "a4", role: "backend" },
    ]);
  });

  it("keeps a stored label, and clamps one outside the three", () => {
    // An edit form shows what is actually saved: a3 stays "frontend" so the
    // human can see it and change it. A legacy label outside the three has no
    // option to sit on, so it is clamped to the Agent's own default.
    const onSubmit = vi.fn();
    render(
      <GroupEditor
        agents={agents}
        group={{
          id: "g1",
          name: "TIKITAKA",
          description: "Building a todo website",
          members: [
            { agentId: "a3", role: "frontend" },
            { agentId: "a2", role: "member" },
          ],
          activeTaskId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }}
        busy={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save team" }));
    expect(onSubmit.mock.calls[0]?.[0].members).toEqual([
      { agentId: "a3", role: "frontend" },
      { agentId: "a2", role: "frontend" },
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
    // The denominator is the Agents available (13); the cap is called out
    // separately, and only once it actually binds.
    expect(screen.getByText(/12 of 13 selected/)).toBeInTheDocument();
    expect(screen.getByText(/\(max 12\)/)).toBeInTheDocument();
  });
});

describe("the member counter", () => {
  it("counts against the Agents available, not the cap", () => {
    // "3 of 12 selected" beside four Agents read as though eight were missing.
    renderEditor();
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByText(/1 of 4 selected/)).toBeInTheDocument();
    expect(screen.queryByText(/of 12 selected/)).not.toBeInTheDocument();
  });

  it("treats a single-member team as valid, not as missing two", () => {
    // The old exactly-three rule is gone; one member is a complete team.
    renderEditor();
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    const counter = screen.getByText(/1 of 4 selected/);
    expect(counter.className).toContain("roster-ok");
    expect(counter.className).not.toContain("roster-missing");
  });

  it("flags only an empty roster", () => {
    renderEditor();
    expect(screen.getByText(/0 of 4 selected/).className).toContain(
      "roster-missing",
    );
  });
});
