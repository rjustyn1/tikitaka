import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Agent, AgentGroup } from "../types";
import { GroupWorkspace } from "./GroupWorkspace";
import { useAgentMemory } from "./useAgentMemory";
import { useGroupTask } from "./useGroupTask";

vi.mock("./useAgentMemory", () => ({ useAgentMemory: vi.fn() }));
vi.mock("./useGroupTask", () => ({ useGroupTask: vi.fn() }));

const useAgentMemoryMock = vi.mocked(useAgentMemory);
const useGroupTaskMock = vi.mocked(useGroupTask);

const agents: Agent[] = [
  {
    id: "a1",
    name: "Backend Agent",
    description: "Builds the API.",
    instructions: "",
    status: "ready",
    workspacePath: "/w/a1",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const activeGroup: AgentGroup = {
  id: "g1",
  name: "Upload Feature Team",
  description: "",
  members: [{ agentId: "a1", role: "backend" }],
  activeTaskId: "task-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const idleGroup: AgentGroup = {
  ...activeGroup,
  id: "g2",
  name: "Payments Team",
  activeTaskId: null,
};

function workspaceProps(over: Partial<React.ComponentProps<typeof GroupWorkspace>> = {}) {
  return {
    agents,
    onOpenTrace: vi.fn(),
    groups: [activeGroup, idleGroup],
    selectedGroupId: "g1",
    onSelectGroup: vi.fn(),
    onRefreshGroups: vi.fn().mockResolvedValue(undefined),
    groupsLoading: false,
    groupsError: null,
    createRequested: false,
    onCreateHandled: vi.fn(),
    ...over,
  };
}

describe("GroupWorkspace", () => {
  beforeEach(() => {
    useGroupTaskMock.mockReturnValue({
      task: null,
      notes: [],
      grants: [],
      memoryByAgent: {},
      memoryReady: false,
      loading: false,
      error: null,
      flushGaveUp: false,
      refresh: vi.fn(),
      refreshMemory: vi.fn(),
    });
    useAgentMemoryMock.mockReturnValue({
      memory: {},
      loading: false,
      failed: false,
    });
    vi.spyOn(api, "listGroupTasks").mockResolvedValue({ tasks: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the old task before loading an idle team", async () => {
    const initial = workspaceProps();
    const { rerender } = render(<GroupWorkspace {...initial} />);

    await waitFor(() => {
      expect(useGroupTaskMock).toHaveBeenLastCalledWith("g1", "task-1", ["a1"]);
    });

    rerender(
      <GroupWorkspace
        {...workspaceProps({ selectedGroupId: "g2" })}
      />,
    );

    await waitFor(() => {
      expect(useGroupTaskMock).toHaveBeenLastCalledWith("g2", null, ["a1"]);
    });
  });

  it("renders a failed group query instead of an empty Teams workspace", () => {
    render(
      <GroupWorkspace
        {...workspaceProps({
          groups: [],
          selectedGroupId: null,
          groupsError: "The server is unavailable.",
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not load Teams");
    expect(screen.getByText("The server is unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Create your first team")).not.toBeInTheDocument();
  });
});
