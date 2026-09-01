import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MemoryPhase, MemoryPipelineStatus, MemoryRunStatus } from "../types";
import { ConsolidatorStatus } from "./ConsolidatorStatus";

const idle: MemoryPipelineStatus = { active: [], lastRun: null };

function run(
  segmentId: string,
  phase: MemoryPhase,
  overrides: Partial<MemoryRunStatus> = {},
): MemoryRunStatus {
  return {
    segmentId,
    groupId: "group-1",
    phase,
    startedAt: new Date(Date.now() - 4000).toISOString(),
    nodeCount: 3,
    candidates: 0,
    candidateIndex: 0,
    ...overrides,
  };
}

const running: MemoryPipelineStatus = {
  active: [run("seg-1", "recognizing-agents", { candidates: 5, candidateIndex: 2 })],
  lastRun: null,
};

describe("ConsolidatorStatus", () => {
  it("says it is running, and shows the run's scope and position", () => {
    render(<ConsolidatorStatus status={running} loaded failed={false} />);
    expect(screen.getByText("Consolidator running")).toBeInTheDocument();
    expect(screen.getByText("3 steps · mid-task flush")).toBeInTheDocument();
    expect(screen.getByText("note 2 of 5")).toBeInTheDocument();
  });

  it("walks the architecture's stages left to right", () => {
    render(<ConsolidatorStatus status={running} loaded failed={false} />);
    const steps = document.querySelectorAll(".consolidator-step");
    expect([...steps].map((step) => step.textContent)).toEqual([
      "Buffer",
      "Consolidate",
      "Recognize Agents",
      "Recognize skills",
      "Safety",
      "Review & land",
    ]);
    // Recognition is two levels; the agent level is current, the skill level
    // has not happened yet.
    expect(steps[1]?.className).toContain("is-done");
    expect(steps[2]?.className).toContain("is-current");
    expect(steps[3]?.className).toContain("is-todo");
  });

  /** A drift flush and a segment close can overlap; both must be visible. */
  it("gives every concurrent run its own row", () => {
    render(
      <ConsolidatorStatus
        loaded
        failed={false}
        status={{
          active: [
            run("seg-1", "consolidating", { nodeCount: 2 }),
            run("seg-2", "safety", { nodeCount: null }),
          ],
          lastRun: null,
        }}
      />,
    );
    expect(screen.getByText("Consolidator running · 2 in parallel")).toBeInTheDocument();
    expect(document.querySelectorAll(".consolidator-run")).toHaveLength(2);
    expect(screen.getByText("2 steps · mid-task flush")).toBeInTheDocument();
    expect(screen.getByText("whole segment")).toBeInTheDocument();
  });

  it("tracks each concurrent run's own position in the flow", () => {
    render(
      <ConsolidatorStatus
        loaded
        failed={false}
        status={{
          active: [run("seg-1", "buffering"), run("seg-2", "reviewing")],
          lastRun: null,
        }}
      />,
    );
    const rows = document.querySelectorAll(".consolidator-run");
    const currentOf = (row: Element) =>
      row.querySelector(".consolidator-step.is-current")?.textContent;
    expect(currentOf(rows[0] as Element)).toBe("Buffer");
    expect(currentOf(rows[1] as Element)).toBe("Review & land");
  });

  it("says idle when nothing is running", () => {
    render(<ConsolidatorStatus status={idle} loaded failed={false} />);
    expect(screen.getByText("Consolidator idle")).toBeInTheDocument();
  });

  /**
   * "Idle" is a claim about the server. Before the first response, and when the
   * endpoint is down, the honest answer is that we do not know -- saying "idle"
   * would report a broken consolidator as a working one at rest.
   */
  it("does not claim idle before the first response", () => {
    render(<ConsolidatorStatus status={idle} loaded={false} failed={false} />);
    expect(screen.queryByText("Consolidator idle")).not.toBeInTheDocument();
    expect(screen.getByText("Consolidator status unavailable")).toBeInTheDocument();
  });

  it("does not claim idle when the status endpoint is failing", () => {
    render(<ConsolidatorStatus status={idle} loaded failed />);
    expect(screen.queryByText("Consolidator idle")).not.toBeInTheDocument();
    expect(screen.getByText(/not answering/)).toBeInTheDocument();
  });

  it("summarises the last run, separating notes from candidates", () => {
    render(
      <ConsolidatorStatus
        loaded
        failed={false}
        status={{
          active: [],
          lastRun: {
            segmentId: "seg-1",
            groupId: "group-1",
            finishedAt: new Date().toISOString(),
            durationMs: 4200,
            ok: true,
            candidates: 5,
            notes: 2,
            error: null,
          },
        }}
      />,
    );
    expect(screen.getByText(/2 notes from 5 candidates/)).toBeInTheDocument();
    expect(screen.getByText(/4\.2s/)).toBeInTheDocument();
  });

  it("surfaces a failed run rather than reporting a quiet idle", () => {
    render(
      <ConsolidatorStatus
        loaded
        failed={false}
        status={{
          active: [],
          lastRun: {
            segmentId: "seg-1",
            groupId: "group-1",
            finishedAt: new Date().toISOString(),
            durationMs: 120,
            ok: false,
            candidates: 0,
            notes: 0,
            error: "extractor timed out",
          },
        }}
      />,
    );
    expect(screen.getByText(/failed · extractor timed out/)).toBeInTheDocument();
  });
});
