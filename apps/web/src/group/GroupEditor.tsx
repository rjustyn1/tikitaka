/**
 * Create or edit a team.
 *
 * Team creation is membership ONLY: pick the Agents who may collaborate.
 *
 * There is deliberately no role picker. The planner decides who works on each
 * node by reading every candidate Agent's `description`, and never reads a role
 * label -- so a picker offered an authoritative-looking choice that changed
 * nothing, and let a "Security Agent" be saved as `frontend`, which then drove
 * the wrong colour dot in the sidebar, the member rail and the chat. The label
 * is derived from the Agent instead, so it cannot disagree with it.
 */
import { useMemo, useState } from "react";
import type { Agent, AgentGroup, GroupMember } from "../types";
import { deriveRole } from "./format";

const MAX_MEMBERS = 12;

/**
 * The only labels a team member may carry. Free text and "member" are gone:
 * the label is cosmetic (the planner reads each Agent's `description`, never
 * this), so a closed set of three keeps every dot and caption in the sidebar,
 * member rail and chat to a known colour.
 */
const ROLE_OPTIONS = ["backend", "frontend", "security"] as const;

/**
 * The label to start an Agent on: its own name when that is one of the three,
 * otherwise the first option. A human can always change it -- that is what the
 * picker is for -- but the default never contradicts the Agent it is on.
 */
function defaultRole(agentName: string): string {
  const derived = deriveRole(agentName);
  return (ROLE_OPTIONS as readonly string[]).includes(derived)
    ? derived
    : ROLE_OPTIONS[0];
}

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
  // Ordered so the submitted roster keeps the order Agents were picked in.
  const [selected, setSelected] = useState<string[]>(
    () => (group?.members ?? []).map((member) => member.agentId),
  );
  const [roles, setRoles] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const member of group?.members ?? []) {
      const stored = member.role?.trim().toLowerCase() ?? "";
      // A stored label outside the three (legacy "member", or a name-derived
      // one) is clamped rather than added as a fourth option.
      initial[member.agentId] = (ROLE_OPTIONS as readonly string[]).includes(
        stored,
      )
        ? stored
        : defaultRole(
            agents.find((agent) => agent.id === member.agentId)?.name ?? "",
          );
    }
    return initial;
  });

  const members = useMemo<GroupMember[]>(
    () =>
      selected.map((agentId) => ({
        agentId,
        role:
          roles[agentId] ??
          defaultRole(agents.find((agent) => agent.id === agentId)?.name ?? ""),
      })),
    [selected, roles, agents],
  );

  const valid =
    name.trim().length > 0 &&
    members.length >= 1 &&
    members.length <= MAX_MEMBERS;

  const toggle = (agentId: string) => {
    setSelected((previous) => {
      if (previous.includes(agentId)) {
        return previous.filter((id) => id !== agentId);
      }
      if (previous.length >= MAX_MEMBERS) return previous;
      setRoles((current) =>
        Object.hasOwn(current, agentId)
          ? current
          : {
              ...current,
              [agentId]: defaultRole(
                agents.find((agent) => agent.id === agentId)?.name ?? "",
              ),
            },
      );
      return [...previous, agentId];
    });
  };

  const assignRole = (agentId: string, role: string) => {
    setRoles((previous) => ({ ...previous, [agentId]: role }));
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
            Pick the Agents on this team. The planner reads each Agent's own
            description and decides who works on each task — the role label is
            only how each Agent is shown.
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
              const picked = selected.includes(agent.id);
              return (
                <div
                  key={agent.id}
                  className={"roster-row " + (picked ? "is-member" : "")}
                >
                  <label className="roster-toggle">
                    <input
                      type="checkbox"
                      checked={picked}
                      disabled={!picked && members.length >= MAX_MEMBERS}
                      onChange={() => toggle(agent.id)}
                    />
                    <span className="agent-avatar">
                      {agent.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="roster-copy">
                      <strong>{agent.name}</strong>
                      {/*
                        The Agent's own description, which is the text the
                        planner actually reads when it decides who does what.
                      */}
                      <span>{agent.description || "Coding Agent"}</span>
                    </span>
                  </label>
                  {picked && (
                    <select
                      className="role-select"
                      aria-label={"Role for " + agent.name}
                      value={
                        roles[agent.id] ?? defaultRole(agent.name)
                      }
                      onChange={(event) =>
                        assignRole(agent.id, event.target.value)
                      }
                    >
                      {ROLE_OPTIONS.map((option) => (
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
