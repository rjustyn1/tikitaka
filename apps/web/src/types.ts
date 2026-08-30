export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RunTraceSummary {
  spanCount: number;
  failedSpanCount: number;
  reasoningCount: number;
  actionCount: number;
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
  | { kind: "file_write"; changes: Array<{ path: string; changeKind: string }> }
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

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  traceSummary: RunTraceSummary | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

// ---------------------------------------------------------------------------
// Group chat + governed-memory response DTOs (mirror apps/server/src/types.ts)
// ---------------------------------------------------------------------------

export type GroupTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export type GroupPlanNodeKind = "work" | "join";
export type GroupRole = "backend" | "frontend" | "security" | (string & {});
export type MemorySeverity = "normal" | "severe";
export type MemoryStatus =
  | "candidate"
  | "pending"
  | "quarantined"
  | "active"
  | "rejected"
  | "revoked";

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
   * What this Agent was told to do on this node — planner output, persisted per
   * row by the server.
   *
   * Optional on the read side ONLY because task rows seeded before the planner
   * landed carry no such field. Never reconstruct it in the browser: a missing
   * instruction is a fact about the row, not a gap to paper over.
   */
  instruction?: string;
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

export interface GroupTaskResponse {
  task: GroupTask;
  nodes: GroupPlanNode[];
  messages: GroupMessage[];
  contextInjections: GroupContextInjection[];
}

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

export type ReviewNoteInput =
  | { type: "approve"; reviewerName: string }
  | {
      type: "edit";
      reviewerName: string;
      content?: string;
      severity?: MemorySeverity;
      targetAgentIds?: string[];
      description?: string;
      approveAfterEdit?: boolean;
    }
  | { type: "reject"; reviewerName: string; reason: string };

export interface RevokeNoteInput {
  reviewerName: string;
  reason: string;
}

export interface SendMessageInput {
  content: string;
  freshThread?: boolean;
}

export interface CreateGroupInput {
  name: string;
  description?: string;
  members: GroupMember[];
}

export interface UpdateGroupInput {
  name?: string;
  description?: string;
  members?: GroupMember[];
}
