/**
 * Presentational panels for a group task.
 *
 * These render only what the server persisted. Nothing here infers state the
 * backend did not record, because the demo's claim is that the audit is real.
 */
import type {
  Agent,
  AgentGroup,
  GrantRecord,
  GroupContextInjection,
  GroupMessage,
  GroupPlanNode,
  LandedMemoryFile,
} from "../types";
import {
  agentName,
  durationOf,
  formatTime,
  grantTone,
  orderedNodes,
  roleOf,
  shortId,
  statusTone,
  withheldReason,
} from "./format";

export function Pill({
  tone,
  children,
}: {
  tone: string;
  children: React.ReactNode;
}) {
  return <span className={"pill pill-" + tone}>{children}</span>;
}

export function EmptyState({ icon, title, body }: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div className="panel-empty">
      <span aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

/** The five-node chain, with live status per node. */
export function ChainPanel({
  nodes,
  agents,
  group,
  onOpenTrace,
}: {
  nodes: GroupPlanNode[];
  agents: Agent[];
  group: AgentGroup;
  onOpenTrace: (runId: string) => void;
}) {
  if (nodes.length === 0) {
    return (
      <EmptyState
        icon="◇"
        title="No plan yet"
        body="Start a task and the chain appears here."
      />
    );
  }
  return (
    <div className="chain">
      {orderedNodes(nodes).map((node, index) => (
        <div key={node.id} className={"chain-node status-" + node.status}>
          <div className="chain-index">{index + 1}</div>
          <div className="chain-body">
            <div className="chain-title">
              <strong>{node.nodeRole}</strong>
              <Pill tone={statusTone(node.status)}>{node.status}</Pill>
              {node.readOnly && <Pill tone="idle">read-only</Pill>}
            </div>
            <div className="chain-meta">
              <span>
                <span className={"role-dot role-" + (roleOf(group.members, node.agentId) ?? "")} />
                {agentName(agents, node.agentId)}
              </span>
              <span>{durationOf(node.startedAt, node.completedAt)}</span>
              {node.fileOwnershipHints.length > 0 && (
                <code>{node.fileOwnershipHints.join(", ")}</code>
              )}
            </div>
            {node.output && <p className="chain-output">{node.output}</p>}
            {node.error && <p className="chain-error">{node.error}</p>}
            {node.runtimeLocks.length > 0 && (
              <div className="lock-row">
                {node.runtimeLocks.map((lock) => (
                  <span key={lock} className="lock-chip">
                    🔒 {lock}
                  </span>
                ))}
              </div>
            )}
          </div>
          {node.runId && (
            <button
              className="button button-ghost chain-trace"
              onClick={() => onOpenTrace(node.runId as string)}
            >
              Trace
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** The app-owned group transcript, in seq order. */
export function TimelinePanel({
  messages,
  agents,
  group,
}: {
  messages: GroupMessage[];
  agents: Agent[];
  group: AgentGroup;
}) {
  if (messages.length === 0) {
    return (
      <EmptyState
        icon="◎"
        title="Nothing said yet"
        body="The transcript fills in as each Agent takes its turn."
      />
    );
  }
  return (
    <div className="timeline">
      {[...messages]
        .sort((left, right) => left.seq - right.seq)
        .map((message) => (
          <div
            key={message.id}
            className={"turn turn-" + message.speakerType}
          >
            <div className="turn-head">
              <span className="turn-seq">#{message.seq}</span>
              {message.speakerType === "human" ? (
                <strong>You</strong>
              ) : (
                <>
                  <span
                    className={
                      "role-dot role-" +
                      (message.speakerAgentId
                        ? roleOf(group.members, message.speakerAgentId) ?? ""
                        : "")
                    }
                  />
                  <strong>{agentName(agents, message.speakerAgentId)}</strong>
                </>
              )}
              <span className="turn-time">{formatTime(message.createdAt)}</span>
            </div>
            <p>{message.content}</p>
          </div>
        ))}
    </div>
  );
}

/**
 * What each node was actually shown.
 *
 * IMPORTANT wording: in a sequential chain `withheldMessageIds` means the Agent
 * had ALREADY SEEN those messages on an earlier turn (lastSeenSeq dedupe). It
 * does NOT mean "denied by policy". Governance withholding lives in the grant
 * ledger, where a decision carries a reason. Conflating the two would
 * misrepresent the system to anyone reading this screen.
 */
export function ContextPanel({
  injections,
  nodes,
  agents,
}: {
  injections: GroupContextInjection[];
  nodes: GroupPlanNode[];
  agents: Agent[];
}) {
  if (injections.length === 0) {
    return (
      <EmptyState
        icon="⌁"
        title="No context packets yet"
        body="Each node records exactly what it was shown before it ran."
      />
    );
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  return (
    <div className="packets">
      <p className="panel-note">
        Every node records the exact context it received before Codex ran.
        “Already seen” is transcript de-duplication, not a governance decision —
        that lives in the grant ledger.
      </p>
      {injections.map((injection) => {
        const node = nodeById.get(injection.planNodeId);
        return (
          <div key={injection.id} className="packet">
            <div className="packet-head">
              <strong>{node?.nodeRole ?? shortId(injection.planNodeId)}</strong>
              <span>{agentName(agents, injection.agentId)}</span>
              <span className="turn-time">
                seq {injection.fromSeqExclusive}–{injection.toSeqInclusive}
              </span>
            </div>
            <dl className="packet-grid">
              <div>
                <dt>Injected messages</dt>
                <dd>{injection.injectedMessageIds.length}</dd>
              </div>
              <div>
                <dt>Dependency outputs</dt>
                <dd>{injection.injectedDependencyNodeIds.length}</dd>
              </div>
              <div>
                <dt>Already seen</dt>
                <dd>{injection.withheldMessageIds.length}</dd>
              </div>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The grant ledger — granted AND withheld, each with a named reason.
 *
 * This is the contribution. Nothing else shows the denial.
 */
export function LedgerPanel({
  grants,
  agents,
}: {
  grants: GrantRecord[];
  agents: Agent[];
}) {
  if (grants.length === 0) {
    return (
      <EmptyState
        icon="⚖"
        title="No decisions recorded yet"
        body="Once a task consolidates, every grant and every withholding is listed here."
      />
    );
  }
  const granted = grants.filter((grant) => grant.decision === "granted").length;
  const withheld = grants.length - granted;
  return (
    <div className="ledger">
      <div className="ledger-summary">
        <span><strong>{granted}</strong> granted</span>
        <span><strong>{withheld}</strong> withheld or revoked</span>
      </div>
      <div className="table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Decision</th>
              <th>Reason</th>
              <th>File</th>
              <th>Reviewer</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => (
              <tr key={grant.id}>
                <td>{agentName(agents, grant.agentId)}</td>
                <td>
                  <Pill tone={grantTone(grant.decision)}>{grant.decision}</Pill>
                </td>
                <td>{withheldReason(grant.reason)}</td>
                <td>
                  {grant.filePath ? (
                    <code title={grant.filePath}>
                      {grant.filePath.split("/").slice(-3).join("/")}
                    </code>
                  ) : (
                    <span className="muted-note">no file written</span>
                  )}
                </td>
                <td>{grant.reviewerName ?? "auto"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * What each Agent's workspace actually holds right now.
 *
 * File presence IS the enforcement state, so this panel reads the filesystem
 * through the API rather than inferring anything from note status.
 */
export function LandedMemoryPanel({
  group,
  agents,
  memoryByAgent,
}: {
  group: AgentGroup;
  agents: Agent[];
  memoryByAgent: Record<string, LandedMemoryFile[]>;
}) {
  const memberIds = new Set(group.members.map((member) => member.agentId));
  const outsiders = agents.filter((agent) => !memberIds.has(agent.id));
  const render = (agent: Agent, isMember: boolean) => {
    const files = (memoryByAgent[agent.id] ?? []).filter(
      (file) => file.removedAt === null,
    );
    return (
      <div key={agent.id} className={"memory-card " + (isMember ? "" : "outsider")}>
        <div className="memory-head">
          <strong>{agent.name}</strong>
          {isMember ? (
            <Pill tone="idle">{roleOf(group.members, agent.id) ?? "member"}</Pill>
          ) : (
            <Pill tone="warn">not a member</Pill>
          )}
          <span className="memory-count">{files.length} file{files.length === 1 ? "" : "s"}</span>
        </div>
        {files.length === 0 ? (
          <p className="memory-empty">
            Workspace holds no governed memory. Nothing was written here, so
            there is nothing to load.
          </p>
        ) : (
          <ul className="memory-files">
            {files.map((file) => (
              <li key={file.id}>
                <Pill tone={file.kind === "agents_md" ? "bad" : "ok"}>
                  {file.kind === "agents_md" ? "severe" : "skill"}
                </Pill>
                <code title={file.path}>
                  {file.path.split("/").slice(-3).join("/")}
                </code>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };
  return (
    <div className="memory-grid">
      {group.members.map((member) => {
        const agent = agents.find((item) => item.id === member.agentId);
        return agent ? render(agent, true) : null;
      })}
      {outsiders.map((agent) => render(agent, false))}
    </div>
  );
}
