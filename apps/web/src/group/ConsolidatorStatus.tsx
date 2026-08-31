/**
 * Live status of the memory consolidator, under the plan graph.
 *
 * The pipeline is fire-and-forget by design, so without this the only evidence
 * it ran was notes appearing some seconds later. This says what it is doing
 * while it does it, and what the last run produced.
 *
 * Consolidation is concurrent: a mid-DAG drift flush can be running for one
 * segment while another segment closes. Each run therefore gets its own row
 * with its own position in the flow, rather than the panel pretending there is
 * only ever one.
 */
import { useEffect, useState } from "react";
import { MEMORY_PHASES } from "../types";
import type { MemoryPhase, MemoryPipelineStatus, MemoryRunStatus } from "../types";

/** Short label for the flow strip; the architecture's stage order. */
const PHASE_LABEL: Record<MemoryPhase, string> = {
  buffering: "Buffer",
  consolidating: "Consolidate",
  "recognizing-agents": "Recognize Agents",
  "recognizing-skills": "Recognize skills",
  safety: "Safety",
  reviewing: "Review & land",
};

const PHASE_HINT: Record<MemoryPhase, string> = {
  buffering: "Collecting the transcript, node outputs and spans in scope.",
  consolidating: "The extractor is turning that work into candidate notes.",
  "recognizing-agents": "Deciding which Agents each note is for, by embedding similarity.",
  "recognizing-skills": "Deciding which skill file the note becomes inside each Agent.",
  safety: "Secret redaction and the quarantine heuristic.",
  reviewing: "The gate decides auto-grant or human review, then writes the files.",
};

function ago(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  return Math.floor(minutes / 60) + "h ago";
}

function elapsed(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
}

function scopeLabel(run: MemoryRunStatus): string {
  if (run.nodeCount === null) return "whole segment";
  return run.nodeCount + " step" + (run.nodeCount === 1 ? "" : "s") + " · mid-task flush";
}

/** One concurrent run: its scope, its position in the flow, its elapsed time. */
function RunRow({ run, nowMs }: { run: MemoryRunStatus; nowMs: number }) {
  const currentIndex = MEMORY_PHASES.indexOf(run.phase);
  return (
    <li className="consolidator-run">
      <div className="consolidator-run-head">
        <span className="consolidator-dot is-working" aria-hidden="true" />
        <span className="consolidator-run-scope">{scopeLabel(run)}</span>
        {run.candidates > 0 && (
          <span className="consolidator-run-count">
            note {run.candidateIndex} of {run.candidates}
          </span>
        )}
        <span className="consolidator-elapsed">{elapsed(run.startedAt, nowMs)}</span>
      </div>

      {/* Left to right, in the order the architecture runs them. */}
      <ol className="consolidator-flow">
        {MEMORY_PHASES.map((phase, index) => {
          const state =
            index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
          return (
            <li
              key={phase}
              className={"consolidator-step is-" + state}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="consolidator-step-label">{PHASE_LABEL[phase]}</span>
            </li>
          );
        })}
      </ol>
      <p className="consolidator-hint">{PHASE_HINT[run.phase]}</p>
    </li>
  );
}

export function ConsolidatorStatus({
  status,
  loaded,
  failed,
}: {
  status: MemoryPipelineStatus;
  loaded: boolean;
  failed: boolean;
}) {
  const { active, lastRun } = status;
  // A local clock so elapsed counters advance between polls rather than
  // freezing until the next response lands.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (active.length === 0 && !lastRun) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length, lastRun]);

  const state = failed
    ? "unknown"
    : active.length > 0
      ? "working"
      : loaded
        ? "idle"
        : "unknown";

  return (
    <section className="consolidator" aria-label="Memory consolidator status">
      <div className="consolidator-head">
        {state !== "working" && (
          <span className={"consolidator-dot is-" + state} aria-hidden="true" />
        )}
        <div className="consolidator-headline">
          <strong>
            {state === "working"
              ? active.length === 1
                ? "Consolidator running"
                : "Consolidator running · " + active.length + " in parallel"
              : state === "idle"
                ? "Consolidator idle"
                : "Consolidator status unavailable"}
          </strong>
          {state !== "working" && (
            <span className="consolidator-sub">
              {state === "idle"
                ? "Waiting for a task to finish or the subject to change"
                : failed
                  ? "The status endpoint is not answering"
                  : "Checking…"}
            </span>
          )}
        </div>
      </div>

      {state === "working" && (
        <ul className="consolidator-runs">
          {active.map((run) => (
            <RunRow key={run.segmentId} run={run} nowMs={nowMs} />
          ))}
        </ul>
      )}

      {state !== "working" && lastRun && (
        <div className={"consolidator-last" + (lastRun.ok ? "" : " is-error")}>
          <span className="eyebrow">Last run</span>
          {lastRun.ok ? (
            <p>
              {ago(lastRun.finishedAt, nowMs)} · {lastRun.notes} note
              {lastRun.notes === 1 ? "" : "s"} from {lastRun.candidates} candidate
              {lastRun.candidates === 1 ? "" : "s"} · took{" "}
              {(lastRun.durationMs / 1000).toFixed(1)}s
            </p>
          ) : (
            <p>
              {ago(lastRun.finishedAt, nowMs)} · failed ·{" "}
              {lastRun.error ?? "no detail recorded"}
            </p>
          )}
        </div>
      )}

      {state === "idle" && !lastRun && (
        <p className="consolidator-hint">
          Nothing consolidated for this team yet. Memory is written when the
          work drifts to a new subject, or when a task finishes.
        </p>
      )}
    </section>
  );
}
