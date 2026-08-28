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

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  spans: TraceSpan[];
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
  onSpan?: (span: TraceSpan) => void;
  onThreadId?: (id: string) => void;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
