export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type TraceSpanType =
  | "reasoning"
  | "command_exec"
  | "file_write"
  | "tool_call"
  | "agent_message"
  | "error";

export type TraceSpanStatus = "started" | "completed" | "failed" | "incomplete";

export type TraceSpanPayload =
  | { kind: "reasoning"; text: string; truncated: boolean; terminal?: boolean }
  | { kind: "command_exec"; command: string; exitCode: number | null; output: string; outputTruncated: boolean }
  | { kind: "file_write"; changes: Array<{ path: string; changeKind: "add" | "update" | "delete" | "unknown" }> }
  | { kind: "tool_call"; server: string; tool: string; arguments: unknown; result: unknown }
  | { kind: "agent_message"; text: string }
  | { kind: "error"; message: string; fatal: boolean };

export interface TraceSpan {
  id: string;
  runId: string;
  agentId: string;
  seq: number;
  type: TraceSpanType;
  parentId: string | null;
  status: TraceSpanStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  payload: TraceSpanPayload;
  itemId: string | null;
}

export interface RunTraceSummary {
  spanCount: number;
  failedSpanCount: number;
  reasoningCount: number;
  actionCount: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  traceSummary: RunTraceSummary | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Group chat + DAG types (see middlewaredoc/SPEC.md)
// ---------------------------------------------------------------------------

/**
 * A member's label inside a group.
 *
 * The three v1 labels are kept as documented suggestions ONLY -- membership is
 * no longer role-bound. A4's "exactly three, one per role" rule is gone: the
 * planner reads each Agent's `description` and decides who is relevant to a
 * task, so a group may hold any explicitly selected number of Agents carrying
 * any labels. `(string & {})` keeps editor completion for the three familiar
 * labels while accepting anything.
 */
export type GroupRole = "backend" | "frontend" | "security" | (string & {});

export interface GroupMember {
  agentId: string;
  role: GroupRole;
}

export interface AgentGroup {
  id: string;
  name: string;
  description: string;
  members: GroupMember[];
  activeTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupParticipantState {
  groupId: string;
  agentId: string;
  membershipEpoch: number;
  role: string;
  agentWorkspacePath: string;
  groupThreadId: string | null;
  lastSeenSeq: number;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export interface GroupTask {
  id: string;
  groupId: string;
  prompt: string;
  sharedCodePath: string;
  status: GroupTaskStatus;
  currentNodeId: string | null;
  nodeRunIds: string[];
  flushedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GroupMessage {
  id: string;
  groupId: string;
  seq: number;
  speakerType: "human" | "agent";
  speakerAgentId: string | null;
  groupTaskId: string | null;
  planNodeId: string | null;
  content: string;
  createdAt: string;
}

export type GroupPlanNodeKind = "work" | "join";

export interface GroupPlanNode {
  id: string;
  groupTaskId: string;
  agentId: string;
  kind: GroupPlanNodeKind;
  nodeRole: string;
  dependsOn: string[];
  contextSnapshotSeq: number;
  allowedPlanNodeIds: string[];
  status: GroupTaskStatus;
  runId: string | null;
  output: string | null;
  error: string | null;
  readOnly: boolean;
  fileOwnershipHints: string[];
  runtimeLocks: string[];
  /**
   * What this Agent was actually told to do on this node -- PLANNER OUTPUT,
   * persisted per node.
   *
   * A dynamic planner has no fixed `nodeRole -> instruction` table to look up,
   * so the instruction has to travel with the row. It is also what the UI
   * renders under the Plan tab, and Person 4 must read it from here rather
   * than reconstructing a template in the browser.
   */
  instruction: string;
  expectedOutput: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GroupContextInjection {
  id: string;
  groupTaskId: string;
  planNodeId: string;
  agentId: string;
  fromSeqExclusive: number;
  toSeqInclusive: number;
  injectedMessageIds: string[];
  injectedDependencyNodeIds: string[];
  withheldMessageIds: string[];
  createdAt: string;
}

export interface GroupRuntimeLock {
  id: string;
  groupTaskId: string;
  lockKey: string;
  holderPlanNodeId: string;
  acquiredAt: string;
  releasedAt: string | null;
}

// ---------------------------------------------------------------------------
// Governed memory types (see middlewaredoc/SPEC.md + memory TDs)
// ---------------------------------------------------------------------------

export type MemorySeverity = "normal" | "severe";
export type MemoryStatus =
  | "candidate"
  | "pending"
  | "quarantined"
  | "active"
  | "rejected"
  | "revoked";

export interface MemoryNote {
  id: string;
  groupTaskId: string;
  groupId: string;
  content: string;
  severity: MemorySeverity;
  status: MemoryStatus;
  targetAgentIds: string[];
  description: string;
  sourceRunIds: string[];
  sourceSpanIds: string[];
  rationale: string;
  redactionFired: boolean;
  quarantineHit: boolean;
  safetyReasons: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LandedMemoryFile {
  id: string;
  noteId: string;
  agentId: string;
  kind: "agents_md" | "skill";
  path: string;
  createdAt: string;
  removedAt: string | null;
}

export interface GrantRecord {
  id: string;
  groupTaskId: string;
  noteId: string;
  agentId: string;
  decision: "granted" | "withheld" | "rejected" | "revoked";
  reason: string;
  filePath: string | null;
  reviewerName: string | null;
  createdAt: string;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  spans: TraceSpan[];

  groups: AgentGroup[];
  groupTasks: GroupTask[];
  groupMessages: GroupMessage[];
  groupParticipants: GroupParticipantState[];
  groupPlanNodes: GroupPlanNode[];
  contextInjections: GroupContextInjection[];
  notes: MemoryNote[];
  grants: GrantRecord[];
  runtimeLocks: GroupRuntimeLock[];
  landedMemoryFiles: LandedMemoryFile[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface SendMessageInput {
  content: string;
  freshThread?: boolean | undefined;
}

export interface CreateGroupInput {
  name: string;
  description?: string | undefined;
  members: GroupMember[];
}

export interface UpdateGroupInput {
  name?: string | undefined;
  description?: string | undefined;
  members?: GroupMember[] | undefined;
}

export type ReviewNoteInput =
  | { type: "approve"; reviewerName: string }
  | {
      type: "edit";
      reviewerName: string;
      content?: string | undefined;
      severity?: MemorySeverity | undefined;
      targetAgentIds?: string[] | undefined;
      description?: string | undefined;
      approveAfterEdit?: boolean | undefined;
    }
  | { type: "reject"; reviewerName: string; reason: string };

export interface RevokeNoteInput {
  reviewerName: string;
  reason: string;
}

export interface ListNotesQuery {
  agentId?: string | undefined;
  status?: MemoryStatus | undefined;
}

export interface GroupTaskResponse {
  task: GroupTask;
  nodes: GroupPlanNode[];
  messages: GroupMessage[];
  contextInjections: GroupContextInjection[];
}

export type AgentLeaseHolder =
  | { kind: "solo"; runId: string }
  | { kind: "group"; groupTaskId: string; planNodeId: string };

export interface AgentLease {
  acquireAgent(agentId: string, holder: AgentLeaseHolder): Promise<Agent>;
  releaseAgent(agentId: string, holder: AgentLeaseHolder): Promise<void>;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  sharedCodePath?: string | undefined;
  onSpan?: (span: TraceSpan) => void;
  onThreadId?: (id: string) => void;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
