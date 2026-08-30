import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, TraceSpan } from "../types";
import { api } from "../api";
import { LiveTerminal } from "./LiveTerminal";

vi.mock("../api", () => ({ api: { trace: vi.fn() } }));

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/w/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const agents = [agent("a1", "Backend"), agent("a2", "Frontend")];

function span(
  runId: string,
  agentId: string,
  seq: number,
  startedAt: string,
  text: string,
): TraceSpan {
  return {
    id: runId + "-" + seq,
    runId,
    agentId,
    seq,
    type: "reasoning",
    parentId: null,
    status: "completed",
    startedAt,
    completedAt: startedAt,
    durationMs: 1,
    payload: { kind: "reasoning", text, truncated: false, terminal: true },
    itemId: null,
  };
}

const traced = api.trace as unknown as ReturnType<typeof vi.fn>;

describe("LiveTerminal with several nodes running at once", () => {
  beforeEach(() => traced.mockReset());

  it("merges every running run in TIME order, not per-run seq order", async () => {
    // The trap: seq restarts at 1 for each run. Ordering the merged feed by seq
    // would print both agents' first lines together, then both second lines,
    // regardless of when anything actually happened.
    traced.mockImplementation(async (id: string) =>
      id === "r1"
        ? {
            run: { status: "running" },
            spans: [
              span("r1", "a1", 1, "2026-01-01T00:00:01.000Z", "backend first"),
              span("r1", "a1", 2, "2026-01-01T00:00:03.000Z", "backend third"),
            ],
          }
        : {
            run: { status: "running" },
            spans: [
              span("r2", "a2", 1, "2026-01-01T00:00:02.000Z", "frontend second"),
            ],
          },
    );

    render(<LiveTerminal runIds={["r1", "r2"]} agents={agents} running />);

    await waitFor(() =>
      expect(screen.getByText("backend third")).toBeInTheDocument(),
    );
    const lines = screen
      .getAllByText(/backend|frontend/)
      .map((node) => node.textContent);
    expect(lines).toEqual(["backend first", "frontend second", "backend third"]);
  });

  it("streams both agents rather than only the first running node", async () => {
    traced.mockImplementation(async (id: string) => ({
      run: { status: "running" },
      spans: [
        span(
          id,
          id === "r1" ? "a1" : "a2",
          1,
          "2026-01-01T00:00:0" + (id === "r1" ? "1" : "2") + ".000Z",
          id === "r1" ? "backend line" : "frontend line",
        ),
      ],
    }));

    render(<LiveTerminal runIds={["r1", "r2"]} agents={agents} running />);

    await waitFor(() =>
      expect(screen.getByText("frontend line")).toBeInTheDocument(),
    );
    expect(screen.getByText("backend line")).toBeInTheDocument();
    // Both agents are named on their own lines.
    expect(screen.getByText("Backend")).toBeInTheDocument();
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    // And the header says how many are live.
    expect(screen.getByText("2 agents")).toBeInTheDocument();
  });

  it("keeps rendering the runs that worked when one trace fails", async () => {
    traced.mockImplementation(async (id: string) => {
      if (id === "r2") throw new Error("trace unavailable");
      return {
        run: { status: "running" },
        spans: [span("r1", "a1", 1, "2026-01-01T00:00:01.000Z", "still here")],
      };
    });

    render(<LiveTerminal runIds={["r1", "r2"]} agents={agents} running />);

    await waitFor(() =>
      expect(screen.getByText("still here")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Trace unavailable.")).not.toBeInTheDocument();
  });

  it("shows no agent count when only one node is running", async () => {
    traced.mockResolvedValue({
      run: { status: "running" },
      spans: [span("r1", "a1", 1, "2026-01-01T00:00:01.000Z", "only one")],
    });

    render(<LiveTerminal runIds={["r1"]} agents={agents} running />);

    await waitFor(() =>
      expect(screen.getByText("only one")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/agents$/)).not.toBeInTheDocument();
  });
});
