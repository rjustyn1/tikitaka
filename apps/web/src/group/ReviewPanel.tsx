/**
 * The human gate.
 *
 * A note reaches an Agent only after this panel lets it through, so the edit
 * levers here ARE the governance knobs: content, severity, routing, and the
 * `description` that decides when Codex loads the skill.
 *
 * Reviewer identity is ATTRIBUTION, NOT AUTHENTICATION. The platform is
 * single-user with no identity system; this records who *claims* to have
 * approved. Saying so plainly is part of the design.
 */
import { useState } from "react";
import type {
  Agent,
  AgentGroup,
  GroupRole,
  MemoryNote,
  MemorySeverity,
  ReviewNoteInput,
} from "../types";
import { agentName, isAwaitingReview, reviewReasons, statusTone } from "./format";
import { EmptyState, Pill } from "./panels";

interface Props {
  notes: MemoryNote[];
  agents: Agent[];
  group: AgentGroup;
  reviewer: string;
  busyNoteId: string | null;
  onReview: (noteId: string, input: ReviewNoteInput) => void;
  onRevoke: (noteId: string, reason: string) => void;
}

export function ReviewPanel({
  notes,
  agents,
  group,
  reviewer,
  busyNoteId,
  onReview,
  onRevoke,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    content: string;
    description: string;
    severity: MemorySeverity;
    targetAgentIds: string[];
  } | null>(null);

  if (notes.length === 0) {
    return (
      <EmptyState
        icon="✉"
        title="No proposed memories"
        body="When a task finishes, what the Agents learned is proposed here for review."
      />
    );
  }

  const startEdit = (note: MemoryNote) => {
    setEditingId(note.id);
    setDraft({
      content: note.content,
      description: note.description,
      severity: note.severity,
      targetAgentIds: [...note.targetAgentIds],
    });
  };

  const memberRole = (agentId: string): GroupRole | null =>
    group.members.find((member) => member.agentId === agentId)?.role ?? null;

  const awaiting = notes.filter(isAwaitingReview);
  const settled = notes.filter((note) => !isAwaitingReview(note));

  const renderNote = (note: MemoryNote) => {
    const editing = editingId === note.id;
    const reasons = reviewReasons(note);
    const busy = busyNoteId === note.id;
    return (
      <article key={note.id} className={"note note-" + note.status}>
        <header className="note-head">
          <Pill tone={statusTone(note.status)}>{note.status}</Pill>
          <Pill tone={note.severity === "severe" ? "bad" : "idle"}>
            {note.severity}
          </Pill>
          {reasons.map((reason) => (
            <span key={reason} className="note-reason">
              {reason}
            </span>
          ))}
        </header>

        {editing && draft ? (
          <div className="note-edit">
            <label>
              Content
              <textarea
                rows={3}
                value={draft.content}
                maxLength={2000}
                onChange={(event) =>
                  setDraft({ ...draft, content: event.target.value })
                }
              />
            </label>
            <label>
              Description — this is the only signal Codex matches on
              <input
                value={draft.description}
                maxLength={300}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </label>
            <div className="note-edit-row">
              <label className="inline-field">
                Severity
                <select
                  value={draft.severity}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      severity: event.target.value as MemorySeverity,
                    })
                  }
                >
                  <option value="normal">normal — loads when relevant</option>
                  <option value="severe">severe — always in context</option>
                </select>
              </label>
            </div>
            <div className="note-routing">
              <span className="eyebrow">Route to</span>
              <div className="routing-chips">
                {group.members.map((member) => {
                  const on = draft.targetAgentIds.includes(member.agentId);
                  return (
                    <button
                      key={member.agentId}
                      type="button"
                      className={"role-chip " + (on ? "selected" : "")}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          targetAgentIds: on
                            ? draft.targetAgentIds.filter(
                                (id) => id !== member.agentId,
                              )
                            : [...draft.targetAgentIds, member.agentId],
                        })
                      }
                    >
                      {agentName(agents, member.agentId)}
                    </button>
                  );
                })}
              </div>
              <p className="muted-note">
                Routing may only narrow within this team. Widening past the
                source group is not a review decision.
              </p>
            </div>
            <div className="note-actions">
              <button
                className="button button-ghost"
                onClick={() => {
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || draft.targetAgentIds.length === 0}
                onClick={() => {
                  onReview(note.id, {
                    type: "edit",
                    reviewerName: reviewer,
                    content: draft.content,
                    description: draft.description,
                    severity: draft.severity,
                    targetAgentIds: draft.targetAgentIds,
                    approveAfterEdit: true,
                  });
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                Save and approve
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="note-content">{note.content}</p>
            <p className="note-description">
              <span className="eyebrow">Fires when</span> {note.description}
            </p>
            <div className="note-targets">
              <span className="eyebrow">Routed to</span>
              {note.targetAgentIds.map((id) => (
                <span key={id} className="target-chip">
                  <span className={"role-dot role-" + (memberRole(id) ?? "")} />
                  {agentName(agents, id)}
                </span>
              ))}
            </div>
            {note.rationale && (
              <p className="note-rationale">{note.rationale}</p>
            )}
            {note.safetyReasons.length > 0 && (
              <p className="note-safety">
                Safety: {note.safetyReasons.join(", ")}
              </p>
            )}
            <div className="note-actions">
              {isAwaitingReview(note) && (
                <>
                  <button
                    className="button button-ghost"
                    disabled={busy}
                    onClick={() => startEdit(note)}
                  >
                    Edit
                  </button>
                  <button
                    className="button button-danger"
                    disabled={busy}
                    onClick={() =>
                      onReview(note.id, {
                        type: "reject",
                        reviewerName: reviewer,
                        reason: "Rejected during review",
                      })
                    }
                  >
                    Reject
                  </button>
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() =>
                      onReview(note.id, {
                        type: "approve",
                        reviewerName: reviewer,
                      })
                    }
                  >
                    Approve
                  </button>
                </>
              )}
              {note.status === "active" && (
                <button
                  className="button button-danger"
                  disabled={busy}
                  onClick={() => onRevoke(note.id, "Revoked during review")}
                >
                  Revoke
                </button>
              )}
            </div>
          </>
        )}
      </article>
    );
  };

  return (
    <div className="review">
      <p className="panel-note">
        Approving records <strong>{reviewer}</strong> as the reviewer. This is
        attribution, not authentication — the platform has no identity system.
      </p>
      {awaiting.length > 0 && (
        <>
          <div className="section-label">Awaiting you · {awaiting.length}</div>
          {awaiting.map(renderNote)}
        </>
      )}
      {settled.length > 0 && (
        <>
          <div className="section-label">Decided · {settled.length}</div>
          {settled.map(renderNote)}
        </>
      )}
    </div>
  );
}
