/**
 * The Live Terminal: a streaming, timestamped log of what the active Agent is
 * doing right now, in the right-hand column of the command center.
 *
 * It reads the SAME trace spans the full Trace panel renders (`api.trace`), but
 * collapses each span to a single terminal line — the point here is glanceable
 * liveness ("Security is scanning… Backend opened port 8080…"), not the full
 * reasoning tree. Open the Trace panel from a node for the detail.
 *
 * Scope note: a group task runs INDEPENDENT BRANCHES CONCURRENTLY
 * (`group-runner.ts`'s ready-set scheduler), so "live" is a merge across every
 * running node's run, not a single one. The line shape (`[time] Agent: text`)
 * already carries the agent, so the merge needed no new line format.
 *
 * The merge sorts by TIMESTAMP, not by `seq`: seq is per-run, so ordering a
 * merged feed by it would interleave two agents' lines as 1,1,2,2 regardless of
 * when anything actually happened.
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

/**
 * The polling half of the terminal: fetch the traces for every live run and
 * keep them merged.
 *
 * It lives apart from the rendering so that ONE poller can feed BOTH the rail
 * panel and the expanded overlay. Mounting a second self-polling terminal would
 * double the request rate against a running Codex task for no new information.
 */
export function useLiveSpans(runIds: string[], running: boolean) {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [failed, setFailed] = useState(false);
  const [liveCount, setLiveCount] = useState(0);

  // Poll the active run's trace. Same cadence as the rest of the app (~900ms),
  // and only while the task is running; a terminal run is fetched once.
  // `runIds` is a fresh array every render, so the effect keys off its contents.
  const runKey = runIds.join(",");
  useEffect(() => {
    const ids = runKey ? runKey.split(",") : [];
    if (ids.length === 0) {
      setSpans([]);
      setLiveCount(0);
      return;
    }
    let current = true;
    let timer: number | undefined;
    const refresh = async () => {
      // One failing run must not blank the whole feed, so each is settled
      // independently and the rest still render.
      const results = await Promise.allSettled(ids.map((id) => api.trace(id)));
      if (!current) return;
      const ok = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      setFailed(ok.length === 0);
      setSpans(ok.flatMap((result) => result.spans));
      const active = ok.filter((result) =>
        ["queued", "running"].includes(result.run.status),
      ).length;
      setLiveCount(active);
      if (running && (active > 0 || ok.length === 0)) {
        timer = window.setTimeout(() => void refresh(), ok.length === 0 ? 1500 : 900);
      }
    };
    void refresh();
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runKey, running]);

  return { spans, failed, liveCount };
}

/** Outward corner brackets — "make this bigger". */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Inward corner brackets — "put it back". */
function CollapseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The rendering half: a feed of one-line spans, at either size.
 *
 * `expanded` only swaps the size affordance and the toggle's direction — the
 * lines themselves are identical, because it is the same terminal.
 */
export function TerminalPanel({
  spans,
  failed,
  liveCount,
  agents,
  running,
  expanded = false,
  onExpand,
  onCollapse,
}: {
  spans: TraceSpan[];
  failed: boolean;
  liveCount: number;
  agents: Agent[];
  running: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

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

  // Merged across runs, so time is the only ordering that means anything.
  // `seq` breaks ties within one run, where two spans can share a timestamp.
  const ordered = [...spans].sort((left, right) => {
    if (left.startedAt !== right.startedAt) {
      return left.startedAt < right.startedAt ? -1 : 1;
    }
    if (left.runId !== right.runId) return left.runId < right.runId ? -1 : 1;
    return left.seq - right.seq;
  });

  return (
    <section
      className={"live-terminal" + (expanded ? " is-expanded" : "")}
      aria-label="Live terminal"
    >
      <div className="live-terminal-head">
        <span className="live-terminal-title">
          Live Terminal
          {liveCount > 1 && (
            <span className="live-terminal-count">{liveCount} agents</span>
          )}
        </span>
        <div className="live-terminal-tools">
          <span
            className={"live-terminal-pip " + (running ? "is-live" : "is-idle")}
            aria-label={running ? "Live" : "Idle"}
          />
          {expanded ? (
            <button
              type="button"
              className="live-terminal-toggle"
              onClick={onCollapse}
              aria-label="Collapse terminal"
            >
              <CollapseIcon />
            </button>
          ) : (
            <button
              type="button"
              className="live-terminal-toggle"
              onClick={onExpand}
              aria-label="Expand terminal"
            >
              <ExpandIcon />
            </button>
          )}
        </div>
      </div>
      <div className="live-terminal-feed" ref={feedRef} onScroll={onScroll}>
        {ordered.length === 0 ? (
          <p className="live-terminal-empty">
            {failed
              ? "Trace unavailable."
              : running
                ? "Waiting for the active Agents…"
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

/**
 * The same terminal, big, over the app.
 *
 * It takes spans rather than run ids on purpose: the caller already polls for
 * the rail copy, so the overlay adds a second view of that feed without a
 * second request stream. See `useLiveSpans`.
 */
export function LiveTerminalOverlay({
  spans,
  failed,
  liveCount,
  agents,
  running,
  onClose,
}: {
  spans: TraceSpan[];
  failed: boolean;
  liveCount: number;
  agents: Agent[];
  running: boolean;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Move focus in on open and hand it back on close, so a keyboard reader is
  // not left stranded at the top of the page behind the overlay.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div
      className="live-terminal-backdrop"
      // Only a press that STARTS on the backdrop dismisses: a drag that began
      // on a terminal line and ended out here is a text selection, not a click
      // away.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="live-terminal-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Live terminal"
        tabIndex={-1}
        ref={panelRef}
      >
        <TerminalPanel
          spans={spans}
          failed={failed}
          liveCount={liveCount}
          agents={agents}
          running={running}
          expanded
          onCollapse={onClose}
        />
      </div>
    </div>
  );
}
