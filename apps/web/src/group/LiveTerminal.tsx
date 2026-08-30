/**
 * The Live Terminal: a streaming, timestamped log of what the active Agent is
 * doing right now, in the right-hand column of the command center.
 *
 * It reads the SAME trace spans the full Trace panel renders (`api.trace`), but
 * collapses each span to a single terminal line — the point here is glanceable
 * liveness ("Security is scanning… Backend opened port 8080…"), not the full
 * reasoning tree. Open the Trace panel from a node for the detail.
 *
 * Scope note: a group task runs one node at a time (see `group-runner.ts`), so
 * "live" means the trace of the currently-running node's run. When the parallel
 * executor lands, this becomes a merge across the running set — the line shape
 * (`[time] Agent: text`) already carries the agent, so the merge is additive.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Agent, TraceSpan } from "../types";
import { agentName, formatTime } from "./format";

/**
 * Collapse a span's payload to ONE short line. The terminal is a glanceable tail
 * of chain-of-thought and actions — not a transcript. In particular the final
 * `agent_message` (the agent's full answer, often with code) is clamped hard: it
 * already lands as the chat turn beside this panel, and the full trace is one
 * click away in the Trace panel.
 */
function clip(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max).trimEnd() + "…" : oneLine;
}

function lineFor(span: TraceSpan): { text: string; tone: string } {
  const p = span.payload;
  switch (p.kind) {
    case "reasoning":
      return { text: clip(p.text, 200), tone: "reasoning" };
    case "command_exec":
      return {
        text:
          "$ " +
          clip(p.command, 150) +
          (p.exitCode !== null && p.exitCode !== 0 ? "  (exit " + p.exitCode + ")" : ""),
        tone: p.exitCode !== null && p.exitCode !== 0 ? "error" : "command",
      };
    case "file_write":
      return {
        text: "wrote " + clip(p.changes.map((change) => change.path).join(", "), 150),
        tone: "file",
      };
    case "tool_call":
      return { text: clip(p.server + "." + p.tool, 120), tone: "command" };
    case "agent_message":
      // The result, not the process — a short preview only.
      return { text: clip(p.text, 100), tone: "message" };
    case "error":
      return { text: clip(p.message, 200), tone: "error" };
  }
}

export function LiveTerminal({
  runId,
  agents,
  running,
}: {
  /** The run whose trace to stream — the active node's run, or the latest one. */
  runId: string | null;
  agents: Agent[];
  running: boolean;
}) {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [failed, setFailed] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Poll the active run's trace. Same cadence as the rest of the app (~900ms),
  // and only while the task is running; a terminal run is fetched once.
  useEffect(() => {
    if (!runId) {
      setSpans([]);
      return;
    }
    let current = true;
    let timer: number | undefined;
    const refresh = async () => {
      try {
        const result = await api.trace(runId);
        if (!current) return;
        setSpans(result.spans);
        setFailed(false);
        if (running && ["queued", "running"].includes(result.run.status)) {
          timer = window.setTimeout(() => void refresh(), 900);
        }
      } catch {
        if (!current) return;
        setFailed(true);
        if (running) timer = window.setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, running]);

  // Keep the newest line in view, but only if the reader has not scrolled up to
  // read history — the same courtesy a real terminal extends.
  useEffect(() => {
    if (pinnedToBottom.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [spans]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    pinnedToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const ordered = [...spans].sort((left, right) => left.seq - right.seq);

  return (
    <section className="live-terminal" aria-label="Live terminal">
      <div className="live-terminal-head">
        <span className="live-terminal-title">Live Terminal</span>
        <span
          className={"live-terminal-pip " + (running ? "is-live" : "is-idle")}
          aria-label={running ? "Live" : "Idle"}
        />
      </div>
      <div className="live-terminal-feed" ref={feedRef} onScroll={onScroll}>
        {ordered.length === 0 ? (
          <p className="live-terminal-empty">
            {failed
              ? "Trace unavailable."
              : running
                ? "Waiting for the active Agent…"
                : "No activity yet. Start a task to watch the team work."}
          </p>
        ) : (
          ordered.map((span) => {
            const line = lineFor(span);
            return (
              <div key={span.id} className="live-line">
                <span className="live-line-time">{formatTime(span.startedAt)}</span>
                <span className="live-line-agent">
                  {agentName(agents, span.agentId)}
                </span>
                <span className={"live-line-text tone-" + line.tone}>
                  {line.text}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
