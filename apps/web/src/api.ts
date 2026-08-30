import type {
  Agent,
  AgentGroup,
  AgentRun,
  CreateGroupInput,
  GrantRecord,
  GroupTask,
  GroupTaskResponse,
  LandedMemoryFile,
  Message,
  MemoryNote,
  MemoryStatus,
  ReviewNoteInput,
  RevokeNoteInput,
  RunTraceSummary,
  SendMessageInput,
  SystemInfo,
  TraceSpan,
  UpdateGroupInput,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string, options?: { freshThread?: boolean }) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({
          content,
          ...(options?.freshThread !== undefined && {
            freshThread: options.freshThread,
          }),
        } satisfies SendMessageInput),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  trace: (id: string, params?: { type?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.status) qs.set("status", params.status);
    const query = qs.toString() ? "?" + qs.toString() : "";
    return request<{ run: AgentRun; summary: RunTraceSummary; spans: TraceSpan[] }>(
      "/api/runs/" + id + "/trace" + query,
    );
  },

  // --- Groups + governed memory ---------------------------------------------
  groups: () => request<{ groups: AgentGroup[] }>("/api/groups"),
  group: (id: string) => request<{ group: AgentGroup }>("/api/groups/" + id),
  createGroup: (body: CreateGroupInput) =>
    request<{ group: AgentGroup }>("/api/groups", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateGroup: (id: string, body: UpdateGroupInput) =>
    request<{ group: AgentGroup }>("/api/groups/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  startGroupTask: (id: string, prompt: string) =>
    request<{ task: GroupTask }>("/api/groups/" + id + "/tasks", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  groupTask: (groupId: string, taskId: string) =>
    request<GroupTaskResponse>(
      "/api/groups/" + groupId + "/tasks/" + taskId,
    ),
  // All tasks for a group, newest first — powers the task history list so a
  // failed task can be found and resumed.
  listGroupTasks: (groupId: string) =>
    request<{ tasks: GroupTask[] }>("/api/groups/" + groupId + "/tasks"),
  // The route exists (SPEC Part 2) but had no client method. Needed for QA and
  // the demo: the v1 chain is five nodes at up to CODEX_TIMEOUT_MS each.
  cancelGroupTask: (groupId: string, taskId: string) =>
    request<{ task: GroupTask }>(
      "/api/groups/" + groupId + "/tasks/" + taskId + "/cancel",
      { method: "POST" },
    ),
  // Continue a task that ended before completing (e.g. an Agent run ran out of
  // tokens). Reuses completed node outputs and each Agent's group thread; handy
  // after switching ARK_MODEL.
  resumeGroupTask: (groupId: string, taskId: string) =>
    request<{ task: GroupTask }>(
      "/api/groups/" + groupId + "/tasks/" + taskId + "/resume",
      { method: "POST" },
    ),
  notes: (params?: { agentId?: string; status?: MemoryStatus }) => {
    const qs = new URLSearchParams();
    if (params?.agentId) qs.set("agentId", params.agentId);
    if (params?.status) qs.set("status", params.status);
    const query = qs.toString() ? "?" + qs.toString() : "";
    return request<{ notes: MemoryNote[] }>("/api/notes" + query);
  },
  reviewNote: (id: string, body: ReviewNoteInput) =>
    request<{ note: MemoryNote }>("/api/notes/" + id + "/review", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  revokeNote: (id: string, body: RevokeNoteInput) =>
    request<{ note: MemoryNote }>("/api/notes/" + id + "/revoke", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  agentMemory: (id: string) =>
    request<{ files: LandedMemoryFile[] }>("/api/agents/" + id + "/memory"),
  taskGrants: (id: string) =>
    request<{ grants: GrantRecord[] }>("/api/tasks/" + id + "/grants"),
};
