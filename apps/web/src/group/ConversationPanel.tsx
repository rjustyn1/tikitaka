/**
 * The team's shared conversation, promoted to the primary surface.
 *
 * The turns come from the app-owned group transcript, in `seq` order — the same
 * rows the old Transcript tab rendered. What is new is the shape: an avatar
 * gutter so a reader can follow one Agent down the page, and the goal composer
 * sitting under the feed where a chat input belongs, rather than a separate form
 * above seven equal-weight tabs.
 */
import type { Agent, AgentGroup, GroupMessage } from "../types";
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
}: {
  messages: GroupMessage[];
  agents: Agent[];
  group: AgentGroup;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  running: boolean;
  busy: boolean;
}) {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  return (
    <section className="chat">
      <div className="chat-feed">
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
