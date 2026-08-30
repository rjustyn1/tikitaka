/**
 * Group runner -- `middlewaredoc/components/GROUP-RUNNER.md`.
 *
 * Owns group lifecycle, shared-code setup, and sequential execution of the
 * planner's validated topological order. It does NOT extract, route or land
 * memory: after the flush trigger fires it hands ids to Person 3's pipeline.
 *
 * The persisted plan may be a DAG, but v1 executes its topological order one
 * node at a time. Parallel-set and runtime-lock collision validation remain
 * deferred.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { HttpError, RunCancelledError } from "../errors.js";
import type { JsonStore } from "../store.js";
import { computeTraceSummary } from "../trace-summary.js";
import type {
  Agent,
  AgentGroup,
  AgentLease,
  AgentLeaseHolder,
  AgentRun,
  AgentRunner,
  CreateGroupInput,
  Database,
  GroupContextInjection,
  GroupMessage,
  GroupParticipantState,
  GroupPlanNode,
  GroupTask,
  GroupTaskResponse,
  GroupMember,
  GroupTaskStatus,
  RunnerRequest,
  TraceSpan,
  UpdateGroupInput,
} from "../types.js";
import type { WorkspaceManager } from "../workspace.js";
import { decideFlush } from "./flush-trigger.js";
import { findMembershipError, readMembers } from "./group-chain.js";
import {
  buildContextPacket,
  buildGroupTaskCharter,
  buildTurnPrompt,
} from "./group-prompt.js";
import type { MemoryPipeline } from "./pipeline.js";
import { buildPlanNodes, type TaskPlanner } from "./planner.js";

const now = () => new Date().toISOString();

interface ActiveGroupTask {
  cancelled: boolean;
  /** Agents currently holding a lease for this task, so cancel can free them. */
  heldAgentIds: Set<string>;
}

export class GroupRunner {
  private readonly activeTasks = new Map<string, ActiveGroupTask>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly lease: AgentLease,
    private readonly memoryPipeline: MemoryPipeline,
    private readonly planner: TaskPlanner,
  ) {}

  // -------------------------------------------------------------------------
  // Restart recovery
  // -------------------------------------------------------------------------

  /**
   * `initialize()` already resets stale runs and busy Agents, but nothing reset
   * group state, so a restart mid-task left a group permanently unable to start
   * another task (`SPEC.md` -> Group task restart recovery).
   */
  async recoverFromRestart(): Promise<void> {
    this.activeTasks.clear();
    const taskIds = this.store.snapshot().groupTasks.map((task) => task.id);
    await this.store.mutate((database) => {
      const timestamp = now();
      for (const task of database.groupTasks) {
        if (task.status === "running" || task.status === "queued") {
          task.status = "cancelled";
          task.completedAt = timestamp;
        }
      }
      for (const node of database.groupPlanNodes) {
        if (node.status === "running" || node.status === "queued") {
          node.status = "cancelled";
          node.error = "Server restarted while this group task was active";
          node.completedAt = timestamp;
        }
      }
      for (const lock of database.runtimeLocks) {
        if (lock.releasedAt === null) lock.releasedAt = timestamp;
      }
      for (const group of database.groups) {
        group.activeTaskId = null;
      }
    });
    // A process restart can strand links even when the database recovery above
    // correctly marks the task terminal. Releasing every known group-task link
    // is safe because resumeGroupTask recreates the link before it runs.
    await Promise.all(
      taskIds.map((taskId) => this.releaseSharedCodeForTask(taskId)),
    );
  }

  // -------------------------------------------------------------------------
  // Group lifecycle
  // -------------------------------------------------------------------------

  listGroups(): AgentGroup[] {
    return this.store
      .snapshot()
      .groups.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  getGroup(id: string): AgentGroup {
    const group = this.store.snapshot().groups.find((item) => item.id === id);
    if (!group) {
      throw new HttpError(404, "Group not found");
    }
    return group;
  }

  /** All tasks for a group, newest first — powers the task history UI. */
  listGroupTasks(groupId: string): GroupTask[] {
    return this.store
      .snapshot()
      .groupTasks.filter((task) => task.groupId === groupId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createGroup(input: CreateGroupInput): Promise<AgentGroup> {
    const membershipError = findMembershipError(input.members);
    if (membershipError) {
      throw new HttpError(400, membershipError);
    }
    const timestamp = now();
    const group: AgentGroup = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      members: input.members,
      activeTaskId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.store.mutate((database) => {
      this.assertAgentsExist(database, input.members);
      database.groups.push(group);
      this.syncParticipants(database, group, timestamp);
      return structuredClone(group) as AgentGroup;
    });
  }

  async updateGroup(
    id: string,
    input: UpdateGroupInput,
  ): Promise<AgentGroup> {
    if (input.members) {
      const membershipError = findMembershipError(input.members);
      if (membershipError) {
        throw new HttpError(400, membershipError);
      }
    }
    return this.store.mutate((database) => {
      const group = database.groups.find((item) => item.id === id);
      if (!group) {
        throw new HttpError(404, "Group not found");
      }
      if (group.activeTaskId) {
        throw new HttpError(
          409,
          "Membership cannot change while a group task is running",
        );
      }
      const timestamp = now();
      if (input.name !== undefined) group.name = input.name.trim();
      if (input.description !== undefined) {
        group.description = input.description.trim();
      }
      if (input.members) {
        this.assertAgentsExist(database, input.members);
        group.members = input.members;
        this.syncParticipants(database, group as AgentGroup, timestamp);
      }
      group.updatedAt = timestamp;
      return structuredClone(group);
    });
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

  // -------------------------------------------------------------------------
  // Starting a task
  // -------------------------------------------------------------------------

  async startGroupTask(groupId: string, prompt: string): Promise<GroupTask> {
    const group = this.getGroup(groupId);
    if (group.activeTaskId) {
      throw new HttpError(409, "This group already has a running task");
    }
    const members = readMembers(group);
    const membershipError = findMembershipError(members);
    if (membershipError) {
      throw new HttpError(409, membershipError);
    }

    const snapshot = this.store.snapshot();
    const agents = members.map((member) => {
      const agent = snapshot.agents.find((item) => item.id === member.agentId);
      if (!agent) {
        throw new HttpError(404, "A member of this group no longer exists");
      }
      return agent;
    });

    // Filesystem first: a failure here must not leave a dangling task row or
    // links on members that were prepared before a later member failed.
    const taskId = randomUUID();
    const sharedCodePath = this.workspaces.sharedCodePath(taskId);
    try {
      await this.workspaces.createSharedCodeDirectory(taskId);
    } catch (error) {
      await this.workspaces
        .removeSharedCodeDirectory(taskId)
        .catch(() => undefined);
      throw error;
    }
    const preparedAgents: Agent[] = [];
    try {
      for (const agent of agents) {
        await this.workspaces.prepareSharedCode(agent, sharedCodePath);
        preparedAgents.push(agent);
      }

      const timestamp = now();
      const task: GroupTask = {
        id: taskId,
        groupId,
        prompt,
        sharedCodePath,
        status: "queued",
        currentNodeId: null,
        nodeRunIds: [],
        flushedAt: null,
        createdAt: timestamp,
        startedAt: null,
        completedAt: null,
      };
      const plan = await this.planner.plan({
        prompt,
        agents: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
        })),
      });
      const nodes = buildPlanNodes(taskId, plan.nodes, timestamp);

      // The planner-written charter goes into each member's PRIVATE AGENTS.md,
      // never into shared code.
      const charter = buildGroupTaskCharter({
        groupName: group.name,
        taskPrompt: prompt,
        roster: agents.map((agent) => ({
          name: agent.name,
          role:
            members.find((member) => member.agentId === agent.id)?.role ??
            "member",
        })),
      });
      for (const agent of agents) {
        await this.workspaces.writeGroupTaskSection(agent, task, charter);
      }

      await this.store.mutate((database) => {
        const storedGroup = database.groups.find((item) => item.id === groupId);
        if (!storedGroup) {
          throw new HttpError(404, "Group not found");
        }
        if (storedGroup.activeTaskId) {
          throw new HttpError(409, "This group already has a running task");
        }
        database.groupTasks.push(task);
        database.groupPlanNodes.push(...nodes);
        this.syncParticipants(
          database,
          storedGroup as AgentGroup,
          timestamp,
        );
        database.groupMessages.push({
          id: randomUUID(),
          groupId,
          seq: this.nextSeq(database, groupId),
          speakerType: "human",
          speakerAgentId: null,
          groupTaskId: taskId,
          planNodeId: null,
          content: prompt,
          createdAt: timestamp,
        });
        storedGroup.activeTaskId = taskId;
        storedGroup.updatedAt = timestamp;
      });

      this.activeTasks.set(taskId, { cancelled: false, heldAgentIds: new Set() });
      void this.executeGroupTask(taskId).catch(() => undefined);
      return task;
    } catch (error) {
      await Promise.all(
        agents.map((agent) =>
          this.workspaces.clearGroupTaskSection(agent, taskId).catch(() => undefined),
        ),
      );
      await Promise.all(
        preparedAgents.map((agent) =>
          this.workspaces.releaseSharedCode(agent).catch(() => undefined),
        ),
      );
      await this.workspaces
        .removeSharedCodeDirectory(taskId)
        .catch(() => undefined);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /** Exposed so tests can await a task instead of polling. */
  async executeGroupTask(taskId: string): Promise<void> {
    await this.store.mutate((database) => {
      const task = database.groupTasks.find((item) => item.id === taskId);
      if (task) {
        task.status = "running";
        task.startedAt = now();
      }
    });

    const chain = this.chainFor(taskId);
    // V1: a plain sequential loop. The STRETCH parallel form would be
    // `Promise.all` over runnable sets after parallel-set validation (A4).
    for (const node of chain) {
      if (this.activeTasks.get(taskId)?.cancelled) break;
      // Resume: a node that already completed in an earlier run is not re-run;
      // its output is reused. On a first run every node is queued, so this is a
      // no-op there.
      if (node.status === "completed") continue;
      const status = await this.runPlanNode(taskId, node.id);
      if (status !== "completed") break;
    }

    await this.finishGroupTask(taskId);
  }

  private async runPlanNode(
    taskId: string,
    nodeId: string,
  ): Promise<GroupTaskStatus> {
    const database = this.store.snapshot();
    const task = database.groupTasks.find((item) => item.id === taskId);
    const node = database.groupPlanNodes.find((item) => item.id === nodeId);
    if (!task || !node) return "failed";

    const agent = database.agents.find((item) => item.id === node.agentId);
    const participant = database.groupParticipants.find(
      (item) =>
        item.groupId === task.groupId &&
        item.agentId === node.agentId &&
        item.removedAt === null,
    );
    if (!agent || !participant) {
      await this.failNode(nodeId, "This Agent is no longer a group member");
      return "failed";
    }

    const holder: AgentLeaseHolder = {
      kind: "group",
      groupTaskId: taskId,
      planNodeId: nodeId,
    };

    let agentAtStart: Agent;
    try {
      agentAtStart = await this.lease.acquireAgent(node.agentId, holder);
    } catch (error) {
      await this.failNode(nodeId, this.messageOf(error));
      return "failed";
    }
    this.activeTasks.get(taskId)?.heldAgentIds.add(node.agentId);

    const runId = randomUUID();
    const startedAt = now();
    let spanWriteQueue: Promise<void> = Promise.resolve();
    const spansById = new Map<string, TraceSpan>();
    const enqueueSpan = (span: TraceSpan): void => {
      const snapshot = structuredClone(span);
      spansById.set(snapshot.id, snapshot);
      spanWriteQueue = spanWriteQueue
        .then(() => this.persistSpan(snapshot))
        .catch(() => undefined);
    };
    let capturedThreadId: string | null = participant.groupThreadId;

    try {
      const groupMessages = database.groupMessages.filter(
        (message) => message.groupId === task.groupId,
      );
      const contextSnapshotSeq = groupMessages.reduce(
        (highest, message) => Math.max(highest, message.seq),
        0,
      );
      const packet = buildContextPacket({
        node,
        messages: groupMessages,
        lastSeenSeq: participant.lastSeenSeq,
        contextSnapshotSeq,
      });
      const injectedMessages = groupMessages
        .filter((message) => packet.injectedMessageIds.includes(message.id))
        .sort((left, right) => left.seq - right.seq);
      const dependencyOutputs = database.groupPlanNodes
        .filter(
          (candidate) =>
            node.allowedPlanNodeIds.includes(candidate.id) &&
            candidate.status === "completed" &&
            candidate.output !== null,
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((candidate) => ({
          nodeRole: candidate.nodeRole,
          output: candidate.output ?? "",
        }));

      const prompt = buildTurnPrompt({
        taskPrompt: task.prompt,
        node,
        agentName: agentAtStart.name,
        agentDescription: agentAtStart.description,
        role: participant.role,
        injectedMessages,
        dependencyOutputs,
        agentNames: new Map(
          database.agents.map((item) => [item.id, item.name]),
        ),
      });

      const run: AgentRun = {
        id: runId,
        agentId: node.agentId,
        status: "running",
        prompt,
        output: null,
        error: null,
        usage: null,
        traceSummary: null,
        startedAt,
        completedAt: null,
        createdAt: startedAt,
      };

      // Everything the UI needs to explain this turn is persisted BEFORE Codex
      // runs, so a crash mid-run still leaves an auditable record of what the
      // Agent was about to be shown.
      await this.store.mutate((db) => {
        const storedNode = db.groupPlanNodes.find((item) => item.id === nodeId);
        const storedTask = db.groupTasks.find((item) => item.id === taskId);
        if (storedNode) {
          storedNode.status = "running";
          storedNode.startedAt = startedAt;
          storedNode.runId = runId;
          storedNode.contextSnapshotSeq = contextSnapshotSeq;
        }
        if (storedTask) {
          storedTask.currentNodeId = nodeId;
          storedTask.nodeRunIds.push(runId);
        }
        db.runs.push(run);
        const injection: GroupContextInjection = {
          id: randomUUID(),
          groupTaskId: taskId,
          planNodeId: nodeId,
          agentId: node.agentId,
          fromSeqExclusive: packet.fromSeqExclusive,
          toSeqInclusive: packet.toSeqInclusive,
          injectedMessageIds: packet.injectedMessageIds,
          injectedDependencyNodeIds: packet.injectedDependencyNodeIds,
          withheldMessageIds: packet.withheldMessageIds,
          createdAt: startedAt,
        };
        db.contextInjections.push(injection);
        // Lock ROWS only. Collision validation is STRETCH: it cannot fire while
        // one node runs at a time (A4).
        for (const lockKey of node.runtimeLocks) {
          db.runtimeLocks.push({
            id: randomUUID(),
            groupTaskId: taskId,
            lockKey,
            holderPlanNodeId: nodeId,
            acquiredAt: startedAt,
            releasedAt: null,
          });
        }
      });

      const request: RunnerRequest = {
        agentId: node.agentId,
        runId,
        workspacePath: participant.agentWorkspacePath,
        prompt,
        // Group work uses the group thread. The solo thread is never touched.
        threadId: participant.groupThreadId,
        // A2 - container: extra bind mount; local-process: --add-dir.
        sharedCodePath: task.sharedCodePath,
        onThreadId: (id) => {
          capturedThreadId = id;
        },
        onSpan: (span) => {
          enqueueSpan(span);
        },
      };
      const result = await this.runner.run(request);
      capturedThreadId = result.threadId ?? capturedThreadId;

      const completedAt = now();
      await spanWriteQueue;
      await this.store.mutate((db) => {
        const storedRun = db.runs.find((item) => item.id === runId);
        if (storedRun) {
          storedRun.status = "completed";
          storedRun.output = result.output;
          storedRun.usage = result.usage;
          storedRun.completedAt = completedAt;
          storedRun.traceSummary = computeTraceSummary(db.spans, runId);
        }
        const storedNode = db.groupPlanNodes.find((item) => item.id === nodeId);
        if (storedNode) {
          storedNode.status = "completed";
          storedNode.output = result.output;
          storedNode.completedAt = completedAt;
        }
        const seq = this.nextSeq(db, task.groupId);
        db.groupMessages.push({
          id: randomUUID(),
          groupId: task.groupId,
          seq,
          speakerType: "agent",
          speakerAgentId: node.agentId,
          groupTaskId: taskId,
          planNodeId: nodeId,
          content: result.output,
          createdAt: completedAt,
        });
        const storedParticipant = db.groupParticipants.find(
          (item) =>
            item.groupId === task.groupId && item.agentId === node.agentId,
        );
        if (storedParticipant) {
          storedParticipant.groupThreadId = capturedThreadId;
          // Safe in a sequential chain: the only message added since the packet
          // was built is this Agent's own. A DAG would have to respect
          // allowedPlanNodeIds here instead.
          storedParticipant.lastSeenSeq = seq;
          storedParticipant.updatedAt = completedAt;
        }
        this.releaseLocks(db, nodeId, completedAt);
      });
      return "completed";
    } catch (error) {
      const cancelled = error instanceof RunCancelledError;
      const completedAt = now();
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
      const message = this.messageOf(error);
      await spanWriteQueue;
      await this.store.mutate((db) => {
        const storedRun = db.runs.find((item) => item.id === runId);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.traceSummary = computeTraceSummary(db.spans, runId);
        }
        const storedNode = db.groupPlanNodes.find((item) => item.id === nodeId);
        if (storedNode) {
          storedNode.status = cancelled ? "cancelled" : "failed";
          storedNode.error = message;
          storedNode.completedAt = completedAt;
        }
        const storedParticipant = db.groupParticipants.find(
          (item) =>
            item.groupId === task.groupId && item.agentId === node.agentId,
        );
        // Persist the thread id even on failure, so a retry resumes rather than
        // silently starting a second thread for the same participant.
        if (storedParticipant && capturedThreadId !== null) {
          storedParticipant.groupThreadId = capturedThreadId;
          storedParticipant.updatedAt = completedAt;
        }
        this.releaseLocks(db, nodeId, completedAt);
      });
      return cancelled ? "cancelled" : "failed";
    } finally {
      this.activeTasks.get(taskId)?.heldAgentIds.delete(node.agentId);
      await this.lease.releaseAgent(node.agentId, holder);
    }
  }

  private async finishGroupTask(taskId: string): Promise<void> {
    const cancelled = this.activeTasks.get(taskId)?.cancelled ?? false;
    const completedAt = now();

    // Keep the group active until its member links have been released. That
    // prevents a new task from racing into the old ./code links between the
    // terminal database write and this cleanup.
    await this.releaseSharedCodeForTask(taskId);

    const status = await this.store.mutate((database) => {
      const nodes = database.groupPlanNodes.filter(
        (node) => node.groupTaskId === taskId,
      );
      // Nodes the chain never reached really were cancelled; recording that
      // keeps the flush trigger and the UI honest.
      for (const node of nodes) {
        if (node.status === "queued" || node.status === "running") {
          node.status = "cancelled";
          node.error =
            node.error ??
            (cancelled
              ? "Group task cancelled"
              : "An earlier node in the chain did not complete");
          node.completedAt = completedAt;
        }
      }
      this.releaseLocksForTask(database, taskId, completedAt);

      const completed = nodes.filter((node) => node.status === "completed");
      const nextStatus: GroupTaskStatus = cancelled
        ? "cancelled"
        : completed.length === nodes.length && nodes.length > 0
          ? "completed"
          : completed.length > 0
            ? "partial"
            : "failed";

      const task = database.groupTasks.find((item) => item.id === taskId);
      if (task) {
        task.status = nextStatus;
        task.currentNodeId = null;
        task.completedAt = completedAt;
      }
      const group = database.groups.find(
        (item) => item.activeTaskId === taskId,
      );
      if (group) {
        group.activeTaskId = null;
        group.updatedAt = completedAt;
      }
      return nextStatus;
    });

    this.activeTasks.delete(taskId);
    // An explicitly cancelled task does not consolidate: the operator said
    // stop. A task that FAILED still does, because partial work is still worth
    // learning from (FLUSH-TRIGGER.md -> partial).
    if (status !== "cancelled") {
      await this.maybeFlush(taskId);
    }
  }

  /**
   * Bridge 4. Memory failures must never fail a completed group task, so every
   * error from here is swallowed after logging.
   */
  private async maybeFlush(taskId: string): Promise<void> {
    try {
      const database = this.store.snapshot();
      const groupTask = database.groupTasks.find((item) => item.id === taskId);
      if (!groupTask) return;
      const decision = decideFlush({
        groupTask,
        planNodes: database.groupPlanNodes,
      });
      if (!decision.shouldFlush) return;

      await this.memoryPipeline.runMemoryPipeline(
        taskId,
        decision.sinkNodeIds,
      );
      await this.store.mutate((db) => {
        const task = db.groupTasks.find((item) => item.id === taskId);
        if (task) task.flushedAt = now();
      });
    } catch (error) {
      if (this.config.nodeEnv !== "test") {
        console.error(
          "[memory] pipeline failed for group task " +
            taskId +
            ": " +
            this.messageOf(error),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  async cancelGroupTask(taskId: string): Promise<GroupTask> {
    const database = this.store.snapshot();
    const task = database.groupTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new HttpError(404, "Group task not found");
    }
    const active = this.activeTasks.get(taskId);
    if (!active) {
      if (task.status === "queued" || task.status === "running") {
        await this.finishGroupTask(taskId);
      }
      return this.getGroupTask(taskId).task;
    }
    active.cancelled = true;
    // Kill the in-flight node run. Its own catch marks the node cancelled and
    // releases the lease; the chain loop then stops.
    for (const agentId of [...active.heldAgentIds]) {
      await this.runner.cancel(agentId);
    }
    return this.getGroupTask(taskId).task;
  }

  // -------------------------------------------------------------------------
  // Resume
  // -------------------------------------------------------------------------

  /**
   * Continue a task that ended before completing (e.g. an Agent run ran out of
   * tokens). Completed nodes and their outputs are kept; only the unfinished
   * nodes are reset and re-run, reusing each Agent's existing groupThreadId and
   * the same shared code directory. Useful after switching ARK_MODEL: restart,
   * then resume onto the new model with prior context intact.
   */
  async resumeGroupTask(taskId: string): Promise<GroupTask> {
    const database = this.store.snapshot();
    const task = database.groupTasks.find((item) => item.id === taskId);
    if (!task) {
      throw new HttpError(404, "Group task not found");
    }
    const resumable: GroupTaskStatus[] = ["partial", "failed", "cancelled"];
    if (!resumable.includes(task.status)) {
      throw new HttpError(409, `A ${task.status} task cannot be resumed`);
    }
    const group = database.groups.find((item) => item.id === task.groupId);
    if (!group) {
      throw new HttpError(404, "Group not found");
    }
    if (group.activeTaskId && group.activeTaskId !== taskId) {
      throw new HttpError(409, "This group already has a running task");
    }
    const unfinished = database.groupPlanNodes.filter(
      (node) => node.groupTaskId === taskId && node.status !== "completed",
    );
    if (unfinished.length === 0) {
      throw new HttpError(409, "This task has no unfinished nodes to resume");
    }

    // Drop the earlier partial flush's auto notes so the final flush over the
    // full transcript is authoritative. Human-decided notes are kept.
    await this.memoryPipeline.resetAutoNotes(taskId);

    const timestamp = now();
    await this.store.mutate((db) => {
      for (const node of db.groupPlanNodes) {
        if (node.groupTaskId === taskId && node.status !== "completed") {
          node.status = "queued";
          node.runId = null;
          node.output = null;
          node.error = null;
          node.startedAt = null;
          node.completedAt = null;
        }
      }
      const storedTask = db.groupTasks.find((item) => item.id === taskId);
      if (storedTask) {
        storedTask.status = "queued";
        storedTask.currentNodeId = null;
        storedTask.completedAt = null;
        // Allow the resumed run to consolidate again when it reaches the end.
        storedTask.flushedAt = null;
      }
      const storedGroup = db.groups.find((item) => item.id === task.groupId);
      if (storedGroup) {
        storedGroup.activeTaskId = taskId;
        storedGroup.updatedAt = timestamp;
      }
    });

    this.activeTasks.set(taskId, { cancelled: false, heldAgentIds: new Set() });
    void this.executeGroupTask(taskId).catch(() => undefined);
    return this.getGroupTask(taskId).task;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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

  private async releaseSharedCodeForTask(taskId: string): Promise<void> {
    const database = this.store.snapshot();
    const task = database.groupTasks.find((item) => item.id === taskId);
    if (!task) return;

    const agentIds = new Set(
      database.groupPlanNodes
        .filter((node) => node.groupTaskId === taskId)
        .map((node) => node.agentId),
    );
    if (agentIds.size === 0) {
      const group = database.groups.find((item) => item.id === task.groupId);
      for (const member of group ? readMembers(group) : []) {
        agentIds.add(member.agentId);
      }
    }

    await Promise.all(
      [...agentIds].map(async (agentId) => {
        const agent = database.agents.find((item) => item.id === agentId);
        if (!agent) return;
        try {
          await this.workspaces.releaseSharedCode(agent);
        } catch (error) {
          // One broken workspace must not keep the task terminal state or its
          // memory flush from being recorded for the other Agents.
          if (this.config.nodeEnv !== "test") {
            console.error(
              "[workspace] failed to release ./code for Agent " +
                agent.id +
                ": " +
                this.messageOf(error),
            );
          }
        }
      }),
    );
  }

  private chainFor(taskId: string): GroupPlanNode[] {
    return this.store
      .snapshot()
      .groupPlanNodes.filter((node) => node.groupTaskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private nextSeq(database: Database, groupId: string): number {
    return (
      database.groupMessages
        .filter((message) => message.groupId === groupId)
        .reduce((highest, message) => Math.max(highest, message.seq), 0) + 1
    );
  }

  private releaseLocks(
    database: Database,
    planNodeId: string,
    at: string,
  ): void {
    for (const lock of database.runtimeLocks) {
      if (lock.holderPlanNodeId === planNodeId && lock.releasedAt === null) {
        lock.releasedAt = at;
      }
    }
  }

  private releaseLocksForTask(
    database: Database,
    taskId: string,
    at: string,
  ): void {
    for (const lock of database.runtimeLocks) {
      if (lock.groupTaskId === taskId && lock.releasedAt === null) {
        lock.releasedAt = at;
      }
    }
  }

  private async failNode(nodeId: string, message: string): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const node = database.groupPlanNodes.find((item) => item.id === nodeId);
      if (node) {
        node.status = "failed";
        node.error = message;
        node.completedAt = completedAt;
      }
      this.releaseLocks(database, nodeId, completedAt);
    });
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private assertAgentsExist(
    database: Database,
    members: readonly GroupMember[],
  ): void {
    for (const member of members) {
      if (!database.agents.some((agent) => agent.id === member.agentId)) {
        throw new HttpError(404, "Agent not found");
      }
    }
  }

  /**
   * Membership is a governance boundary, so participant rows track it exactly.
   *
   * Re-adding a removed Agent starts a NEW membership epoch with a FRESH
   * `groupThreadId`, so nothing from its previous stint in the group carries
   * over into the new one.
   */
  private syncParticipants(
    database: Database,
    group: AgentGroup,
    timestamp: string,
  ): void {
    const members = readMembers(group);
    for (const member of members) {
      const agent = database.agents.find(
        (item) => item.id === member.agentId,
      );
      if (!agent) continue;
      const existing = database.groupParticipants.find(
        (item) =>
          item.groupId === group.id && item.agentId === member.agentId,
      );
      if (!existing) {
        const participant: GroupParticipantState = {
          groupId: group.id,
          agentId: member.agentId,
          membershipEpoch: 1,
          role: member.role,
          agentWorkspacePath: agent.workspacePath,
          groupThreadId: null,
          lastSeenSeq: 0,
          removedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        database.groupParticipants.push(participant);
        continue;
      }
      if (existing.removedAt !== null) {
        existing.membershipEpoch += 1;
        existing.groupThreadId = null; // fresh thread on re-add
        existing.removedAt = null;
        existing.lastSeenSeq = 0;
      }
      existing.role = member.role;
      existing.agentWorkspacePath = agent.workspacePath;
      existing.updatedAt = timestamp;
    }

    const memberIds = new Set(members.map((member) => member.agentId));
    for (const participant of database.groupParticipants) {
      if (
        participant.groupId === group.id &&
        !memberIds.has(participant.agentId) &&
        participant.removedAt === null
      ) {
        // Removal stops future turns but never deletes timeline messages the
        // Agent already produced.
        participant.removedAt = timestamp;
        participant.updatedAt = timestamp;
      }
    }
  }
}
