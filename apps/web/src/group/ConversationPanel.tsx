/**
 * The team's shared conversation, promoted to the primary surface.
 *
 * The turns come from the app-owned group transcript, in `seq` order — the same
 * rows the old Transcript tab rendered. What is new is the shape: an avatar
 * gutter so a reader can follow one Agent down the page, and the goal composer
 * sitting under the feed where a chat input belongs, rather than a separate form
 * above seven equal-weight tabs.
 */
import { useEffect, useRef } from "react";
import type {
  Agent,
  AgentGroup,
  GroupMessage,
  MemoryNote,
  ReviewNoteInput,
} from "../types";
import { ApprovalCard } from "./ApprovalCard";
import { agentName, formatTime, roleClass, roleOf } from "./format";
import { EmptyState } from "./panels";

export function ConversationPanel({
  messages,
  agents,
  group,
  prompt,
  onPromptChange,
  onSubmit,
  running,
  busy,
  pendingNotes,
  reviewer,
  busyNoteId,
  onReview,
  onRevoke,
}: {
  messages: GroupMessage[];
  agents: Agent[];
  group: AgentGroup;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  running: boolean;
  busy: boolean;
  /** Notes parked for a human — surfaced as approval cards in the feed. */
  pendingNotes: MemoryNote[];
  reviewer: string;
  busyNoteId: string | null;
  onReview: (noteId: string, input: ReviewNoteInput) => void;
  onRevoke: (noteId: string, reason: string) => void;
}) {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  // Classic chat: keep the newest turn in view as the transcript grows.
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ordered.length, pendingNotes.length]);
  return (
    <section className="chat">
      <div className="chat-feed" ref={feedRef}>
        {ordered.length === 0 ? (
          <EmptyState
            icon="◎"
            title="No conversation yet"
            body="Give the team a goal below. Each Agent takes its turn on one shared codebase, and every turn lands here."
          />
        ) : (
          ordered.map((message) => {
            const human = message.speakerType === "human";
            const role = message.speakerAgentId
              ? roleOf(group.members, message.speakerAgentId)
              : null;
            const name = human
              ? "You"
              : agentName(agents, message.speakerAgentId);
            return (
              <article
                key={message.id}
                className={"chat-turn " + (human ? "chat-human" : "chat-agent")}
              >
                <span
                  className={
                    "chat-avatar " +
                    (role ? "role-bg-" + roleClass(role) : "chat-avatar-human")
                  }
                  aria-hidden="true"
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <div className="chat-body">
                  <div className="chat-meta">
                    <strong>{name}</strong>
                    {role && (
                      <span className={"chat-role role-text-" + roleClass(role)}>
                        {role}
                      </span>
                    )}
                    <span className="chat-time">
                      {formatTime(message.createdAt)}
                    </span>
                  </div>
                  <p>{message.content}</p>
                </div>
              </article>
            );
          })
        )}

        {pendingNotes.length > 0 && (
          <div className="approval-stack">
            {pendingNotes.map((note) => (
              <ApprovalCard
                key={note.id}
                note={note}
                agents={agents}
                group={group}
                reviewer={reviewer}
                busy={busyNoteId === note.id}
                onReview={onReview}
                onRevoke={onRevoke}
              />
            ))}
          </div>
        )}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <input
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={
            running
              ? "A task is already running for this team…"
              : "Give the team one goal — e.g. Plan and implement an upload feature."
          }
          disabled={running || busy}
          maxLength={50_000}
          aria-label="Team goal"
        />
        <button
          className="button button-primary"
          disabled={running || busy || !prompt.trim()}
        >
          Start task
        </button>
      </form>
    </section>
  );
}
