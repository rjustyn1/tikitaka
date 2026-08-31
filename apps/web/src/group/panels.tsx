/**
 * Presentational panels for a group task.
 *
 * These render only what the server persisted. Nothing here infers state the
 * backend did not record, because the demo's claim is that the audit is real.
 */
import { useEffect, useRef, useState } from "react";
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
  fileTail,
  formatTime,
  grantTone,
  orderedNodes,
  roleClass,
  roleOf,
  shortId,
  statusTone,
  withheldReason,
} from "./format";
import { PlanGraph } from "./PlanGraph";

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

/** A dependency's step name, so the graph reads in words rather than in ids. */
function roleOfNode(nodes: GroupPlanNode[], id: string): string {
  return nodes.find((node) => node.id === id)?.nodeRole ?? shortId(id);
}

/**
 * How many steps share a predecessor with another step — i.e. how much of the
 * plan is genuinely branched rather than sequential. Zero means a straight
 * chain, which is also what the planner's offline fallback produces.
 */
function concurrentSteps(nodes: GroupPlanNode[]): number {
  const dependents = new Map<string, number>();
  for (const node of nodes) {
    for (const id of node.dependsOn) {
      dependents.set(id, (dependents.get(id) ?? 0) + 1);
    }
  }
  return nodes.filter((node) =>
    node.dependsOn.some((id) => (dependents.get(id) ?? 0) > 1),
  ).length;
}

/** The planner-authored node order, with live status per node. */
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
    <ChainBody nodes={nodes} agents={agents} group={group} onOpenTrace={onOpenTrace} />
  );
}

/**
 * Split out so the selection hooks sit below the empty-state early return
 * rather than being called conditionally.
 */
function ChainBody({
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // Picking a node in the graph brings its card into view; the graph is the
  // map, the card is the detail.
  useEffect(() => {
    if (!selectedId) return;
    cardRefs.current
      .get(selectedId)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const parallelGroups = concurrentSteps(nodes);
  return (
    <div className="chain">
      <PlanGraph
        nodes={nodes}
        agents={agents}
        group={group}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
      />
      {parallelGroups > 0 && (
        <p className="chain-shape">
          This plan branches: {parallelGroups} step
          {parallelGroups === 1 ? "" : "s"} have work that can run alongside
          another step rather than waiting for it.
        </p>
      )}
      {orderedNodes(nodes).map((node, index) => (
        <div
          key={node.id}
          ref={(element) => {
            if (element) cardRefs.current.set(node.id, element);
            else cardRefs.current.delete(node.id);
          }}
          className={
            "chain-node status-" + node.status +
            (node.id === selectedId ? " selected" : "")
          }
        >
          <div className="chain-index">{index + 1}</div>
          <div className="chain-body">
            <div className="chain-title">
              <strong>{node.nodeRole}</strong>
              <Pill tone={statusTone(node.status)}>{node.status}</Pill>
              {node.kind === "join" && <Pill tone="ok">join</Pill>}
              {node.readOnly && <Pill tone="idle">read-only</Pill>}
              {/*
                A retried node succeeded on a later try. Worth showing: the run
                the Trace button opens is the LAST attempt, and the earlier
                failed one is a separate run row behind it.
              */}
              {(node.attempts ?? 1) > 1 && (
                <Pill tone="warn">
                  {"attempt " + node.attempts}
                </Pill>
              )}
            </div>
            {/*
              The graph, not just the order. The plan is a DAG — steps fan out
              and rejoin — and rendering it as a bare numbered list made every
              plan look like a straight chain regardless of its real shape.
            */}
            <div className="chain-deps">
              {node.dependsOn.length === 0 ? (
                <span className="chain-dep chain-dep-entry">starts the plan</span>
              ) : (
                <>
                  <span className="chain-dep-label">after</span>
                  {node.dependsOn.map((id) => (
                    <span key={id} className="chain-dep">
                      {roleOfNode(nodes, id)}
                    </span>
                  ))}
                </>
              )}
            </div>
            <div className="chain-meta">
              <span>
                <span
                  className={
                    "role-dot role-" +
                    roleClass(roleOf(group.members, node.agentId))
                  }
                />
                {agentName(agents, node.agentId)}
              </span>
              <span>{durationOf(node.startedAt, node.completedAt)}</span>
              {node.fileOwnershipHints.length > 0 && (
                <code>{node.fileOwnershipHints.join(", ")}</code>
              )}
            </div>
            {/*
              The mini-plan. This is planner output the server persisted per
              row — read here, never reconstructed, and a row that predates the
              planner says so rather than showing a template.
            */}
            <div className="chain-plan">
              <span className="eyebrow">Told to</span>
              {node.instruction?.trim() ? (
                <p>{node.instruction}</p>
              ) : (
                <p className="chain-plan-missing">
                  No instruction was recorded for this step.
                </p>
              )}
            </div>
            {node.expectedOutput.trim() && (
              <div className="chain-plan">
                <span className="eyebrow">Expected output</span>
                <p>{node.expectedOutput}</p>
              </div>
            )}
            {node.output && (
              <div className="chain-plan">
                <span className="eyebrow">Result</span>
                <p className="chain-output">{node.output}</p>
              </div>
            )}
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
                      roleClass(
                        message.speakerAgentId
                          ? roleOf(group.members, message.speakerAgentId)
                          : null,
                      )
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
                      {fileTail(grant.filePath, 3)}
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
                <code title={file.path}>{fileTail(file.path, 3)}</code>
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
