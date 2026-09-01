import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Agent, AgentGroup } from "../types";
import { WorkspaceExplorer } from "./WorkspaceExplorer";

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/workspaces/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const agents: Agent[] = [
  agent("agent-1", "Backend Agent"),
  agent("agent-2", "Security Agent"),
];

const group: AgentGroup = {
  id: "group-1",
  name: "Demo team",
  description: "",
  members: [
    { agentId: "agent-1", role: "backend" },
    { agentId: "agent-2", role: "security" },
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const maximize = () =>
  fireEvent.click(screen.getByRole("button", { name: "Maximize workspace explorer" }));

const view = () =>
  render(<WorkspaceExplorer group={group} agents={agents} refreshKey="no-task:idle" />);

describe("WorkspaceExplorer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists shared files as a directory tree, not one flat level", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({
      files: [
        { path: "apps/web/src/UploadWidget.tsx", size: 24 },
        { path: "apps/server/src/routes/uploads.ts", size: 30 },
      ],
    });
    const readFile = vi.spyOn(api, "groupCodebaseFile");

    view();

    // The shared parent is rebuilt, and each single-child chain folds into it.
    await waitFor(() => expect(screen.getByText("apps/")).toBeInTheDocument());
    expect(screen.getByText("server/src/routes/uploads.ts")).toBeInTheDocument();
    expect(screen.getByText("web/src/UploadWidget.tsx")).toBeInTheDocument();
    // The rail is a listing: nothing here opens a file.
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not read file contents until it is maximized", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({
      files: [{ path: "src/api.ts", size: 24 }],
    });
    const readFile = vi
      .spyOn(api, "groupCodebaseFile")
      .mockResolvedValue({ path: "src/api.ts", content: "export const ok = true;\n" });

    view();
    await waitFor(() => expect(screen.getByText("src/api.ts")).toBeInTheDocument());
    expect(readFile).not.toHaveBeenCalled();

    maximize();

    await waitFor(() => {
      expect(screen.getByText("export const ok = true;")).toBeInTheDocument();
    });
    expect(readFile).toHaveBeenCalledWith("group-1", "src/api.ts");
  });

  it("closes the viewer on Escape", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({
      files: [{ path: "src/api.ts", size: 24 }],
    });
    vi.spyOn(api, "groupCodebaseFile").mockResolvedValue({
      path: "src/api.ts",
      content: "ok",
    });

    view();
    await waitFor(() => expect(screen.getByText("src/api.ts")).toBeInTheDocument());
    maximize();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /**
   * The demo's load-bearing claim: a note reaches an Agent because a file was
   * placed in its workspace. Both members are on screen at once so the holder
   * and the withheld Agent can be compared without switching views.
   */
  it("shows every member's granted-skill count side by side", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({ files: [] });
    vi.spyOn(api, "groupAgentWorkspaceFile").mockResolvedValue({
      path: "AGENTS.md",
      content: "# Platform-managed Agent instructions\n",
    });
    vi.spyOn(api, "groupAgentWorkspace").mockImplementation(async (_group, agentId) =>
      agentId === "agent-1"
        ? {
            files: [
              { path: "AGENTS.md", size: 24, kind: "instructions" as const },
              { path: ".agents/skills/memory-auth/SKILL.md", size: 18, kind: "skill" as const },
            ],
          }
        : { files: [{ path: "AGENTS.md", size: 24, kind: "instructions" as const }] },
    );

    view();
    fireEvent.click(screen.getByRole("button", { name: "Agent skills" }));

    // The holder shows a count; the withheld Agent reads "none", not "0".
    await waitFor(() => {
      expect(screen.getByTitle(/1 granted skill file/)).toHaveTextContent("Backend Agent");
    });
    const withheld = screen.getByTitle("No governed memory has been granted to this Agent");
    expect(withheld).toHaveTextContent("Security Agent");
    expect(withheld).toHaveTextContent("none");
  });

  it("does not report a failed listing as a withheld Agent", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({ files: [] });
    vi.spyOn(api, "groupAgentWorkspaceFile").mockResolvedValue({ path: "AGENTS.md", content: "" });
    vi.spyOn(api, "groupAgentWorkspace").mockImplementation(async (_group, agentId) => {
      if (agentId === "agent-2") throw new Error("workspace unreadable");
      return { files: [{ path: "AGENTS.md", size: 24, kind: "instructions" as const }] };
    });

    view();
    fireEvent.click(screen.getByRole("button", { name: "Agent skills" }));

    await waitFor(() => {
      expect(
        screen.getByTitle("No governed memory has been granted to this Agent"),
      ).toHaveTextContent("Backend Agent");
    });
    // An unreadable workspace is an unknown, and must not read as "withheld".
    const unknown = screen.getByTitle("Skill count unavailable");
    expect(unknown).toHaveTextContent("Security Agent");
    expect(unknown).not.toHaveTextContent("none");
  });

  it("diffs the governed block approval added to AGENTS.md", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({ files: [] });
    vi.spyOn(api, "groupAgentWorkspace").mockResolvedValue({
      files: [{ path: "AGENTS.md", size: 90, kind: "instructions" }],
    });
    vi.spyOn(api, "groupAgentWorkspaceFile").mockResolvedValue({
      path: "AGENTS.md",
      content:
        "# Platform-managed Agent instructions\n<!-- memory:note-1 -->\nKeys are namespaced by tenant.\n<!-- /memory:note-1 -->\n",
    });

    view();
    fireEvent.click(screen.getByRole("button", { name: "Agent skills" }));
    await waitFor(() => expect(screen.getByText("AGENTS.md")).toBeInTheDocument());
    maximize();

    await waitFor(() => {
      expect(screen.getByLabelText("Governed memory diff")).toBeInTheDocument();
    });
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(screen.getByText(/the rest is the Agent's own file/)).toBeInTheDocument();
  });

  it("offers no diff for an AGENTS.md nothing was approved into", async () => {
    vi.spyOn(api, "groupCodebase").mockResolvedValue({ files: [] });
    vi.spyOn(api, "groupAgentWorkspace").mockResolvedValue({
      files: [{ path: "AGENTS.md", size: 40, kind: "instructions" }],
    });
    vi.spyOn(api, "groupAgentWorkspaceFile").mockResolvedValue({
      path: "AGENTS.md",
      content: "# Platform-managed Agent instructions\nYou are the Backend Agent.\n",
    });

    view();
    fireEvent.click(screen.getByRole("button", { name: "Agent skills" }));
    await waitFor(() => expect(screen.getByText("AGENTS.md")).toBeInTheDocument());
    maximize();

    await waitFor(() => {
      expect(screen.getByText(/No governed memory in this file/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Diff" })).not.toBeInTheDocument();
  });
});
