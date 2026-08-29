/**
 * Create or edit a group.
 *
 * A4: membership is role-bound. The v1 plan is a fixed five-node chain whose
 * nodes reference ROLES, not Agent names or list order, so a group needs
 * exactly one backend, one frontend and one security member. Anything else and
 * `startGroupTask` cannot build the chain, so the form refuses to submit rather
 * than letting the server 409 later.
 */
import { useMemo, useState } from "react";
import type { Agent, AgentGroup, GroupMember, GroupRole } from "../types";
import { ROLES } from "./format";

const CHAIN_PREVIEW: readonly { role: GroupRole; label: string }[] = [
  { role: "backend", label: "contract" },
  { role: "frontend", label: "plan" },
  { role: "security", label: "review" },
  { role: "backend", label: "implement" },
  { role: "frontend", label: "implement" },
];

interface Props {
  agents: Agent[];
  /** Present when editing; absent when creating. */
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
  // agentId -> role. Deliberately starts EMPTY on create: "Do not auto-select
  // all Agents by default" (FRONTEND-UI.md). Membership is a governance
  // boundary, so it has to be an explicit act.
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
      Object.entries(assignments).map(([agentId, role]) => ({ agentId, role })),
    [assignments],
  );

  const roleHolder = (role: GroupRole): Agent | null => {
    const entry = Object.entries(assignments).find(
      ([, assigned]) => assigned === role,
    );
    if (!entry) return null;
    return agents.find((agent) => agent.id === entry[0]) ?? null;
  };

  const missingRoles = ROLES.filter((role) => !roleHolder(role));
  const valid = name.trim().length > 0 && missingRoles.length === 0;

  const toggle = (agentId: string) => {
    setAssignments((prev) => {
      const next = { ...prev };
      if (next[agentId]) {
        delete next[agentId];
        return next;
      }
      // Assign the first role nobody holds yet, so the common path is one click.
      const taken = new Set(Object.values(next));
      const free = ROLES.find((role) => !taken.has(role));
      if (!free) return next; // all three roles held; untoggle someone first
      next[agentId] = free;
      return next;
    });
  };

  const assignRole = (agentId: string, role: GroupRole) => {
    setAssignments((prev) => {
      const next = { ...prev };
      const previousRole = next[agentId];
      const currentHolder = Object.keys(next).find(
        (id) => next[id] === role && id !== agentId,
      );
      next[agentId] = role;
      // A role is held by exactly one Agent. SWAP with the current holder
      // rather than dropping it: silently unassigning someone invalidates the
      // whole form and the user has to work out which role went missing.
      if (currentHolder) {
        if (previousRole) {
          next[currentHolder] = previousRole;
        } else {
          delete next[currentHolder];
        }
      }
      return next;
    });
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
          <span className="eyebrow">
            {group ? "Edit team" : "New team"}
          </span>
          <h2>{group ? "Update membership" : "Assemble a team"}</h2>
          <p>
            Pick three Agents and give each one a role. The plan binds its steps
            to roles, so any three Agents can run it.
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
          <span className={missingRoles.length ? "roster-missing" : "roster-ok"}>
            {missingRoles.length === 0
              ? "all roles filled"
              : "still need: " + missingRoles.join(", ")}
          </span>
        </div>

        <div className="roster">
          {agents.length === 0 && (
            <p className="muted-note">
              No Agents yet. Create at least three from the Agents view first.
            </p>
          )}
          {agents.map((agent) => {
            const role = assignments[agent.id];
            return (
              <div
                key={agent.id}
                className={"roster-row " + (role ? "is-member" : "")}
              >
                <label className="roster-toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(role)}
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
                <div className="role-picker" aria-label={"Role for " + agent.name}>
                  {ROLES.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={
                        "role-chip " + (role === option ? "selected" : "")
                      }
                      disabled={!role}
                      onClick={() => assignRole(agent.id, option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {valid && (
          <div className="chain-preview">
            <span className="eyebrow">The plan this team will run</span>
            <ol>
              {CHAIN_PREVIEW.map((step, index) => {
                const holder = roleHolder(step.role);
                return (
                  <li key={index}>
                    <span className={"role-dot role-" + step.role} />
                    {holder?.name ?? step.role}
                    <em>{step.label}</em>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

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
