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
