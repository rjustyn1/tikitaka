/**
 * The team list, owned above `GroupWorkspace`.
 *
 * It lives here because two surfaces need it: the persistent sidebar list in
 * `App`, and the workspace itself. Keeping it inside the workspace is what
 * forced the old `<select>` buried in the content header — and with a single
 * team that select never rendered at all, so there was no team selector
 * anywhere in the product.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AgentGroup } from "../types";

export interface GroupsState {
  groups: AgentGroup[];
  selectedId: string | null;
  select: (id: string) => void;
  refresh: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function useGroups(enabled: boolean): GroupsState {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { groups: next } = await api.groups();
      if (currentRequest !== requestId.current) return;
      setGroups(next);
      // Keep the current selection while it still exists; otherwise fall to the
      // first team so the surface never lands on nothing.
      setSelectedId((current) =>
        current && next.some((item) => item.id === current)
          ? current
          : (next[0]?.id ?? null),
      );
    } catch (reason) {
      if (currentRequest === requestId.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      throw reason;
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Invalidates a response that started just before the user left Teams.
      requestId.current += 1;
      setLoading(false);
      return;
    }
    void refresh().catch(() => undefined);
  }, [enabled, refresh]);

  return { groups, selectedId, select: setSelectedId, refresh, loading, error };
}
