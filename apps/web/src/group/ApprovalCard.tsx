/**
 * The inline memory-approval card.
 *
 * When the pipeline parks a note for a human (severe, quarantined, redaction, or
 * broad routing — see `requiresHumanReview` on the server), it surfaces right in
 * the conversation as a card: "this is what the team learned, here is where it
 * would land, approve it?" The three actions map straight onto the existing
 * review contract:
 *   Approve            -> { type: "approve" }
 *   Approve with edits -> { type: "edit", approveAfterEdit: true }
 *   Reject             -> { type: "reject", reason }
 *
 * The full Review surface (severity, routing, the description Codex matches on)
 * still lives under Audit; this is the fast path for the common decision.
 *
 * Today notes arrive when the task finishes and consolidates. When the partial
 * consolidator lands, they will appear mid-conversation instead — the same card,
 * in the same place.
 */
import { useState } from "react";
import type { Agent, AgentGroup, MemoryNote } from "../types";
import { agentName, reviewReasons } from "./format";

export function ApprovalCard({
  note,
  agents,
  group,
  reviewer,
  busy,
  onReview,
  onRevoke,
}: {
  note: MemoryNote;
  agents: Agent[];
  group: AgentGroup;
  reviewer: string;
  busy: boolean;
  onReview: (noteId: string, input: import("../types").ReviewNoteInput) => void;
  onRevoke: (noteId: string, reason: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);

  const severe = note.severity === "severe";
  const quarantined = note.status === "quarantined";
  // The severity pill already states "severe"; don't repeat it as a reason chip.
  const reasons = reviewReasons(note).filter((reason) => reason !== "severe");
  const targets = note.targetAgentIds.map((id) => agentName(agents, id));
  // Members not in the routing list — the withheld side of the decision.
  const withheld = group.members
    .map((member) => agentName(agents, member.agentId))
    .filter((name) => !targets.includes(name));

  return (
    <article
      className={"approval-card" + (quarantined ? " approval-quarantined" : "")}
      aria-label="Memory approval needed"
    >
      <div className="approval-head">
        <span className="approval-icon" aria-hidden="true">
          {quarantined ? "⚠" : "✋"}
        </span>
        <strong>
          {quarantined ? "Quarantined memory — review" : "Memory approval needed"}
        </strong>
        <span className={"approval-sev " + (severe ? "is-severe" : "is-normal")}>
          {severe ? "severe" : "normal"}
        </span>
        {reasons.map((reason) => (
          <span key={reason} className="approval-reason">
            {reason}
          </span>
        ))}
      </div>

      <p className="approval-dest">
        {severe ? (
          <>
            This will be written to <code>AGENTS.md</code> — always loaded for{" "}
            <strong>{targets.join(", ") || "the team"}</strong>.
          </>
        ) : (
          <>
            This will be saved as a <strong>skill</strong> — loaded on match for{" "}
            <strong>{targets.join(", ") || "the team"}</strong>.
          </>
        )}
        {withheld.length > 0 && (
          <span className="approval-withheld">
            {" "}
            Withheld from {withheld.join(", ")}.
          </span>
        )}
      </p>

      {editing ? (
        <textarea
          className="approval-edit"
          rows={4}
          value={draft}
          maxLength={2000}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Edit memory content"
        />
      ) : (
        <blockquote className="approval-content">{note.content}</blockquote>
      )}

      {note.description && !editing && (
        <p className="approval-fires">
          <span className="eyebrow">Fires when</span> {note.description}
        </p>
      )}
      {quarantined && note.safetyReasons.length > 0 && !editing && (
        <p className="approval-safety">Safety: {note.safetyReasons.join(", ")}</p>
      )}

      <div className="approval-actions">
        {editing ? (
          <>
            <button
              className="button button-ghost"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setDraft(note.content);
              }}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              disabled={busy || !draft.trim()}
              onClick={() =>
                onReview(note.id, {
                  type: "edit",
                  reviewerName: reviewer,
                  content: draft.trim(),
                  approveAfterEdit: true,
                })
              }
            >
              Save &amp; approve
            </button>
          </>
        ) : (
          <>
            <button
              className="button button-danger"
              disabled={busy}
              onClick={() =>
                onReview(note.id, {
                  type: "reject",
                  reviewerName: reviewer,
                  reason: "Rejected in conversation",
                })
              }
            >
              Reject
            </button>
            <button
              className="button button-ghost"
              disabled={busy}
              onClick={() => {
                setDraft(note.content);
                setEditing(true);
              }}
            >
              Approve with edits
            </button>
            <button
              className="button button-primary"
              disabled={busy}
              onClick={() =>
                onReview(note.id, { type: "approve", reviewerName: reviewer })
              }
            >
              Approve
            </button>
          </>
        )}
      </div>
    </article>
  );
}
