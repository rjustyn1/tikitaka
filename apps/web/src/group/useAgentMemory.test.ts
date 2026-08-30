import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { LandedMemoryFile } from "../types";
import { useAgentMemory } from "./useAgentMemory";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function file(agentId: string): LandedMemoryFile {
  return {
    id: "file-" + agentId,
    noteId: "note-" + agentId,
    agentId,
    kind: "skill",
    path: "/w/" + agentId + "/.agents/skills/example/SKILL.md",
    createdAt: "2026-01-01T00:00:00.000Z",
    removedAt: null,
  };
}

describe("useAgentMemory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores a slow response from a team that is no longer selected", async () => {
    const first = deferred<{ files: LandedMemoryFile[] }>();
    const second = deferred<{ files: LandedMemoryFile[] }>();
    vi.spyOn(api, "agentMemory").mockImplementation((agentId) =>
      agentId === "a1" ? first.promise : second.promise,
    );

    const { result, rerender } = renderHook(
      ({ agentIds }) => useAgentMemory(agentIds, 0),
      { initialProps: { agentIds: ["a1"] } },
    );
    await waitFor(() => expect(api.agentMemory).toHaveBeenCalledWith("a1"));

    rerender({ agentIds: ["a2"] });
    await waitFor(() => expect(api.agentMemory).toHaveBeenCalledWith("a2"));

    await act(async () => {
      second.resolve({ files: [file("a2")] });
    });
    await waitFor(() => expect(result.current.memory.a2).toHaveLength(1));

    await act(async () => {
      first.resolve({ files: [file("a1")] });
    });
    expect(result.current.memory).toEqual({ a2: [file("a2")] });
  });
});
