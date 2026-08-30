/**
 * What each member's workspace holds right now.
 *
 * File presence IS the enforcement state, so this reads the filesystem through
 * the API rather than inferring anything from note status. It fetches once per
 * `revision` bump and never polls: a workspace only changes when a task flushes
 * or a human reviews something, and both of those bump the revision.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import type { LandedMemoryFile } from "../types";

export function useAgentMemory(agentIds: string[], revision: number) {
  const [memory, setMemory] = useState<Record<string, LandedMemoryFile[]>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A joined string, so a new array with the same ids does not refetch.
  const key = agentIds.join(",");

  useEffect(() => {
    // Cleanup makes a response for the previous team inert. Without it, a slow
    // request can overwrite the rail after the user has already selected a
    // different team.
    let current = true;
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setMemory({});
      setFailed(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    Promise.all(
      ids.map((id) =>
        api.agentMemory(id).then((result) => ({ id, files: result.files })),
      ),
    )
      .then((entries) => {
        if (!current) return;
        const next: Record<string, LandedMemoryFile[]> = {};
        for (const entry of entries) next[entry.id] = entry.files;
        setMemory(next);
      })
      .catch(() => {
        // Never silently show an empty workspace: an empty rail and a failed
        // fetch look identical, and one of them is a false governance claim.
        if (current) setFailed(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [key, revision]);

  return { memory, loading, failed };
}
