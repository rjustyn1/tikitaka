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

  it("requires at least two members", () => {
    renderEditor();
    const submit = screen.getByRole("button", { name: "Create team" });
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Upload Feature Team" },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
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

  it("offers no role picker at all", () => {
    // The label is derived from the Agent, so there is nothing to choose. A
    // picker would let a "Security Agent" be saved as `frontend`, which then
    // drove the wrong colour dot everywhere it was shown.
    renderEditor();
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    expect(screen.queryByLabelText("Role for Backend Agent")).toBeNull();
    expect(document.querySelector("select")).toBeNull();
  });

  it("derives each label from the Agent it is on", () => {
    const onSubmit = renderEditor();
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("checkbox")[2] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    // "Security Agent" cannot be submitted as anything but `security`.
    expect(onSubmit.mock.calls[0]?.[0].members).toEqual([
      { agentId: "a1", role: "backend" },
      { agentId: "a3", role: "security" },
    ]);
  });

  it("defaults an Agent whose name is not one of the three", () => {
    // "Ops Agent" derives to "ops", which is not offered, so it starts on the
    // first option rather than being added as a fourth.
    const onSubmit = vi.fn();
    // Two candidates: a team needs MIN_MEMBERS, and the Ops Agent is still the
    // one under test for role derivation.
    renderEditor(onSubmit, [agent("a4", "Ops Agent"), agent("a1", "Backend Agent")]);
    fireEvent.change(screen.getByPlaceholderText("Upload Feature Team"), {
      target: { value: "Team" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(onSubmit.mock.calls[0]?.[0].members).toEqual([
      { agentId: "a4", role: "backend" },
      { agentId: "a1", role: "backend" },
    ]);
  });

  it("re-derives a stored label instead of trusting it", () => {
    // Saved rows may carry a legacy label ("member") or one that contradicts
    // the Agent ("Security Agent" stored as frontend). Both are re-derived, so
    // the roster cannot stay out of step with the Agents it names.
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
      { agentId: "a3", role: "security" },
      { agentId: "a2", role: "frontend" },
    ]);
  });



  it("caps membership at the server's limit of eight Agents", () => {
    // The cap must match MAX_GROUP_MEMBERS on the server. When the UI allowed
    // twelve, picking a ninth Agent produced a roster the API rejected with
    // "A group needs between 2 and 8 members".
    const candidates = Array.from({ length: 9 }, (_, index) =>
      agent("a" + index, "Agent " + index),
    );
    renderEditor(vi.fn(), candidates);
    const boxes = screen.getAllByRole("checkbox");
    for (const box of boxes.slice(0, 8)) fireEvent.click(box);
    expect(boxes[8]).toBeDisabled();
    // The denominator is the Agents available (9); the cap is called out
    // separately, and only once it actually binds.
    expect(screen.getByText(/8 of 9 selected/)).toBeInTheDocument();
    expect(screen.getByText(/\(max 8\)/)).toBeInTheDocument();
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

  it("treats a two-member team as valid", () => {
    // Recognition raised the floor to MIN_MEMBERS: routing needs somewhere to
    // route. One member is an incomplete team, two is complete.
    renderEditor();
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    fireEvent.click(screen.getAllByRole("checkbox")[1]!);
    const counter = screen.getByText(/2 of 4 selected/);
    expect(counter.className).toContain("roster-ok");
    expect(counter.className).not.toContain("roster-missing");
  });

  it("flags a roster below the minimum", () => {
    renderEditor();
    expect(screen.getByText(/0 of 4 selected/).className).toContain(
      "roster-missing",
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByText(/1 of 4 selected/).className).toContain(
      "roster-missing",
    );
  });
});
