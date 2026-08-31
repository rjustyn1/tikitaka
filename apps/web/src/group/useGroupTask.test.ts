/**
 * The polling hook is the riskiest code on this surface: every failure mode is
 * silent. It either shows an empty memory panel that looks like a broken
 * feature, or it polls forever. Both were real bugs during development, so both
 * are pinned here.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { GroupTaskResponse } from "../types";
import { useGroupTask } from "./useGroupTask";

vi.mock("../api", () => ({
  api: {
    groupTask: vi.fn(),
    notes: vi.fn(),
    taskGrants: vi.fn(),
    agentMemory: vi.fn(),
  },
}));

const mocked = vi.mocked(api);

function response(
  status: GroupTaskResponse["task"]["status"],
  flushedAt: string | null,
): GroupTaskResponse {
  return {
    task: {
      id: "t1",
      groupId: "g1",
      prompt: "Plan an upload feature.",
      sharedCodePath: "/w/shared-code/t1",
      status,
      currentNodeId: null,
      nodeRunIds: [],
      flushedAt,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    },
    nodes: [],
    messages: [],
    contextInjections: [],
  };
}

beforeEach(() => {
  // shouldAdvanceTime lets testing-library's waitFor (which polls on real
  // timers) still make progress while our interval runs on fake ones.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocked.notes.mockResolvedValue({ notes: [] });
  mocked.taskGrants.mockResolvedValue({ grants: [] });
  mocked.agentMemory.mockResolvedValue({ files: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Advance fake timers while letting queued promises settle. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useGroupTask", () => {
  it("keeps polling while the task is queued", async () => {
    // A task is `queued` BEFORE it is `running`. A loop written as
    // `status !== "running"` would stop here on the very first tick.
    mocked.groupTask.mockResolvedValue(response("queued", null));
    renderHook(() => useGroupTask("g1", "t1", []));

    await waitFor(() => expect(mocked.groupTask).toHaveBeenCalled());
    const afterFirst = mocked.groupTask.mock.calls.length;
    await tick(6000);
    expect(mocked.groupTask.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("does not report memory ready on the status flip alone", async () => {
    // memoryReady tracks flushedAt, not status. (Notes ARE fetched every poll
    // now — the intra-task node-drift flush lands them mid-task — so this test
    // only pins the readiness flag, not whether notes were fetched.)
    mocked.groupTask.mockResolvedValue(response("completed", null));
    const { result } = renderHook(() => useGroupTask("g1", "t1", []));

    await waitFor(() => expect(result.current.task).not.toBeNull());
    expect(result.current.memoryReady).toBe(false);
  });

  it("fetches memory once the task reports flushedAt", async () => {
    mocked.groupTask
      .mockResolvedValueOnce(response("completed", null))
      .mockResolvedValue(response("completed", new Date().toISOString()));
    const { result } = renderHook(() => useGroupTask("g1", "t1", ["a1"]));

    await waitFor(() => expect(result.current.task).not.toBeNull());
    expect(result.current.memoryReady).toBe(false);

    await tick(2500);
    await waitFor(() => expect(result.current.memoryReady).toBe(true));
    expect(mocked.notes).toHaveBeenCalled();
    expect(mocked.agentMemory).toHaveBeenCalledWith("a1");
  });

  it("gives up waiting when a flush will never come", async () => {
    // Observed against the real server: when every node fails, decideFlush
    // returns no_completed_runs and flushedAt stays null forever. An unbounded
    // wait polls for the lifetime of the page.
    mocked.groupTask.mockResolvedValue(response("failed", null));
    const { result } = renderHook(() => useGroupTask("g1", "t1", []));

    await waitFor(() => expect(result.current.task).not.toBeNull());
    await tick(2000 * 12);
    await waitFor(() => expect(result.current.flushGaveUp).toBe(true));

    const settled = mocked.groupTask.mock.calls.length;
    await tick(2000 * 5);
    expect(
      mocked.groupTask.mock.calls.length,
      "polling must stop once it has given up",
    ).toBe(settled);
  });

  it("stops polling once terminal and flushed", async () => {
    mocked.groupTask.mockResolvedValue(
      response("completed", new Date().toISOString()),
    );
    const { result } = renderHook(() => useGroupTask("g1", "t1", []));

    await waitFor(() => expect(result.current.memoryReady).toBe(true));
    const settled = mocked.groupTask.mock.calls.length;
    await tick(2000 * 4);
    expect(mocked.groupTask.mock.calls.length).toBe(settled);
  });

  it("surfaces a fetch failure instead of hanging", async () => {
    mocked.groupTask.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useGroupTask("g1", "t1", []));
    await waitFor(() => expect(result.current.error).toBe("network down"));
    expect(result.current.loading).toBe(false);
  });
});
