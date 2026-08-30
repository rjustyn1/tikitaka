/**
 * Polling for a running group task, and for the governed memory it produces.
 *
 * Two things here are easy to get wrong and were both observed against the real
 * server, so they are handled deliberately rather than defensively:
 *
 *  1. A task is `queued` before it is `running`. Any loop written as
 *     `status !== "running"` exits on the first tick. `isTerminal()` tests
 *     membership of the terminal set instead.
 *
 *  2. `finishTask` persists the terminal status and only THEN runs the memory
 *     pipeline. So `status === "completed"` does not mean notes exist yet —
 *     `task.flushedAt` is the signal that consolidation actually finished.
 *     Fetching notes on the status flip reliably returns an empty list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  GrantRecord,
  GroupTaskResponse,
  LandedMemoryFile,
  MemoryNote,
} from "../types";
import { isTerminal } from "./format";

const POLL_MS = 2000;
/** How long to keep waiting for a flush after the task is terminal (~20s). */
const MAX_FLUSH_WAIT_TICKS = 10;

export interface GroupTaskState {
  task: GroupTaskResponse | null;
  notes: MemoryNote[];
  grants: GrantRecord[];
  /** Landed memory per Agent id, for the "what does this Agent hold?" view. */
  memoryByAgent: Record<string, LandedMemoryFile[]>;
  /** True once the pipeline has run, so the memory panels have real data. */
  memoryReady: boolean;
  loading: boolean;
  error: string | null;
}

const empty: GroupTaskState = {
  task: null,
  notes: [],
  grants: [],
  memoryByAgent: {},
  memoryReady: false,
  loading: false,
  error: null,
};

export function useGroupTask(
  groupId: string | null,
  taskId: string | null,
  agentIds: string[],
) {
  const [state, setState] = useState<GroupTaskState>(empty);
  const mounted = useRef(true);
  // Read inside the interval without making it a dependency, so the timer is
  // not torn down and recreated on every tick.
  const agentIdsRef = useRef(agentIds);
  agentIdsRef.current = agentIds;
  // Ticks spent waiting for a flush that may never arrive. State, not a ref:
  // the polling effect has to re-evaluate its guard when this changes.
  const [flushWaitTicks, setFlushWaitTicks] = useState(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshMemory = useCallback(async (currentTaskId: string) => {
    const [notes, grants, ...memories] = await Promise.all([
      api.notes(),
      api.taskGrants(currentTaskId),
      ...agentIdsRef.current.map((id) =>
        api.agentMemory(id).then((result) => ({ id, files: result.files })),
      ),
    ]);
    if (!mounted.current) return;
    const memoryByAgent: Record<string, LandedMemoryFile[]> = {};
    for (const entry of memories) memoryByAgent[entry.id] = entry.files;
    setState((prev) => ({
      ...prev,
      notes: notes.notes,
      grants: grants.grants,
      memoryByAgent,
    }));
  }, []);

  const refresh = useCallback(async () => {
    if (!groupId || !taskId) return;
    try {
      const response = await api.groupTask(groupId, taskId);
      if (!mounted.current) return;
      const ready = response.task.flushedAt !== null;
      setState((prev) => ({
        ...prev,
        task: response,
        memoryReady: ready,
        loading: false,
        error: null,
      }));
      if (ready) await refreshMemory(taskId);
    } catch (reason) {
      if (!mounted.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: reason instanceof Error ? reason.message : String(reason),
      }));
    }
  }, [groupId, taskId, refreshMemory]);

  useEffect(() => {
    if (!groupId || !taskId) {
      setState(empty);
      return;
    }
    setFlushWaitTicks(0);
    setState({ ...empty, loading: true });
    void refresh();
  }, [groupId, taskId, refresh]);

  useEffect(() => {
    if (!groupId || !taskId) return;
    const task = state.task?.task;
    const settled = task !== undefined && isTerminal(task.status);

    // Keep polling until the task is terminal AND the pipeline has flushed.
    // Stopping on the status alone freezes the UI one tick before the notes
    // appear, which reads as "the memory feature is broken".
    //
    // But a flush is not guaranteed: when every node fails, decideFlush returns
    // no_completed_runs and flushedAt stays null forever. Observed against the
    // real server. So the post-terminal wait is BOUNDED.
    if (settled && (state.memoryReady || flushWaitTicks >= MAX_FLUSH_WAIT_TICKS)) {
      return;
    }

    const timer = setInterval(() => {
      if (settled) setFlushWaitTicks((current) => current + 1);
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [
    groupId,
    taskId,
    refresh,
    state.task?.task.status,
    state.memoryReady,
    flushWaitTicks,
  ]);

  /** Terminal, but consolidation never produced anything. Say so, don't spin. */
  const flushGaveUp =
    state.task !== null &&
    isTerminal(state.task.task.status) &&
    !state.memoryReady &&
    flushWaitTicks >= MAX_FLUSH_WAIT_TICKS;

  return { ...state, flushGaveUp, refresh, refreshMemory };
}
