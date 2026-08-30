/**
 * Create or edit a team.
 *
 * Team creation is membership only: pick the Agents who may collaborate. Roles
 * here are a display label from the current model (backend / frontend /
 * security) — the planner decides who actually works on each node at task time,
 * and the DAG-assignment flow (task start) is where per-node roles will live.
 */
import { useMemo, useState } from "react";
import type { Agent, AgentGroup, GroupMember, GroupRole } from "../types";

const MAX_MEMBERS = 12;

// The current, hardcoded role model. A team loaded with some other label keeps
// it (added to the list for that row) rather than silently losing it.
const ROLE_OPTIONS = ["backend", "frontend", "security", "member"];

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
    members.length >= 1 &&
    members.length <= MAX_MEMBERS;

  const toggle = (agentId: string) => {
    setAssignments((previous) => {
      const next = { ...previous };
      if (Object.hasOwn(next, agentId)) {
        delete next[agentId];
      } else if (Object.keys(next).length < MAX_MEMBERS) {
        // Default a newly-picked Agent to a generic label; the human can refine.
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
        <div className="group-modal-head">
          <span className="eyebrow">{group ? "Edit team" : "New team"}</span>
          <h2>{group ? "Update membership" : "Assemble a team"}</h2>
          <p>
            Pick the Agents on this team. The planner decides who works on each
            task — the role label is just how each Agent is shown.
          </p>
        </div>

        <div className="group-modal-body">
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
            {/*
              A team is valid at ONE member now, so "3" is not a threshold any
              more -- that was the old exactly-three rule. The denominator is
              how many Agents exist to pick from, not the cap; showing "of 12"
              beside four Agents read as though eight were missing.
            */}
            <span className={members.length > 0 ? "roster-ok" : "roster-missing"}>
              {members.length} of {agents.length} selected
              {members.length >= MAX_MEMBERS && " (max " + MAX_MEMBERS + ")"}
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
              const role = assignments[agent.id] ?? "member";
              const options = ROLE_OPTIONS.includes(role)
                ? ROLE_OPTIONS
                : [role, ...ROLE_OPTIONS];
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
                  {selected && (
                    <select
                      className="role-select"
                      aria-label={"Role for " + agent.name}
                      value={role}
                      onChange={(event) => assignRole(agent.id, event.target.value)}
                    >
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
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
