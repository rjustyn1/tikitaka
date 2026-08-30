/**
 * The team list inside the app's existing sidebar.
 *
 * Deliberately the same shape as `.agent-list`: a card per team, always visible,
 * one click to switch. It replaces a `<select>` that only appeared once a second
 * team existed — so with one team there was no selector at all.
 *
 * The roster dots use the three role accents already declared in styles.css, so
 * a reader can recognise the same Agent here, in the conversation, and in the
 * member rail by colour alone.
 */
import type { Agent, AgentGroup } from "../types";
import { agentName, roleClass } from "./format";

export function TeamSidebar({
  groups,
  agents,
  selectedId,
  onSelect,
  onCreate,
  loading = false,
  error = null,
}: {
  groups: AgentGroup[];
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <>
      <div className="sidebar-label">
        <span>Your Teams</span>
        <span>{groups.length}</span>
      </div>
      <nav className="team-list">
        {groups.map((group) => (
          <button
            key={group.id}
            className={"team-card " + (group.id === selectedId ? "selected" : "")}
            onClick={() => onSelect(group.id)}
            title={group.members
              .map((member) => agentName(agents, member.agentId))
              .join(" · ")}
          >
            {/*
              The mark mirrors `.agent-avatar`, so the card survives the narrow
              breakpoints where the base sidebar drops every card's copy.
            */}
            <span className="team-mark" aria-hidden="true">
              {group.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="team-card-copy">
              <strong>{group.name}</strong>
              <span>
                {group.members.length} member
                {group.members.length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="team-roster-dots" aria-hidden="true">
              {group.members.map((member) => (
                <span
                  key={member.agentId}
                  className={"role-dot role-" + roleClass(member.role)}
                />
              ))}
            </span>
            {group.activeTaskId && (
              <span className="team-live" aria-label="Task running" />
            )}
          </button>
        ))}
        {groups.length === 0 && loading && (
          <div className="empty-sidebar" role="status">
            Loading teams…
          </div>
        )}
        {groups.length === 0 && !loading && error && (
          <div className="empty-sidebar" role="alert">
            Could not load teams.
          </div>
        )}
        {groups.length === 0 && !loading && !error && (
          <div className="empty-sidebar">
            <span>◇</span>
            Put your Agents on one task.
            <button className="team-empty-action" onClick={onCreate}>
              Create a team
            </button>
          </div>
        )}
      </nav>
    </>
  );
}
