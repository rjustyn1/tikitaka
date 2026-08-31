import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { GroupRunner } from "./memory/group-runner.js";
import { LandingService } from "./memory/landing.js";
import { LedgerService } from "./memory/ledger.js";
import {
  NoopMemoryPipeline,
  type MemoryPipeline,
} from "./memory/pipeline.js";
import { FakePlannerClient, TaskPlanner } from "./memory/planner.js";
import { ReviewService } from "./memory/review.js";
import { JsonStore } from "./store.js";
import { computeTraceSummary } from "./trace-summary.js";
import type {
  Agent,
  AgentGroup,
  AgentLease,
  AgentLeaseHolder,
  CreateGroupInput,
  UpdateGroupInput,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  GrantRecord,
  GroupTask,
  GroupTaskResponse,
  LandedMemoryFile,
  ListNotesQuery,
  Message,
  MemoryNote,
  ReviewNoteInput,
  RevokeNoteInput,
  SendMessageInput,
  TraceSpan,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

function sameHolder(left: AgentLeaseHolder, right: AgentLeaseHolder): boolean {
  if (left.kind === "solo" && right.kind === "solo") {
    return left.runId === right.runId;
  }
  if (left.kind === "group" && right.kind === "group") {
    return (
      left.groupTaskId === right.groupTaskId &&
      left.planNodeId === right.planNodeId
    );
  }
  return false;
}

export class AgentService implements AgentLease {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  /**
   * A3 - who currently holds each Agent. `CodexRunner.active` and the container
   * `--name` are both keyed by agentId, so solo runs and group nodes must
   * contend for one lease or a solo message sent during a group task surfaces
   * as a raw 500.
   */
  private readonly leases = new Map<string, AgentLeaseHolder>();

  private readonly groupRunner: GroupRunner;

  // W3 - the governed-memory services. Routes call these through AgentService;
  // they never write files or mutate the ledger directly.
  private readonly landing: LandingService;
  private readonly ledger: LedgerService;
  private readonly review: ReviewService;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    memoryPipeline: MemoryPipeline = new NoopMemoryPipeline(),
    planner: TaskPlanner = new TaskPlanner(
      new FakePlannerClient(),
      config.memoryExtractTimeoutMs,
    ),
  ) {
    // `this` is the AgentLease (A3). Safe to pass here: GroupRunner only stores
    // the reference and never calls back during construction.
    this.groupRunner = new GroupRunner(
      config,
      store,
      workspaces,
      runner,
      this,
      memoryPipeline,
      planner,
    );
    // W3 - governed-memory services (integrationManifest3 section 3).
    this.ledger = new LedgerService(store);
    this.landing = new LandingService(store);
    this.review = new ReviewService(
      store,
      this.landing,
      this.ledger,
      config.reviewAllSkills,
    );
  }

  /** Exposed so callers can await a group task in tests. */
  get groups(): GroupRunner {
    return this.groupRunner;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    // A3 - a restart cannot leave a lease held by a process that no longer runs.
    this.leases.clear();
    await this.groupRunner.recoverFromRestart();
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
    const holder = this.leases.get(id);
    if (holder?.kind === "group") {
      throw new HttpError(
        409,
        "This Agent is running group task " +
          holder.groupTaskId +
          ". Cancel the group task first.",
      );
    }
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
    input: string | SendMessageInput,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    // A5 - freshThread starts a NEW Codex thread so AGENTS.md and .agents/skills
    // are re-read from disk. This is what makes landed governed memory observable.
    const prompt = typeof input === "string" ? input : input.content;
    const freshThread =
      typeof input === "string" ? false : input.freshThread === true;
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
    const holder: AgentLeaseHolder = { kind: "solo", runId };
    const agentAtStart = await this.acquireAgent(agentId, holder);
    try {
      await this.store.mutate((database) => {
        database.runs.push(run);
        database.messages.push(message);
      });
    } catch (error) {
      await this.releaseAgent(agentId, holder);
      throw error;
    }
    const execution = this.executeRun(agentAtStart, run, freshThread);
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
      memoryEnabled: this.config.memoryEnabled,
    };
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    freshThread: boolean,
  ): Promise<void> {
    try {
      await this.runToTerminal(agentAtStart, run, freshThread);
    } finally {
      await this.releaseAgent(agentAtStart.id, {
        kind: "solo",
        runId: run.id,
      });
    }
  }

  private async runToTerminal(
    agentAtStart: Agent,
    run: AgentRun,
    freshThread: boolean,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });

    // Persist spans as they arrive so an active run has an immediately useful
    // trace. The queue preserves callback order and the upsert handles Codex
    // sending a started span followed by its completed update.
    let spanWriteQueue: Promise<void> = Promise.resolve();
    const spansById = new Map<string, TraceSpan>();
    const enqueueSpan = (span: TraceSpan): void => {
      const snapshot = structuredClone(span);
      spansById.set(snapshot.id, snapshot);
      spanWriteQueue = spanWriteQueue
        .then(() => this.persistSpan(snapshot))
        .catch(() => undefined);
    };
    // A5 - a fresh thread starts from null, so Codex re-reads AGENTS.md and skills.
    const threadIdAtStart = freshThread ? null : agentAtStart.codexThreadId;
    let capturedThreadId: string | null = threadIdAtStart;

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        runId: run.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: threadIdAtStart,
        onThreadId: (id) => {
          capturedThreadId = id;
        },
        onSpan: (span) => {
          enqueueSpan(span);
        },
      });
      capturedThreadId = result.threadId ?? capturedThreadId;
      const completedAt = now();
      await spanWriteQueue;
      await this.store.mutate((database) => {
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
      // Mark any open spans as incomplete before their final upsert.
      for (const span of spansById.values()) {
        if (span.status === "started") {
          enqueueSpan({
            ...span,
            status: "incomplete",
            completedAt,
            durationMs:
              new Date(completedAt).getTime() -
              new Date(span.startedAt).getTime(),
          });
        }
      }
      await spanWriteQueue;
      await this.store.mutate((database) => {
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

  private async persistSpan(span: TraceSpan): Promise<void> {
    await this.store.mutate((database) => {
      const existingIndex = database.spans.findIndex(
        (existing) => existing.id === span.id,
      );
      if (existingIndex === -1) {
        database.spans.push(span);
      } else {
        database.spans[existingIndex] = span;
      }
    });
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
  // A3 - the Agent lease. One lease, shared by solo runs and group nodes.
  //
  // Deliberately NOT re-entrant: the v1 chain is sequential, so an Agent taking
  // two turns acquires and releases twice with no overlap (A4).
  // --------------------------------------------------------------------------

  async acquireAgent(
    agentId: string,
    holder: AgentLeaseHolder,
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "stopped") {
        throw new HttpError(
          409,
          holder.kind === "solo"
            ? "Start the Agent before sending a message"
            : "Start the Agent before it can join a group task",
        );
      }
      if (agent.status === "busy") {
        throw new HttpError(409, this.busyMessage(agentId));
      }
      const snapshot = structuredClone(agent);
      agent.status = "busy";
      agent.lastError = null;
      agent.updatedAt = now();
      this.leases.set(agentId, holder);
      return snapshot;
    });
  }

  async releaseAgent(agentId: string, holder: AgentLeaseHolder): Promise<void> {
    const current = this.leases.get(agentId);
    if (current && !sameHolder(current, holder)) {
      return; // someone else holds it now; do not release another holder's lease
    }
    this.leases.delete(agentId);
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      // Only clear "busy". A run that already settled on ready/error/stopped
      // owns its own terminal status, and the lease must not overwrite it.
      if (agent && agent.status === "busy") {
        agent.status = "ready";
        agent.updatedAt = now();
      }
    });
  }

  /** Who holds this Agent, phrased for a 409 body. */
  private busyMessage(agentId: string): string {
    const holder = this.leases.get(agentId);
    if (holder?.kind === "group") {
      return "This Agent is running group task " + holder.groupTaskId;
    }
    return "This Agent is already running";
  }

  // --------------------------------------------------------------------------
  // Group execution -- delegated to GroupRunner (Person 2).
  //
  // The memory methods below remain Person 1's contract stubs until Person 3
  // lands review/landing/ledger.
  // --------------------------------------------------------------------------

  listGroups(): AgentGroup[] {
    return this.groupRunner.listGroups();
  }

  getGroup(id: string): AgentGroup {
    return this.groupRunner.getGroup(id);
  }

  async createGroup(input: CreateGroupInput): Promise<AgentGroup> {
    return this.groupRunner.createGroup(input);
  }

  async updateGroup(
    id: string,
    input: UpdateGroupInput,
  ): Promise<AgentGroup> {
    return this.groupRunner.updateGroup(id, input);
  }

  async startGroupTask(groupId: string, prompt: string): Promise<GroupTask> {
    return this.groupRunner.startGroupTask(groupId, prompt);
  }

  async cancelGroupTask(taskId: string): Promise<GroupTask> {
    return this.groupRunner.cancelGroupTask(taskId);
  }

  async resumeGroupTask(taskId: string): Promise<GroupTask> {
    return this.groupRunner.resumeGroupTask(taskId);
  }

  /**
   * Close and consolidate a group's open topic segment if it has gone quiet.
   *
   * A segment otherwise only closes when the next prompt arrives, so this is
   * what stops a user's LAST segment from sitting unconsolidated forever. Group
   * read paths call it and do not await it -- reads must not block on memory,
   * and the sweep fails open the same way the rest of the pipeline does.
   */
  sweepIdleSegments(groupId: string): void {
    void this.groupRunner.sweepIdleSegments(groupId);
  }

  listGroupTasks(groupId: string): GroupTask[] {
    return this.groupRunner.listGroupTasks(groupId);
  }

  getGroupTask(taskId: string): GroupTaskResponse {
    return this.groupRunner.getGroupTask(taskId);
  }

  listNotes(query: ListNotesQuery): MemoryNote[] {
    return this.review.listNotes(query);
  }

  async reviewNote(id: string, input: ReviewNoteInput): Promise<MemoryNote> {
    if (!this.config.memoryEnabled) {
      throw new HttpError(409, "Governed memory is disabled by MEMORY_ENABLED=false");
    }
    return this.review.applyReview(id, input);
  }

  async revokeNote(id: string, input: RevokeNoteInput): Promise<MemoryNote> {
    return this.review.revoke(id, input);
  }

  listAgentMemory(agentId: string): LandedMemoryFile[] {
    return this.landing.listAgentMemory(agentId);
  }

  listTaskGrants(taskId: string): GrantRecord[] {
    return this.ledger.listTaskGrants(taskId);
  }
}
