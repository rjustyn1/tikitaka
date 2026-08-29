import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentGroup,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  CreateGroupInput,
  GrantRecord,
  GroupTask,
  GroupTaskResponse,
  LandedMemoryFile,
  ListNotesQuery,
  Message,
  MemoryNote,
  ReviewNoteInput,
  RevokeNoteInput,
  RunTraceSummary,
  TraceSpan,
  UpdateAgentInput,
  UpdateGroupInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

function computeTraceSummary(spans: TraceSpan[], runId: string): RunTraceSummary {
  const runSpans = spans.filter((s) => s.runId === runId);
  return {
    spanCount: runSpans.length,
    failedSpanCount: runSpans.filter((s) => s.status === "failed").length,
    reasoningCount: runSpans.filter((s) => s.type === "reasoning").length,
    actionCount: runSpans.filter(
      (s) => s.type !== "reasoning" && s.type !== "error",
    ).length,
  };
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
          // Mark any open spans for this run as incomplete
          for (const span of database.spans) {
            if (span.runId === run.id && span.status === "started") {
              span.status = "incomplete";
              span.completedAt = run.completedAt;
              span.durationMs =
                new Date(run.completedAt).getTime() -
                new Date(span.startedAt).getTime();
            }
          }
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined)
        agent.description = input.description.trim();
      if (input.instructions !== undefined)
        agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.spans = database.spans.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getSpans(runId: string): { run: AgentRun; spans: TraceSpan[] } {
    const run = this.getRun(runId);
    const spans = this.store
      .snapshot()
      .spans.filter((s) => s.runId === runId)
      .sort((a, b) => a.seq - b.seq);
    return { run, spans };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      traceSummary: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    // Collect spans via callback; single flush at terminal state
    const spanBuffer: TraceSpan[] = [];
    let capturedThreadId: string | null = agentAtStart.codexThreadId;

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        onThreadId: (id) => {
          capturedThreadId = id;
        },
        onSpan: (span) => {
          spanBuffer.push(span);
        },
      });
      capturedThreadId = result.threadId ?? capturedThreadId;
      const completedAt = now();
      await this.store.mutate((database) => {
        if (spanBuffer.length > 0) {
          database.spans.push(...spanBuffer);
        }
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.traceSummary = computeTraceSummary(database.spans, run.id);
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = capturedThreadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message =
        error instanceof Error ? error.message : String(error);
      // Mark any buffered "started" spans as incomplete before flushing
      for (const span of spanBuffer) {
        if (span.status === "started") {
          span.status = "incomplete";
          span.completedAt = completedAt;
          span.durationMs =
            new Date(completedAt).getTime() - new Date(span.startedAt).getTime();
        }
      }
      await this.store.mutate((database) => {
        if (spanBuffer.length > 0) {
          database.spans.push(...spanBuffer);
        }
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.traceSummary = computeTraceSummary(database.spans, run.id);
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          // Fix 3: persist threadId unconditionally, not just on success
          if (capturedThreadId !== null) agent.codexThreadId = capturedThreadId;
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }

  // --------------------------------------------------------------------------
  // Group + governed-memory stubs (Person 1 contract layer).
  //
  // These satisfy the API-ROUTES contract and unblock frontend/pipeline work.
  // Read methods are backed by the store and return live data as soon as it is
  // populated. Mutating methods throw 501 until:
  //   - Person 2's GroupRunner lands createGroup/updateGroup/startGroupTask
  //   - Person 3's memory services land reviewNote/revokeNote
  // Person 2/3: replace the bodies below by delegating to your services.
  // --------------------------------------------------------------------------

  listGroups(): AgentGroup[] {
    return this.store
      .snapshot()
      .groups.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getGroup(id: string): AgentGroup {
    const group = this.store.snapshot().groups.find((item) => item.id === id);
    if (!group) {
      throw new HttpError(404, "Group not found");
    }
    return group;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createGroup(_input: CreateGroupInput): Promise<AgentGroup> {
    throw new HttpError(501, "Group creation is not implemented yet");
  }

  async updateGroup(
    _id: string,
    _input: UpdateGroupInput,
  ): Promise<AgentGroup> {
    throw new HttpError(501, "Group update is not implemented yet");
  }

  async startGroupTask(_groupId: string, _prompt: string): Promise<GroupTask> {
    throw new HttpError(501, "Group task execution is not implemented yet");
  }

  getGroupTask(taskId: string): GroupTaskResponse {
    const database = this.store.snapshot();
    const task = database.groupTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new HttpError(404, "Group task not found");
    }
    return {
      task,
      nodes: database.groupPlanNodes
        .filter((node) => node.groupTaskId === taskId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      messages: database.groupMessages
        .filter((message) => message.groupTaskId === taskId)
        .sort((left, right) => left.seq - right.seq),
      contextInjections: database.contextInjections.filter(
        (injection) => injection.groupTaskId === taskId,
      ),
    };
  }

  listNotes(query: ListNotesQuery): MemoryNote[] {
    let notes = this.store.snapshot().notes;
    if (query.agentId) {
      notes = notes.filter((note) => note.targetAgentIds.includes(query.agentId!));
    }
    if (query.status) {
      notes = notes.filter((note) => note.status === query.status);
    }
    return notes.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async reviewNote(_id: string, _input: ReviewNoteInput): Promise<MemoryNote> {
    throw new HttpError(501, "Note review is not implemented yet");
  }

  async revokeNote(_id: string, _input: RevokeNoteInput): Promise<MemoryNote> {
    throw new HttpError(501, "Note revocation is not implemented yet");
  }

  listAgentMemory(agentId: string): LandedMemoryFile[] {
    return this.store
      .snapshot()
      .landedMemoryFiles.filter(
        (file) => file.agentId === agentId && file.removedAt === null,
      );
  }

  listTaskGrants(taskId: string): GrantRecord[] {
    return this.store
      .snapshot()
      .grants.filter((grant) => grant.groupTaskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
