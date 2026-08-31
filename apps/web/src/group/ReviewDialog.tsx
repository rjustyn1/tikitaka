/**
 * The approval popup: the exact file change a note would make, per recipient,
 * with approve / reject on it.
 *
 * The preview comes from the server, composed by the same code that performs
 * the write, so what a human approves here is what lands. A file that does not
 * exist yet is shown as a single pane -- there is no "before" to compare
 * against, and faking one would misreport a create as an edit. An existing
 * file is shown as two panes, old on the left and new on the right.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Agent, MemoryFilePreview, MemoryNote, ReviewNoteInput } from "../types";
import { agentName } from "./format";
import { diffLines, diffStat } from "./line-diff";

function FileDiff({ file }: { file: MemoryFilePreview }) {
  const rows = useMemo(() => diffLines(file.before, file.after), [file]);
  const stat = useMemo(() => diffStat(rows), [rows]);

  if (file.mode === "create") {
    return (
      <div className="review-diff is-create">
        <div className="review-diff-pane">
          <div className="review-pane-head">
            New file · {stat.added} line{stat.added === 1 ? "" : "s"}
          </div>
          <pre>
            {rows.map((row, index) => (
              <span key={index} className="review-line is-added">
                <span className="review-gutter">{row.right.n}</span>
                <span className="review-sign">+</span>
                {row.right.text || " "}
              </span>
            ))}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="review-diff">
      <div className="review-diff-pane">
        <div className="review-pane-head">Before</div>
        <pre>
          {rows.map((row, index) => (
            <span
              key={index}
              className={
                "review-line " + (row.kind === "removed" ? "is-removed" : "is-context")
              }
            >
              <span className="review-gutter">{row.left.n ?? ""}</span>
              <span className="review-sign">{row.kind === "removed" ? "−" : " "}</span>
              {row.left.text === null ? " " : row.left.text || " "}
            </span>
          ))}
        </pre>
      </div>
      <div className="review-diff-pane">
        <div className="review-pane-head">
          After · +{stat.added}
          {stat.removed > 0 ? " −" + stat.removed : ""}
        </div>
        <pre>
          {rows.map((row, index) => (
            <span
              key={index}
              className={
                "review-line " + (row.kind === "added" ? "is-added" : "is-context")
              }
            >
              <span className="review-gutter">{row.right.n ?? ""}</span>
              <span className="review-sign">{row.kind === "added" ? "+" : " "}</span>
              {row.right.text === null ? " " : row.right.text || " "}
            </span>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function ReviewDialog({
  note,
  agents,
  reviewer,
  busy,
  onReview,
  onClose,
}: {
  note: MemoryNote;
  agents: Agent[];
  reviewer: string;
  busy: boolean;
  onReview: (noteId: string, input: ReviewNoteInput) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<MemoryFilePreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(null);
    void api
      .notePreview(note.id)
      .then((response) => {
        if (alive) setFiles(response.files);
      })
      .catch((failure) => {
        if (alive) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      alive = false;
    };
  }, [note.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop review-dialog-backdrop" onClick={onClose}>
      <div
        className="review-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Review governed memory"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="review-dialog-head">
          <div>
            <h2>{note.description}</h2>
            <p>
              {note.severity === "severe"
                ? "Severe · lands in AGENTS.md, always in context"
                : "Normal · lands as a skill, loaded on match"}
              {" · "}
              {note.targetAgentIds.length} recipient
              {note.targetAgentIds.length === 1 ? "" : "s"}
            </p>
          </div>
          <button
            className="workspace-explorer-expand"
            onClick={onClose}
            aria-label="Close review"
          >
            ✕
          </button>
        </div>

        <div className="review-dialog-body">
          <blockquote className="review-note-content">{note.content}</blockquote>

          {error ? (
            <p className="workspace-explorer-state" role="alert">{error}</p>
          ) : files === null ? (
            <p className="workspace-explorer-state">Composing the change…</p>
          ) : files.length === 0 ? (
            <p className="workspace-explorer-state">
              This note has no recipients, so approving it would write nothing.
            </p>
          ) : (
            files.map((file) => (
              <section key={file.agentId + file.path} className="review-file">
                <div className="review-file-head">
                  <strong>{agentName(agents, file.agentId)}</strong>
                  <span className={"review-mode is-" + file.mode}>
                    {file.mode === "create" ? "new file" : "modified"}
                  </span>
                  <code title={file.path}>{file.path.split("/").slice(-3).join("/")}</code>
                </div>
                <FileDiff file={file} />
              </section>
            ))
          )}
        </div>

        <div className="review-dialog-foot">
          <input
            className="review-reason"
            placeholder="Reason (required to reject)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
            aria-label="Rejection reason"
          />
          <button
            className="button button-ghost"
            disabled={busy || reason.trim().length === 0}
            title={
              reason.trim().length === 0
                ? "Give a reason so the ledger records why"
                : "Reject this note"
            }
            onClick={() =>
              onReview(note.id, {
                type: "reject",
                reviewerName: reviewer,
                reason: reason.trim(),
              })
            }
          >
            Reject
          </button>
          <button
            className="button"
            disabled={busy || files === null || files.length === 0}
            onClick={() =>
              onReview(note.id, { type: "approve", reviewerName: reviewer })
            }
          >
            {busy ? "Applying…" : "Approve and write"}
          </button>
        </div>
      </div>
    </div>
  );
}
