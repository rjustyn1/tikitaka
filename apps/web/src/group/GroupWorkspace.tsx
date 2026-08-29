/**
 * The Teams surface: pick a team, run a task, watch the chain, then govern the
 * memory it produced.
 *
 * State lives here; the panels are presentational. Polling is in `useGroupTask`,
 * which stops only when the task is terminal AND the memory pipeline has
 * flushed — the status alone flips one tick too early.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type {
  Agent,
  AgentGroup,
  GroupMember,
  ReviewNoteInput,
} from "../types";
import { GroupEditor } from "./GroupEditor";
import { agentName, isTerminal, roleOf, statusTone } from "./format";
import {
  ChainPanel,
  ContextPanel,
  EmptyState,
  LandedMemoryPanel,
  LedgerPanel,
  Pill,
  TimelinePanel,
} from "./panels";
import { ProofPanel } from "./ProofPanel";
import { ReviewPanel } from "./ReviewPanel";
import { useGroupTask } from "./useGroupTask";

type Tab = "chain" | "timeline" | "context" | "review" | "ledger" | "memory" | "proof";

const TABS: { id: Tab; label: string }[] = [
  { id: "chain", label: "Plan" },
  { id: "timeline", label: "Transcript" },
  { id: "context", label: "Context" },
  { id: "review", label: "Review" },
  { id: "ledger", label: "Ledger" },
  { id: "memory", label: "Workspaces" },
  { id: "proof", label: "Proof" },
];

const REVIEWER_KEY = "launchpad.reviewerName";

export function GroupWorkspace({
  agents,
  onOpenTrace,
}: {
  agents: Agent[];
  onOpenTrace: (runId: string) => void;
}) {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chain");
  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState<"new" | "edit" | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState(() => {
    try {
      return localStorage.getItem(REVIEWER_KEY) ?? "operator";
    } catch {
      // Private windows and blocked site data both throw here.
      return "operator";
    }
  });

  const group = useMemo(
    () => groups.find((item) => item.id === selectedId) ?? null,
    [groups, selectedId],
  );
  // Include non-members: the withheld view is the point of the demo.
  const watchedAgentIds = useMemo(
    () => agents.map((agent) => agent.id),
    [agents],
  );

  const state = useGroupTask(selectedId, taskId, watchedAgentIds);
  const task = state.task?.task ?? null;
  const running = task !== null && !isTerminal(task.status);

  const refreshGroups = useCallback(async () => {
    const { groups: next } = await api.groups();
    setGroups(next);
    setSelectedId((current) =>
      current && next.some((item) => item.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    void refreshGroups().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshGroups]);

  // Follow whichever task the selected group is running, so a reload or a
  // group switch lands on live state rather than an empty screen.
  useEffect(() => {
    if (!group) {
      setTaskId(null);
      return;
    }
    if (group.activeTaskId) {
      setTaskId(group.activeTaskId);
    }
  }, [group]);

  const saveReviewer = (value: string) => {
    setReviewer(value);
    try {
      localStorage.setItem(REVIEWER_KEY, value);
    } catch {
      // Non-fatal: the name simply will not persist across reloads.
    }
  };

  const describe = (reason: unknown): string => {
    if (reason instanceof ApiError) {
      if (reason.status === 501) {
        return reason.message + " — this part of the backend is not wired yet.";
      }
      if (reason.status === 409) {
        return reason.message;
      }
      return reason.message;
    }
    return reason instanceof Error ? reason.message : String(reason);
  };

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitGroup = (input: {
    name: string;
    description: string;
    members: GroupMember[];
  }) =>
    void guard(async () => {
      if (editing === "edit" && group) {
        await api.updateGroup(group.id, input);
      } else {
        const created = await api.createGroup(input);
        setSelectedId(created.group.id);
        setTaskId(null);
      }
      await refreshGroups();
      setEditing(null);
    });

  const startTask = (event: React.FormEvent) => {
    event.preventDefault();
    if (!group || !prompt.trim()) return;
    void guard(async () => {
      const { task: started } = await api.startGroupTask(group.id, prompt.trim());
      setTaskId(started.id);
      setPrompt("");
      setTab("chain");
      await refreshGroups();
    });
  };

  const cancelTask = () => {
    if (!group || !taskId) return;
    void guard(async () => {
      await api.cancelGroupTask(group.id, taskId);
      await state.refresh();
      await refreshGroups();
    });
  };

  const reviewNote = (noteId: string, input: ReviewNoteInput) => {
    setBusyNoteId(noteId);
    void guard(async () => {
      await api.reviewNote(noteId, input);
      if (taskId) await state.refreshMemory(taskId);
    }).finally(() => setBusyNoteId(null));
  };

  const revokeNote = (noteId: string, reason: string) => {
    setBusyNoteId(noteId);
    void guard(async () => {
      await api.revokeNote(noteId, { reviewerName: reviewer, reason });
      if (taskId) await state.refreshMemory(taskId);
    }).finally(() => setBusyNoteId(null));
  };

  if (groups.length === 0 && !editing) {
    return (
      <div className="no-agent">
        <div className="no-agent-art">T</div>
        <span className="eyebrow">Teams</span>
        <h1>Put your Agents on one task.</h1>
        <p>
          A team runs a shared plan, then what it learned is proposed as memory —
          for you to grant or withhold, Agent by Agent.
        </p>
        <button
          className="button button-primary"
          onClick={() => setEditing("new")}
          disabled={agents.length < 3}
        >
          {agents.length < 3
            ? "Create three Agents first"
            : "Create your first team"}
        </button>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <header className="agent-header">
        <div>
          <div className="header-title-row">
            <h1>{group?.name ?? "Teams"}</h1>
            {task && <Pill tone={statusTone(task.status)}>{task.status}</Pill>}
            {running && <span className="pulse" />}
          </div>
          <p>
            {group?.description ||
              "A team of Agents working one shared plan on one shared codebase."}
          </p>
          {group && (
            <div className="roster-inline">
              {group.members.map((member) => (
                <span key={member.agentId} className="target-chip">
                  <span className={"role-dot role-" + member.role} />
                  {agentName(agents, member.agentId)}
                  <em>{roleOf(group.members, member.agentId)}</em>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="header-actions">
          {groups.length > 1 && (
            <select
              className="team-select"
              value={selectedId ?? ""}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setTaskId(null);
              }}
            >
              {groups.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="button button-ghost"
            onClick={() => setEditing("edit")}
            disabled={busy || running || !group}
            title={running ? "Membership is frozen while a task runs" : undefined}
          >
            Edit team
          </button>
          <button
            className="button button-ghost"
            onClick={() => setEditing("new")}
            disabled={busy}
          >
            New team
          </button>
          {running && (
            <button className="button button-danger" onClick={cancelTask} disabled={busy}>
              Cancel task
            </button>
          )}
        </div>
      </header>

      {group && (
        <form className="task-composer" onSubmit={startTask}>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              running
                ? "A task is already running for this team…"
                : "Give the team one goal — e.g. Plan and implement an upload feature."
            }
            disabled={running || busy}
            maxLength={50_000}
          />
          <button
            className="button button-primary"
            disabled={running || busy || !prompt.trim()}
          >
            Start task
          </button>
        </form>
      )}

      {task ? (
        <>
          <nav className="tabs">
            {TABS.map((item) => {
              const count =
                item.id === "review"
                  ? state.notes.length
                  : item.id === "ledger"
                    ? state.grants.length
                    : 0;
              return (
                <button
                  key={item.id}
                  className={"tab " + (tab === item.id ? "selected" : "")}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                  {count > 0 && <span className="tab-count">{count}</span>}
                </button>
              );
            })}
          </nav>

          {running && (
            <p className="panel-note">
              The chain is running. Memory is proposed only after every step
              finishes and consolidation completes.
            </p>
          )}
          {task && isTerminal(task.status) && !state.memoryReady && !state.flushGaveUp && (
            <p className="panel-note">
              The plan finished. Consolidating what the team learned…
            </p>
          )}
          {state.flushGaveUp && (
            <p className="panel-note">
              This task produced no governed memory. That happens when no step
              completed successfully — there was nothing to learn from.
            </p>
          )}

          <section className="group-panel">
            {tab === "chain" && group && (
              <ChainPanel
                nodes={state.task?.nodes ?? []}
                agents={agents}
                group={group}
                onOpenTrace={onOpenTrace}
              />
            )}
            {tab === "timeline" && group && (
              <TimelinePanel
                messages={state.task?.messages ?? []}
                agents={agents}
                group={group}
              />
            )}
            {tab === "context" && (
              <ContextPanel
                injections={state.task?.contextInjections ?? []}
                nodes={state.task?.nodes ?? []}
                agents={agents}
              />
            )}
            {tab === "review" && group && (
              <>
                <label className="reviewer-field">
                  Reviewer name
                  <input
                    value={reviewer}
                    onChange={(event) => saveReviewer(event.target.value)}
                    maxLength={60}
                  />
                </label>
                <ReviewPanel
                  notes={state.notes}
                  agents={agents}
                  group={group}
                  reviewer={reviewer.trim() || "operator"}
                  busyNoteId={busyNoteId}
                  onReview={reviewNote}
                  onRevoke={revokeNote}
                />
              </>
            )}
            {tab === "ledger" && <LedgerPanel grants={state.grants} agents={agents} />}
            {tab === "memory" && group && (
              <LandedMemoryPanel
                group={group}
                agents={agents}
                memoryByAgent={state.memoryByAgent}
              />
            )}
            {tab === "proof" && group && (
              <ProofPanel
                group={group}
                agents={agents}
                notes={state.notes}
                memoryByAgent={state.memoryByAgent}
                onOpenTrace={onOpenTrace}
              />
            )}
          </section>
        </>
      ) : (
        group && (
          <EmptyState
            icon="◇"
            title="No task yet"
            body="Give the team a goal above. Each Agent takes its turn on one shared codebase, and what they learn becomes reviewable memory."
          />
        )
      )}

      {editing && (
        <GroupEditor
          agents={agents}
          group={editing === "edit" ? group : null}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={submitGroup}
        />
      )}
    </>
  );
}
