import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { useGroups } from "./useGroups";

describe("useGroups", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a failed initial request distinct from an empty Teams list", async () => {
    vi.spyOn(api, "groups").mockRejectedValue(new Error("The server is unavailable."));

    const { result } = renderHook(() => useGroups(true));

    await waitFor(() => {
      expect(result.current.error).toBe("The server is unavailable.");
    });
    expect(result.current.groups).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
