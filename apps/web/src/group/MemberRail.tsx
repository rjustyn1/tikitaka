/**
 * The Agent profile panel — who is on this team, what each one is doing, and
 * what each one currently knows.
 *
 * That last part is the whole product: a member card says "holds no governed
 * memory" as confidently as it says "holds two files", because a withheld
 * memory is a result, not a gap. The three states a card can be in — held,
 * empty, unknown — are kept distinct for exactly that reason.
 */
import type {
  Agent,
  AgentGroup,
  GroupPlanNode,
  GroupTaskStatus,
  LandedMemoryFile,
  MemoryNote,
} from "../types";
import { agentName, fileTail, roleClass } from "./format";
import { liveStatusFor } from "./liveStatus";

export function MemberRail({
  group,
  agents,
  nodes,
  taskStatus,
  memory,
  memoryLoading,
  memoryFailed,
  onOpenTrace,
  pendingNotes,
  onReviewNote,
}: {
  group: AgentGroup;
  agents: Agent[];
  nodes: GroupPlanNode[];
  taskStatus: GroupTaskStatus | null;
  memory: Record<string, LandedMemoryFile[]>;
  memoryLoading: boolean;
  memoryFailed: boolean;
  onOpenTrace: (runId: string) => void;
  /** Notes still awaiting a human decision, any recipient. */
  pendingNotes: MemoryNote[];
  onReviewNote: (note: MemoryNote) => void;
}) {
  return (
    <aside className="member-rail" aria-label="Team members">
      <div className="member-rail-head">
        <span className="eyebrow">Members</span>
        <span className="member-rail-count">{group.members.length}</span>
      </div>
      {group.members.map((member) => {
        const agent = agents.find((item) => item.id === member.agentId);
        const name = agentName(agents, member.agentId);
        const status = liveStatusFor(member.agentId, nodes, taskStatus);
        const held = (memory[member.agentId] ?? []).filter(
          (file) => file.removedAt === null,
        );
        const liveNode = nodes.find(
          (node) => node.agentId === member.agentId && node.status === "running",
        );
        // Everything waiting on a human for THIS Agent. A note routed to
        // several Agents appears under each of them, because approving it
        // writes a file into each of their workspaces.
        const waiting = pendingNotes.filter((note) =>
          note.targetAgentIds.includes(member.agentId),
        );
        return (
          <article
            key={member.agentId}
            className={"member-card member-" + status.state}
          >
            <div className="member-identity">
              <span className={"member-avatar role-bg-" + roleClass(member.role)}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <div className="member-name">
                <strong>{name}</strong>
                <span className={"member-role role-text-" + roleClass(member.role)}>
                  {member.role}
                </span>
              </div>
            </div>

            {agent?.description && (
              <p className="member-description">{agent.description}</p>
            )}

            <div className="member-status">
              <span className={"member-state-dot state-" + status.state} />
              <span>{status.label}</span>
              {liveNode?.runId && (
                <button
                  className="member-trace"
                  onClick={() => onOpenTrace(liveNode.runId as string)}
                >
                  Trace
                </button>
              )}
            </div>

            {waiting.length > 0 && (
              <div className="member-pending">
                <span className="eyebrow">
                  Waiting for you · {waiting.length}
                </span>
                <ul className="member-pending-list">
                  {waiting.map((note) => (
                    <li key={note.id}>
                      <span
                        className={
                          "member-pending-kind " +
                          (note.severity === "severe" ? "is-severe" : "is-skill")
                        }
                      >
                        {note.severity === "severe" ? "AGENTS.md" : "skill"}
                      </span>
                      <span className="member-pending-text" title={note.content}>
                        {note.description}
                      </span>
                      <button
                        className="member-pending-review"
                        onClick={() => onReviewNote(note)}
                      >
                        Review
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="member-memory">
              <span className="eyebrow">Governed memory</span>
              {memoryFailed ? (
                <p className="member-memory-empty">Memory state unavailable</p>
              ) : memoryLoading && held.length === 0 ? (
                <p className="member-memory-empty">Reading the workspace…</p>
              ) : held.length === 0 ? (
                <p className="member-memory-empty">Holds no governed memory</p>
              ) : (
                <ul className="member-memory-files">
                  {held.map((file) => (
                    <li key={file.id}>
                      <span
                        className={
                          "member-memory-kind " +
                          (file.kind === "agents_md" ? "is-severe" : "is-skill")
                        }
                      >
                        {file.kind === "agents_md" ? "always on" : "on match"}
                      </span>
                      <code title={file.path}>{fileTail(file.path)}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        );
      })}
    </aside>
  );
}
