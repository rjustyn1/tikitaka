/**
 * The Teams surface: one shared conversation, with the Agents who are having it
 * down the right-hand side and everything that conversation produced behind a
 * secondary view switch.
 *
 * The conversation is primary on purpose. Buried as the seventh of seven equal
 * tabs it read as a dashboard; this is the feature's own one-line summary —
 * "one shared conversation to the user" — made literal.
 *
 * Task state lives here; the panels are presentational. Polling is in
 * `useGroupTask`, which stops only when the task is terminal AND the memory
 * pipeline has flushed — the status alone flips one tick too early. The team
 * list itself is owned by `App`, so the sidebar and this surface agree on one
 * selection.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type {
  Agent,
  AgentGroup,
  GroupMember,
  GroupTask,
  ReviewNoteInput,
} from "../types";
import { ConversationPanel } from "./ConversationPanel";
import { GroupEditor } from "./GroupEditor";
import { isAwaitingReview, isTerminal, statusTone } from "./format";
import { LiveTerminal } from "./LiveTerminal";
import { MemberRail } from "./MemberRail";
import {
  ChainPanel,
  ContextPanel,
  EmptyState,
  LandedMemoryPanel,
  LedgerPanel,
  Pill,
} from "./panels";
import { ProofPanel } from "./ProofPanel";
import { ReviewPanel } from "./ReviewPanel";
import { useAgentMemory } from "./useAgentMemory";
import { useGroupTask } from "./useGroupTask";

type View =
  | "chat"
  | "chain"
  | "context"
  | "review"
  | "ledger"
  | "memory"
  | "proof"
  | "history";

/**
 * A historical task belongs to exactly one team. Keeping that association in
 * state makes an old task disappear in the same render that its team changes,
 * rather than waiting for an effect to clean it up after a mismatched request
 * has already started.
 */
interface TaskSelection {
  groupId: string | null;
  taskId: string | null;
}

/**
 * Conversation is the surface. Everything below inspects what it produced, so
 * they sit in a lighter strip beside it rather than competing with it.
 */
const PLAN_VIEWS: { id: View; label: string }[] = [
  { id: "chain", label: "Plan" },
];

// The audit surfaces — everything that inspects what a finished task produced.
// Memory approval itself happens inline in the conversation (the approval card);
// Review here is the full surface (severity, routing, the match description).
const AUDIT_VIEWS: { id: View; label: string }[] = [
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
  groups,
  selectedGroupId,
  onSelectGroup,
  onRefreshGroups,
  groupsLoading,
  groupsError,
  createRequested,
  onCreateHandled,
}: {
  agents: Agent[];
  onOpenTrace: (runId: string) => void;
  /** Owned by App so the sidebar and this surface agree on one selection. */
  groups: AgentGroup[];
  selectedGroupId: string | null;
  onSelectGroup: (id: string) => void;
  onRefreshGroups: () => Promise<void>;
  /** The sidebar owns the group query, including its bounded async state. */
  groupsLoading: boolean;
  groupsError: string | null;
  /** The sidebar's empty state asks for the editor; this clears the request. */
  createRequested: boolean;
  onCreateHandled: () => void;
}) {
  const [tasks, setTasks] = useState<GroupTask[]>([]);
  const [taskSelection, setTaskSelection] = useState<TaskSelection>({
    groupId: null,
    taskId: null,
  });
  const [view, setView] = useState<View>("chat");
  const [auditOpen, setAuditOpen] = useState(false);
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
    () => groups.find((item) => item.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );
  // A task from another team is never valid for this team's endpoint. This is
  // derived during render, so a sidebar click cannot briefly poll the new team
  // using the previous team's task id.
  const taskId =
    taskSelection.groupId === selectedGroupId ? taskSelection.taskId : null;
  const selectTask = useCallback(
    (id: string | null) => {
      setTaskSelection({ groupId: selectedGroupId, taskId: id });
    },
    [selectedGroupId],
  );
  // Include non-members: the withheld view is the point of the demo.
  const watchedAgentIds = useMemo(
    () => agents.map((agent) => agent.id),
    [agents],
  );

  const state = useGroupTask(selectedGroupId, taskId, watchedAgentIds);
  const task = state.task?.task ?? null;
  const running = task !== null && !isTerminal(task.status);

  // The run the Live Terminal streams: the node running right now, else the
  // most recent node that produced a run so the panel shows the last activity
  // rather than going blank the moment a task finishes.
  const liveRunId =
    (state.task?.nodes.find(
      (node) => node.status === "running" && node.runId,
    )?.runId ??
      [...(state.task?.nodes ?? [])]
        .reverse()
        .find((node) => node.runId)?.runId) ??
    null;

  // The rail reads each member's workspace through the API. Bump the revision
  // — never poll — whenever something could have changed one: a different
  // team, a pipeline flush, or a human review decision.
  const [memoryRevision, setMemoryRevision] = useState(0);
  const memberIds = useMemo(
    () => group?.members.map((member) => member.agentId) ?? [],
    [group],
  );
  const railMemory = useAgentMemory(memberIds, memoryRevision);
  useEffect(() => {
    setMemoryRevision((current) => current + 1);
  }, [selectedGroupId, state.memoryReady]);

  // The sidebar's empty state opens the editor from outside this component.
  useEffect(() => {
    if (createRequested) {
      setEditing("new");
      onCreateHandled();
    }
  }, [createRequested, onCreateHandled]);

  const refreshTasks = useCallback(async () => {
    if (!selectedGroupId) {
      setTasks([]);
      return;
    }
    const { tasks: next } = await api.listGroupTasks(selectedGroupId);
    setTasks(next);
  }, [selectedGroupId]);

  // Load the history when the team changes, and refresh it whenever the live
  // task reaches a terminal status so the row reflects the outcome.
  useEffect(() => {
    void refreshTasks().catch(() => undefined);
  }, [refreshTasks]);
  // Also refresh the team list itself: `activeTaskId` is what drives the
  // sidebar's running indicator, and a task that finishes on its own — rather
  // than through start/cancel/resume — has no other path back to it. Without
  // this the sidebar shows a team as running forever.
  useEffect(() => {
    if (task && isTerminal(task.status)) {
      void refreshTasks().catch(() => undefined);
      void onRefreshGroups().catch(() => undefined);
    }
  }, [task?.status, refreshTasks, onRefreshGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow whichever task the selected group is running, so a reload or a
  // group switch lands on live state rather than an empty screen.
  useEffect(() => {
    if (!group) {
      return;
    }
    if (group.activeTaskId) {
      selectTask(group.activeTaskId);
    }
  }, [group, selectTask]);

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
        onSelectGroup(created.group.id);
      }
      await onRefreshGroups();
      setEditing(null);
    });

  const startTask = (event: React.FormEvent) => {
    event.preventDefault();
    if (!group || !prompt.trim()) return;
    void guard(async () => {
      const { task: started } = await api.startGroupTask(group.id, prompt.trim());
      selectTask(started.id);
      setPrompt("");
      setView("chat");
      await onRefreshGroups();
      await refreshTasks();
    });
  };

  const cancelTask = () => {
    if (!group || !taskId) return;
    void guard(async () => {
      await api.cancelGroupTask(group.id, taskId);
      await state.refresh();
      await onRefreshGroups();
      await refreshTasks();
    });
  };

  const resume = (id: string) => {
    if (!group) return;
    void guard(async () => {
      await api.resumeGroupTask(group.id, id);
      selectTask(id);
      setView("chat");
      await onRefreshGroups();
      await refreshTasks();
    });
  };

  const openTask = (id: string) => {
    selectTask(id);
    setView("chat");
  };

  const reviewNote = (noteId: string, input: ReviewNoteInput) => {
    setBusyNoteId(noteId);
    void guard(async () => {
      await api.reviewNote(noteId, input);
      if (taskId) await state.refreshMemory(taskId);
      setMemoryRevision((current) => current + 1);
    }).finally(() => setBusyNoteId(null));
  };

  const revokeNote = (noteId: string, reason: string) => {
    setBusyNoteId(noteId);
    void guard(async () => {
      await api.revokeNote(noteId, { reviewerName: reviewer, reason });
      if (taskId) await state.refreshMemory(taskId);
      setMemoryRevision((current) => current + 1);
    }).finally(() => setBusyNoteId(null));
  };

  if (groups.length === 0 && groupsLoading && !editing) {
    return (
      <div className="no-agent" role="status">
        <div className="no-agent-art">T</div>
        <h1>Loading Teams…</h1>
        <p>Getting your shared workspaces ready.</p>
      </div>
    );
  }

  if (groups.length === 0 && groupsError && !editing) {
    return (
      <div className="no-agent" role="alert">
        <div className="no-agent-art">!</div>
        <h1>Could not load Teams</h1>
        <p>{groupsError}</p>
        <button
          className="button button-primary"
          onClick={() => void onRefreshGroups().catch(() => undefined)}
        >
          Try again
        </button>
      </div>
    );
  }

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
      {groupsError && (
        <div className="error-banner" role="alert">
          <span>Could not refresh Teams: {groupsError}</span>
        </div>
      )}

      <div className="team-shell">
        <div className="team-main">
          <header className="team-head">
            <div className="team-head-copy">
              <div className="team-head-title">
                <h1>{group?.name ?? "Teams"}</h1>
                {task && <Pill tone={statusTone(task.status)}>{task.status}</Pill>}
                {running && <span className="pulse" />}
              </div>
              <p>
                {group?.description ||
                  "A team of Agents working one shared plan on one shared codebase."}
              </p>
            </div>
            <div className="header-actions">
              {/* Team switching lives in the sidebar now — always visible, one click. */}
              <button
                className="button button-ghost"
                onClick={() => setEditing("edit")}
                disabled={busy || running || !group}
                title={running ? "Membership is frozen while a task runs" : undefined}
              >
                Edit team
              </button>
              <button
                className={
                  "button button-ghost" + (view === "history" ? " is-active" : "")
                }
                onClick={() => setView(view === "history" ? "chat" : "history")}
                disabled={busy}
                aria-pressed={view === "history"}
              >
                History
              </button>
              {running && (
                <button
                  className="button button-danger"
                  onClick={cancelTask}
                  disabled={busy}
                >
                  Cancel task
                </button>
              )}
              {task &&
                !running &&
                (task.status === "partial" ||
                  task.status === "failed" ||
                  task.status === "cancelled") && (
                  <button
                    className="button button-primary"
                    onClick={() => taskId && resume(taskId)}
                    disabled={busy}
                    title="Continue the unfinished nodes (e.g. after switching model)"
                  >
                    Resume task
                  </button>
                )}
            </div>
          </header>

          {/*
            One primary surface, then the things it produced. The rule between
            them is the whole point: Conversation is not the first of seven
            equal tabs, it is the view the others report on.
          */}
          <nav className="team-views">
            <button
              className={"team-view-primary " + (view === "chat" ? "selected" : "")}
              onClick={() => setView("chat")}
            >
              Conversation
            </button>
            <span className="team-views-rule" aria-hidden="true" />
            {PLAN_VIEWS.map((item) => {
              const count = item.id === "review" ? state.notes.length : 0;
              return (
                <button
                  key={item.id}
                  className={"team-view " + (view === item.id ? "selected" : "")}
                  onClick={() => setView(item.id)}
                  disabled={!task}
                  title={task ? undefined : "Start a task to inspect it"}
                >
                  {item.label}
                  {count > 0 && <span className="tab-count">{count}</span>}
                </button>
              );
            })}
            <div className="team-audit">
              <button
                className={
                  "team-view team-audit-toggle " +
                  (AUDIT_VIEWS.some((item) => item.id === view) ? "selected" : "")
                }
                onClick={() => setAuditOpen((open) => !open)}
                disabled={!task}
                title={task ? "Ledger · Workspaces · Proof" : "Start a task to inspect it"}
                aria-expanded={auditOpen}
                aria-haspopup="menu"
              >
                Audit ▾
                {state.grants.length > 0 && (
                  <span className="tab-count">{state.grants.length}</span>
                )}
              </button>
              {auditOpen && task && (
                <div className="team-audit-menu" role="menu">
                  {AUDIT_VIEWS.map((item) => (
                    <button
                      key={item.id}
                      role="menuitem"
                      className={
                        "team-audit-item " + (view === item.id ? "selected" : "")
                      }
                      onClick={() => {
                        setView(item.id);
                        setAuditOpen(false);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </nav>

          {running && (
            <p className="panel-note">
              The plan is running. Memory is proposed only after every step
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

          <section className={"group-panel" + (view === "chat" ? " is-chat" : "")}>
            {view === "chat" && group && (
              <ConversationPanel
                messages={state.task?.messages ?? []}
                agents={agents}
                group={group}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSubmit={startTask}
                running={running}
                busy={busy}
                pendingNotes={state.notes.filter(isAwaitingReview)}
                reviewer={reviewer.trim() || "operator"}
                busyNoteId={busyNoteId}
                onReview={reviewNote}
                onRevoke={revokeNote}
              />
            )}
            {view === "chain" && group && (
              <ChainPanel
                nodes={state.task?.nodes ?? []}
                agents={agents}
                group={group}
                onOpenTrace={onOpenTrace}
              />
            )}
            {view === "context" && (
              <ContextPanel
                injections={state.task?.contextInjections ?? []}
                nodes={state.task?.nodes ?? []}
                agents={agents}
              />
            )}
            {view === "review" && group && (
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
            {view === "ledger" && <LedgerPanel grants={state.grants} agents={agents} />}
            {view === "memory" && group && (
              <LandedMemoryPanel
                group={group}
                agents={agents}
                memoryByAgent={state.memoryByAgent}
              />
            )}
            {view === "proof" && group && (
              <ProofPanel
                group={group}
                agents={agents}
                notes={state.notes}
                memoryByAgent={state.memoryByAgent}
                onOpenTrace={onOpenTrace}
              />
            )}
            {/* Task history is its own view now, opened from the header, so it
                replaces the conversation rather than trailing beneath it. */}
            {view === "history" &&
              group &&
              (tasks.length === 0 ? (
                <EmptyState
                  icon="🕘"
                  title="No tasks yet"
                  body="Start a task in the conversation and every run — completed, failed, or resumable — will be listed here."
                />
              ) : (
                <section className="task-history in-panel">
                  <ul>
                    {tasks.map((item) => {
                      const resumable =
                        item.status === "partial" ||
                        item.status === "failed" ||
                        item.status === "cancelled";
                      return (
                        <li
                          key={item.id}
                          className={
                            item.id === taskId
                              ? "task-history-item selected"
                              : "task-history-item"
                          }
                        >
                          <button
                            className="task-history-open"
                            onClick={() => openTask(item.id)}
                            title="Open this task"
                          >
                            <Pill tone={statusTone(item.status)}>{item.status}</Pill>
                            <span className="task-history-prompt">{item.prompt}</span>
                            <span className="task-history-date">
                              {new Date(item.createdAt).toLocaleString()}
                            </span>
                          </button>
                          {resumable && !running && (
                            <button
                              className="button button-ghost"
                              disabled={busy}
                              onClick={() => resume(item.id)}
                              title="Continue the unfinished nodes on the current model"
                            >
                              Resume
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            {/* A secondary view with no task has nothing to report on. */}
            {!task && view !== "chat" && view !== "history" && (
              <EmptyState
                icon="◇"
                title="No task yet"
                body="Give the team a goal in the conversation. Each Agent takes its turn on one shared codebase, and what they learn becomes reviewable memory."
              />
            )}
          </section>
        </div>

        {group && (
          <div className="cc-rail">
            <LiveTerminal
              runId={liveRunId}
              agents={agents}
              running={running}
            />
            <MemberRail
              group={group}
              agents={agents}
              nodes={state.task?.nodes ?? []}
              taskStatus={task?.status ?? null}
              memory={railMemory.memory}
              memoryLoading={railMemory.loading}
              memoryFailed={railMemory.failed}
              onOpenTrace={onOpenTrace}
            />
          </div>
        )}
      </div>

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
