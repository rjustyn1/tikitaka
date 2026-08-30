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
  const [selected, setSelected] = useState<string[]>(
    () => (group?.members ?? []).map((member) => member.agentId),
  );

  // Saving re-derives every label, so editing a team also repairs one whose
  // stored labels were wrong before.
  const members = useMemo<GroupMember[]>(
    () =>
      selected.map((agentId) => ({
        agentId,
        role: deriveRole(
          agents.find((agent) => agent.id === agentId)?.name ?? "",
        ),
      })),
    [selected, agents],
  );

  const valid =
    name.trim().length > 0 &&
    members.length >= 1 &&
    members.length <= MAX_MEMBERS;

  const toggle = (agentId: string) => {
    setSelected((previous) =>
      previous.includes(agentId)
        ? previous.filter((id) => id !== agentId)
        : previous.length < MAX_MEMBERS
          ? [...previous, agentId]
          : previous,
    );
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
            description and decides who works on each task.
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
                    <span className="role-chip">{deriveRole(agent.name)}</span>
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
