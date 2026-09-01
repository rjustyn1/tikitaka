/**
 * Polling for live consolidator activity.
 *
 * Deliberately its own loop rather than a field on `useGroupTask`: that hook
 * stops polling once the task is terminal and flushed, but consolidation also
 * runs mid-DAG (the node-drift flush) and after a segment closes -- which is
 * exactly when someone is watching this panel. Tying the two together would
 * freeze the status display at the moment it matters most.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { MemoryPipelineStatus } from "../types";

/** Fast while a run is in flight, relaxed while idle. */
const BUSY_MS = 800;
const IDLE_MS = 2500;

const empty: MemoryPipelineStatus = { active: [], lastRun: null };

export function useMemoryStatus(groupId: string | null): {
  status: MemoryPipelineStatus;
  /** Null until the first response, so the panel can avoid claiming "idle". */
  loaded: boolean;
  failed: boolean;
} {
  const [status, setStatus] = useState<MemoryPipelineStatus>(empty);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const busy = status.active.length > 0;
  // Read in the timer without retriggering the effect on every tick.
  const groupRef = useRef(groupId);
  groupRef.current = groupId;

  useEffect(() => {
    if (!groupId) {
      setStatus(empty);
      setLoaded(false);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await api.memoryStatus();
        if (!alive) return;
        // Only this group's work; another team consolidating is not this
        // panel's business. A run reports its group once the buffer is built,
        // so a just-started run with a null groupId is kept rather than hidden.
        setStatus({
          active: next.active.filter(
            (run) => run.groupId === null || run.groupId === groupRef.current,
          ),
          lastRun:
            next.lastRun && next.lastRun.groupId === groupRef.current
              ? next.lastRun
              : null,
        });
        setFailed(false);
        setLoaded(true);
      } catch {
        if (!alive) return;
        setFailed(true);
      } finally {
        if (alive) {
          // Re-read from state on the next render; scheduling here keeps one
          // timer alive rather than stacking intervals.
          timer = setTimeout(() => void tick(), busy ? BUSY_MS : IDLE_MS);
        }
      }
    };

    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [groupId, busy]);

  return { status, loaded, failed };
}
