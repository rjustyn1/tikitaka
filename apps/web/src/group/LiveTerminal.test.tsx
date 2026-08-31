import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, TraceSpan } from "../types";
import { api } from "../api";
import {
  LiveTerminalOverlay,
  TerminalPanel,
  useLiveSpans,
} from "./LiveTerminal";
import userEvent from "@testing-library/user-event";

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

/**
 * The rail's pairing of the poller with the small panel. Production wires these
 * together in GroupWorkspace so that ONE poller can also feed the overlay; this
 * harness reproduces that pairing so the streaming tests below exercise the
 * real hook rather than a stub.
 */
function Live({
  runIds,
  agents,
  running,
}: {
  runIds: string[];
  agents: Agent[];
  running: boolean;
}) {
  const live = useLiveSpans(runIds, running);
  return <TerminalPanel {...live} agents={agents} running={running} />;
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

    render(<Live runIds={["r1", "r2"]} agents={agents} running />);

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

    render(<Live runIds={["r1", "r2"]} agents={agents} running />);

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

    render(<Live runIds={["r1", "r2"]} agents={agents} running />);

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

    render(<Live runIds={["r1"]} agents={agents} running />);

    await waitFor(() =>
      expect(screen.getByText("only one")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/agents$/)).not.toBeInTheDocument();
  });
});

describe("expanding the terminal to the big view", () => {
  beforeEach(() => traced.mockReset());

  it("offers an expand control that asks its owner to open the big view", async () => {
    const onExpand = vi.fn();
    render(
      <TerminalPanel
        spans={[]}
        failed={false}
        liveCount={0}
        agents={agents}
        running={false}
        onExpand={onExpand}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /expand/i }));

    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe("the expanded overlay", () => {
  beforeEach(() => traced.mockReset());

  const overlay = (onClose: () => void) => (
    <LiveTerminalOverlay
      spans={[]}
      failed={false}
      liveCount={0}
      agents={agents}
      running={false}
      onClose={onClose}
    />
  );

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(overlay(onClose));

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the click lands on the backdrop", async () => {
    const onClose = vi.fn();
    const { container } = render(overlay(onClose));

    const backdrop = container.querySelector(".live-terminal-backdrop");
    await userEvent.click(backdrop as Element);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when the click lands inside the terminal itself", async () => {
    const onClose = vi.fn();
    render(overlay(onClose));

    await userEvent.click(screen.getByText(/No activity yet/));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("is announced as a dialog so assistive tech traps it as one", () => {
    render(overlay(vi.fn()));

    expect(screen.getByRole("dialog", { name: /live terminal/i })).toBeInTheDocument();
  });
});

describe("one poller feeding both views", () => {
  beforeEach(() => traced.mockReset());

  // Regression guard: a second self-polling terminal would double the request
  // rate against a running Codex task for no new information.
  it("fetches each run once even with the rail and the overlay both mounted", async () => {
    traced.mockResolvedValue({
      run: { status: "succeeded" },
      spans: [span("r1", "a1", 1, "2026-01-01T00:00:01.000Z", "single fetch")],
    });

    function Harness() {
      const live = useLiveSpans(["r1"], false);
      return (
        <>
          <TerminalPanel {...live} agents={agents} running={false} />
          <TerminalPanel {...live} agents={agents} running={false} expanded />
        </>
      );
    }
    render(<Harness />);

    await waitFor(() =>
      expect(screen.getAllByText("single fetch")).toHaveLength(2),
    );
    expect(traced).toHaveBeenCalledTimes(1);
  });
});
