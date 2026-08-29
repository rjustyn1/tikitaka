/**
 * The proof beat (A5).
 *
 * The claim is "memory landed, and a later run uses it". Proving it needs care:
 * a resumed Codex thread may not re-read a changed `AGENTS.md`, so a normal
 * follow-up run can silently fail to show the memory. Every run started here
 * passes `freshThread: true`, which sends `threadId: null` so Codex re-reads
 * `AGENTS.md` and `.agents/skills` from disk.
 *
 * Two runs, side by side:
 *   POSITIVE  a targeted Agent answers using the landed memory
 *   NEGATIVE  a withheld Agent has no such file, so it cannot
 *
 * The negative is the one that matters. It is not a prompt telling the Agent to
 * keep a secret — there is nothing in that workspace to reveal.
 */
import { useState } from "react";
import { api, ApiError } from "../api";
import type { Agent, AgentGroup, LandedMemoryFile, MemoryNote } from "../types";
import { agentName } from "./format";
import { EmptyState, Pill } from "./panels";

interface RunState {
  status: "idle" | "running" | "done" | "error";
  output: string;
  runId: string | null;
}

const idle: RunState = { status: "idle", output: "", runId: null };

export function ProofPanel({
  group,
  agents,
  notes,
  memoryByAgent,
  onOpenTrace,
}: {
  group: AgentGroup;
  agents: Agent[];
  notes: MemoryNote[];
  memoryByAgent: Record<string, LandedMemoryFile[]>;
  onOpenTrace: (runId: string) => void;
}) {
  const activeNotes = notes.filter((note) => note.status === "active");
  const [prompt, setPrompt] = useState("");
  const [runs, setRuns] = useState<Record<string, RunState>>({});

  const filesFor = (agentId: string) =>
    (memoryByAgent[agentId] ?? []).filter((file) => file.removedAt === null);

  // A targeted Agent that actually holds a file, and any Agent that holds none.
  const holder = group.members
    .map((member) => member.agentId)
    .find((agentId) => filesFor(agentId).length > 0);
  const memberIds = new Set(group.members.map((member) => member.agentId));
  const withheld = agents.find(
    (agent) => !memberIds.has(agent.id) || filesFor(agent.id).length === 0,
  );

  const suggested = (() => {
    const note = activeNotes[0];
    if (!note) return "";
    const skill = filesFor(holder ?? "").find((file) => file.kind === "skill");
    const slug = skill?.path.split("/").slice(-2)[0];
    // Explicit $skill-name invocation: relevance matching is Codex's soft half,
    // and the stage is the wrong place to demonstrate a probabilistic step.
    return slug
      ? "Use $" + slug + " and state the constraint it gives you."
      : "State any constraint your instructions give you about " +
          note.description.toLowerCase().replace(/\.$/, "") +
          ".";
  })();

  const run = async (agent: Agent) => {
    const text = (prompt || suggested).trim();
    if (!text) return;
    setRuns((prev) => ({
      ...prev,
      [agent.id]: { status: "running", output: "", runId: null },
    }));
    try {
      // freshThread is REQUIRED. Without it this resumes the Agent's existing
      // thread, which may never re-read the landed AGENTS.md, and the beat
      // fails for a reason invisible on stage.
      const { run: started } = await api.sendMessage(agent.id, text, {
        freshThread: true,
      });
      let current = started;
      for (let i = 0; i < 300 && ["queued", "running"].includes(current.status); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = (await api.run(current.id)).run;
      }
      setRuns((prev) => ({
        ...prev,
        [agent.id]: {
          status: current.status === "completed" ? "done" : "error",
          output: current.output ?? current.error ?? "(no output)",
          runId: current.id,
        },
      }));
    } catch (reason) {
      setRuns((prev) => ({
        ...prev,
        [agent.id]: {
          status: "error",
          output:
            reason instanceof ApiError
              ? reason.message
              : reason instanceof Error
                ? reason.message
                : String(reason),
          runId: null,
        },
      }));
    }
  };

  if (activeNotes.length === 0) {
    return (
      <EmptyState
        icon="◎"
        title="Nothing has landed yet"
        body="Approve a memory in Review first. The proof run needs something actually written to a workspace."
      />
    );
  }

  const card = (agent: Agent | undefined, kind: "granted" | "withheld") => {
    if (!agent) {
      return (
        <div className="proof-card">
          <p className="muted-note">
            No {kind === "granted" ? "Agent holding memory" : "withheld Agent"}{" "}
            available. Create a fourth Agent outside the team to show the denial.
          </p>
        </div>
      );
    }
    const state = runs[agent.id] ?? idle;
    const files = filesFor(agent.id);
    return (
      <div className={"proof-card proof-" + kind}>
        <div className="proof-head">
          <strong>{agent.name}</strong>
          <Pill tone={kind === "granted" ? "ok" : "warn"}>
            {kind === "granted"
              ? files.length + " memory file" + (files.length === 1 ? "" : "s")
              : "no memory files"}
          </Pill>
        </div>
        <p className="proof-note">
          {kind === "granted"
            ? "This workspace holds the landed memory, so a fresh run can load it."
            : "This workspace holds nothing. There is no instruction to ignore — there is simply nothing there."}
        </p>
        <button
          className="button button-primary"
          disabled={state.status === "running" || !(prompt || suggested).trim()}
          onClick={() => void run(agent)}
        >
          {state.status === "running" ? "Running…" : "Run on a fresh thread"}
        </button>
        {state.status !== "idle" && (
          <div className={"proof-output " + state.status}>
            {state.status === "running" ? (
              <span className="muted-note">Starting a new Codex thread…</span>
            ) : (
              <>
                <pre>{state.output}</pre>
                {state.runId && (
                  <button
                    className="button button-ghost"
                    onClick={() => onOpenTrace(state.runId as string)}
                  >
                    Open trace
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="proof">
      <p className="panel-note">
        Both runs start a <strong>new</strong> Codex thread. A resumed thread may
        not re-read a changed <code>AGENTS.md</code>, so a normal follow-up run
        can appear to ignore memory that did land.
      </p>
      <label className="proof-prompt">
        Prompt for both Agents
        <textarea
          rows={2}
          value={prompt}
          placeholder={suggested}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <div className="proof-grid">
        {card(
          agents.find((agent) => agent.id === holder),
          "granted",
        )}
        {card(withheld, "withheld")}
      </div>
    </div>
  );
}
