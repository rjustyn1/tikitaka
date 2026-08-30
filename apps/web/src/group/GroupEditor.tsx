/** Create or edit a planner-backed Agent group. */
import { useMemo, useState } from "react";
import type { Agent, AgentGroup, GroupMember, GroupRole } from "../types";

const MIN_MEMBERS = 2;
const MAX_MEMBERS = 12;

interface Props {
  agents: Agent[];
  group: AgentGroup | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    name: string;
    description: string;
    members: GroupMember[];
  }) => void;
}

export function GroupEditor({ agents, group, busy, onCancel, onSubmit }: Props) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [assignments, setAssignments] = useState<Record<string, GroupRole>>(
    () => {
      const initial: Record<string, GroupRole> = {};
      for (const member of group?.members ?? []) {
        initial[member.agentId] = member.role;
      }
      return initial;
    },
  );

  const members = useMemo<GroupMember[]>(
    () =>
      Object.entries(assignments).map(([agentId, role]) => ({
        agentId,
        role: role.trim() || "member",
      })),
    [assignments],
  );

  const valid =
    name.trim().length > 0 &&
    members.length >= MIN_MEMBERS &&
    members.length <= MAX_MEMBERS;

  const toggle = (agentId: string) => {
    setAssignments((previous) => {
      const next = { ...previous };
      if (Object.hasOwn(next, agentId)) {
        delete next[agentId];
      } else if (Object.keys(next).length < MAX_MEMBERS) {
        next[agentId] = "member";
      }
      return next;
    });
  };

  const assignRole = (agentId: string, role: string) => {
    setAssignments((previous) => ({ ...previous, [agentId]: role }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit({ name: name.trim(), description: description.trim(), members });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal group-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <span className="eyebrow">{group ? "Edit team" : "New team"}</span>
          <h2>{group ? "Update membership" : "Assemble a team"}</h2>
          <p>
            Select the Agents who may collaborate. Their labels identify them
            in the team; the planner decides who works on each task.
          </p>
        </div>

        <label>
          Team name
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Upload Feature Team"
            maxLength={80}
            required
          />
        </label>
        <label>
          Description
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this team for?"
            maxLength={500}
          />
        </label>

        <div className="roster-head">
          <span className="eyebrow">Members</span>
          <span
            className={
              members.length >= MIN_MEMBERS ? "roster-ok" : "roster-missing"
            }
          >
            {members.length} of {MAX_MEMBERS} selected
          </span>
        </div>

        <div className="roster">
          {agents.length === 0 && (
            <p className="muted-note">
              No Agents yet. Create an Agent from the Agents view first.
            </p>
          )}
          {agents.map((agent) => {
            const selected = Object.hasOwn(assignments, agent.id);
            const role = assignments[agent.id] ?? "";
            return (
              <div
                key={agent.id}
                className={"roster-row " + (selected ? "is-member" : "")}
              >
                <label className="roster-toggle">
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!selected && members.length >= MAX_MEMBERS}
                    onChange={() => toggle(agent.id)}
                  />
                  <span className="agent-avatar">
                    {agent.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="roster-copy">
                    <strong>{agent.name}</strong>
                    <span>{agent.description || "Coding Agent"}</span>
                  </span>
                </label>
                <input
                  className="role-label-input"
                  aria-label={"Role for " + agent.name}
                  value={role}
                  disabled={!selected}
                  placeholder="member"
                  maxLength={40}
                  onChange={(event) => assignRole(agent.id, event.target.value)}
                />
              </div>
            );
          })}
        </div>

        <div className="modal-footer">
          <button type="button" className="button button-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="button button-primary" disabled={!valid || busy}>
            {group ? "Save team" : "Create team"}
          </button>
        </div>
      </form>
    </div>
  );
}
