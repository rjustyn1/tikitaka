import type { RunTraceSummary, TraceSpan } from "./types.js";

/**
 * Shared by solo runs (`AgentService`) and group nodes (`GroupRunner`) so both
 * paths report traces identically.
 */
export function computeTraceSummary(
  spans: TraceSpan[],
  runId: string,
): RunTraceSummary {
  const runSpans = spans.filter((s) => s.runId === runId);
  return {
    spanCount: runSpans.length,
    failedSpanCount: runSpans.filter((s) => s.status === "failed").length,
    reasoningCount: runSpans.filter((s) => s.type === "reasoning").length,
    actionCount: runSpans.filter(
      (s) => s.type !== "reasoning" && s.type !== "error",
    ).length,
  };
}
