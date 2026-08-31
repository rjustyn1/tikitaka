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
import { decideFlush, findFailedAncestor } from "./flush-trigger.js";
import {
  closeSegmentInPlace,
  createSegment,
  decideSegmentBoundary,
  findIdleSegment,
  findOpenSegment,
  humanPromptsIn,
  transcriptCharsIn,
} from "./topic-segment.js";
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
        // Additive: the group's standing description is context for the task,
        // never a replacement for it.
        groupDescription: group.description,
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

      // Set inside the transaction, consumed after it commits. A segment that
      // closes here is consolidated outside the mutate so a slow extraction
      // never holds the store lock.
      let closedSegmentId: string | null = null;

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
        const seq = this.nextSeq(database, groupId);
        database.groupMessages.push({
          id: randomUUID(),
          groupId,
          seq,
          speakerType: "human",
          speakerAgentId: null,
          groupTaskId: taskId,
          planNodeId: null,
          content: prompt,
          createdAt: timestamp,
        });

        closedSegmentId = this.assignTaskToSegment(
          database,
          groupId,
          taskId,
          prompt,
          seq,
          timestamp,
        );

        storedGroup.activeTaskId = taskId;
        storedGroup.updatedAt = timestamp;
      });

      if (closedSegmentId) void this.consolidateSegment(closedSegmentId);

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

    /*
     * A ready-set scheduler over the planner's DAG.
     *
     * Independent branches run CONCURRENTLY, but three constraints decide what
     * may overlap, and every one of them is a real hazard rather than caution:
     *
     *  1. AGENT. The A3 lease is not re-entrant, and the planner may give one
     *     Agent several nodes, so two nodes for the same Agent never overlap.
     *  2. LOCKS. Every branch writes one shared `./code` tree, so two nodes
     *     whose runtime locks overlap never run together (`locksConflict`).
     *     Read-only nodes declare no locks and so never block anything.
     *  3. WIDTH. `GROUP_MAX_PARALLEL_NODES` caps how many run at once; 1
     *     restores strictly sequential execution.
     *
     * Containment still applies: a failure blocks only what transitively
     * depends on it, and independent branches keep running.
     */
    const chain = this.chainFor(taskId);
    const byId = new Map(chain.map((node) => [node.id, node]));
    const maxParallel = Math.max(1, this.config.groupMaxParallelNodes);

    const settled = new Set<string>();
    const inFlight = new Map<string, Promise<string>>();
    const busyAgents = new Set<string>();
    const heldLocks = new Map<string, readonly string[]>();

    const isReady = (node: GroupPlanNode): boolean =>
      node.dependsOn.every((id) => byId.get(id)?.status === "completed");

    while (!this.activeTasks.get(taskId)?.cancelled) {
      for (const node of chain) {
        if (settled.has(node.id) || inFlight.has(node.id)) continue;
        // Resume: a node that already completed in an earlier run is not
        // re-run; its output is reused.
        if (node.status === "completed") {
          settled.add(node.id);
          continue;
        }
        const blocker = findFailedAncestor(node, byId);
        if (blocker) {
          await this.blockNode(node.id, blocker);
          // Keep the local view in step so this node, now settled, correctly
          // blocks ITS descendants.
          node.status = "cancelled";
          settled.add(node.id);
          continue;
        }
        if (!isReady(node)) continue;
        if (inFlight.size >= maxParallel) break;
        if (busyAgents.has(node.agentId)) continue;
        if (
          [...heldLocks.values()].some((held) =>
            locksConflict(node.runtimeLocks, held),
          )
        ) {
          continue;
        }

        busyAgents.add(node.agentId);
        heldLocks.set(node.id, node.runtimeLocks);
        inFlight.set(
          node.id,
          this.runNodeWithRetries(taskId, node.id)
            .catch(() => "failed" as GroupTaskStatus)
            .then((status) => {
              // `chain` is a deep clone of the snapshot, so this mutates
              // nothing persisted -- it only lets the next pass see the result.
              node.status = status;
              return node.id;
            }),
        );
      }

      // Nothing running and nothing dispatchable: the task is done, or what
      // remains can never become ready (a cycle `orderForExecution` tolerated).
      if (inFlight.size === 0) break;

      const finishedId = await Promise.race([...inFlight.values()]);
      const finished = byId.get(finishedId);
      inFlight.delete(finishedId);
      heldLocks.delete(finishedId);
      settled.add(finishedId);
      if (finished) busyAgents.delete(finished.agentId);
    }

    // A cancel breaks the loop with work still running; those runs are being
    // killed by cancelGroupTask, but the task is not finished until they land.
    await Promise.allSettled([...inFlight.values()]);

    await this.finishGroupTask(taskId);
  }

  /**
   * Run a node, retrying a transient failure.
   *
   * Each attempt goes through `runPlanNode` unchanged, so it gets its own run
   * row, its own spans and its own context injection -- two attempts are two
   * real runs and the audit says so, rather than the second quietly
   * overwriting the first. `attempts` is persisted before each dispatch, so a
   * restart resumes the count instead of restarting it.
   */
  private async runNodeWithRetries(
    taskId: string,
    nodeId: string,
  ): Promise<GroupTaskStatus> {
    for (;;) {
      const attempt = await this.store.mutate((database) => {
        const node = database.groupPlanNodes.find((item) => item.id === nodeId);
        if (!node) return 0;
        node.attempts += 1;
        return node.attempts;
      });

      const status = await this.runPlanNode(taskId, nodeId);
      if (status !== "failed" || attempt >= MAX_NODE_ATTEMPTS) return status;

      const error =
        this.store.snapshot().groupPlanNodes.find((item) => item.id === nodeId)
          ?.error ?? "";
      if (!isRetryableFailure(error)) return status;
      if (this.activeTasks.get(taskId)?.cancelled) return status;

      if (this.config.nodeEnv !== "test") {
        console.warn(
          "[runner] retrying node " +
            nodeId +
            " after a transient failure (attempt " +
            attempt +
            " of " +
            MAX_NODE_ATTEMPTS +
            "): " +
            error,
        );
      }
      // Clear the failure so the retry starts from a clean row; the previous
      // attempt survives as its own run.
      await this.store.mutate((database) => {
        const node = database.groupPlanNodes.find((item) => item.id === nodeId);
        if (!node) return;
        node.status = "queued";
        node.error = null;
        node.completedAt = null;
      });
    }
  }

  private async runPlanNode(
    taskId: string,
    nodeId: string,
  ): Promise<GroupTaskStatus> {
    const database = this.store.snapshot();
    const task = database.groupTasks.find((item) => item.id === taskId);
    const node = database.groupPlanNodes.find((item) => item.id === nodeId);
    if (!task || !node) return "failed";

    // Dependency gate. Containment and the execution order below should make
    // this unreachable; it fires only if a node is somehow reached before its
    // plan said it could be. Failing loudly beats running an Agent without the
    // dependency output its instruction assumes it has.
    const unmet = node.dependsOn.find((dependencyId) => {
      const dependency = database.groupPlanNodes.find(
        (item) => item.id === dependencyId,
      );
      return !dependency || dependency.status !== "completed";
    });
    if (unmet) {
      await this.failNode(
        nodeId,
        "This node ran before its dependencies completed",
      );
      return "failed";
    }

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
              : "The task ended before this node ran");
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
   * Attach a new task to the group's open topic segment, closing that segment
   * first if the incoming prompt has changed the subject or the segment has hit
   * a size cap. Returns the id of a segment that closed, or null.
   *
   * Runs INSIDE the caller's `store.mutate`, in the same transaction that
   * creates the task and its human message, so a task can never end up without
   * a segment or attached to a segment that is already closed.
   */
  private assignTaskToSegment(
    database: Database,
    groupId: string,
    taskId: string,
    prompt: string,
    seq: number,
    timestamp: string,
  ): string | null {
    const open = findOpenSegment(database.topicSegments, groupId);

    if (!open) {
      const segment = createSegment(groupId, seq, timestamp);
      segment.groupTaskIds.push(taskId);
      database.topicSegments.push(segment);
      return null;
    }

    const decision = decideSegmentBoundary({
      segment: open,
      segmentPrompts: humanPromptsIn(open, database.groupTasks),
      segmentChars: transcriptCharsIn(open, database.groupMessages),
      incomingPrompt: prompt,
      policy: this.config.segmentPolicy,
    });

    if (decision.kind === "continue") {
      open.groupTaskIds.push(taskId);
      return null;
    }

    // The subject changed: the closing segment ends just before this prompt,
    // which becomes the first message of the new one.
    closeSegmentInPlace(open, {
      reason: decision.reason,
      driftScore: decision.driftScore,
      endSeq: seq - 1,
      at: timestamp,
    });
    const next = createSegment(groupId, seq, timestamp);
    next.groupTaskIds.push(taskId);
    database.topicSegments.push(next);
    return open.id;
  }

  /**
   * Bridge 4. Consolidate one closed segment, then stamp it flushed.
   *
   * Memory failures must never fail a completed group task, so every error from
   * here is swallowed after logging. `flushedAt` is stamped even when
   * extraction produced nothing, so a barren segment is not retried forever.
   */
  private async consolidateSegment(segmentId: string): Promise<void> {
    try {
      const database = this.store.snapshot();
      const segment = database.topicSegments.find(
        (item) => item.id === segmentId,
      );
      // Only a CLOSED, unflushed segment consolidates. Checking `status` is not
      // redundant with `flushedAt`: a segment reopened by a resume is unflushed
      // but still accumulating, and must not be extracted mid-flight.
      if (!segment || segment.status !== "closed" || segment.flushedAt) return;

      // Every task in a closing segment should already be terminal -- the group
      // rejects a new prompt while one runs -- but verify rather than assume.
      // An unsettled task leaves the segment closed and unflushed, and the next
      // close attempt retries it.
      const settled = segment.groupTaskIds.every((taskId) => {
        const task = database.groupTasks.find((item) => item.id === taskId);
        if (!task) return true;
        return decideFlush({
          groupTask: task,
          planNodes: database.groupPlanNodes,
          ignoreFlushMark: true,
        }).shouldFlush;
      });
      if (!settled) return;

      await this.memoryPipeline.runMemoryPipeline(segmentId);
      await this.store.mutate((db) => {
        const stored = db.topicSegments.find((item) => item.id === segmentId);
        if (stored) stored.flushedAt = now();
      });
    } catch (error) {
      if (this.config.nodeEnv !== "test") {
        console.error(
          "[memory] pipeline failed for topic segment " +
            segmentId +
            ": " +
            this.messageOf(error),
        );
      }
    }
  }

  /**
   * Called when a task settles.
   *
   * Consolidation NO LONGER happens here -- it happens when the task's topic
   * segment closes, which is the whole point of segment consolidation. This
   * only stamps the task and closes the segment early if the task just pushed
   * it past a size cap, so a long-running subject still consolidates without
   * waiting for a prompt that may never arrive.
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

      let cappedSegmentId: string | null = null;
      await this.store.mutate((db) => {
        const task = db.groupTasks.find((item) => item.id === taskId);
        if (task) task.flushedAt = now();

        const open = findOpenSegment(db.topicSegments, groupTask.groupId);
        if (!open) return;
        const policy = this.config.segmentPolicy;
        const overCap =
          open.groupTaskIds.length >= policy.maxTasks ||
          transcriptCharsIn(open, db.groupMessages) >= policy.maxChars;
        if (!overCap) return;

        const lastSeq = db.groupMessages
          .filter((message) => message.groupId === groupTask.groupId)
          .reduce((highest, message) => Math.max(highest, message.seq), 0);
        closeSegmentInPlace(open, {
          reason: "size_cap",
          driftScore: null,
          endSeq: lastSeq,
          at: now(),
        });
        cappedSegmentId = open.id;
      });

      if (cappedSegmentId) await this.consolidateSegment(cappedSegmentId);
    } catch (error) {
      if (this.config.nodeEnv !== "test") {
        console.error(
          "[memory] segment bookkeeping failed for group task " +
            taskId +
            ": " +
            this.messageOf(error),
        );
      }
    }
  }

  /**
   * Close and consolidate the group's open segment if it has gone quiet.
   *
   * A segment otherwise only closes when the NEXT prompt arrives, so a user who
   * stops working would leave their last segment unconsolidated. Called lazily
   * from group read paths -- no timer, no background loop, nothing to stub in
   * tests. A group nobody revisits stays unconsolidated, which is the accepted
   * cost of not running a sweep.
   */
  async sweepIdleSegments(groupId: string): Promise<void> {
    try {
      const database = this.store.snapshot();
      const policy = this.config.segmentPolicy;
      const idle = findIdleSegment(
        database.topicSegments,
        database.groupMessages,
        groupId,
        policy.idleMs,
        Date.now(),
      );
      if (!idle) return;

      // Never close a segment out from under a running task.
      const group = database.groups.find((item) => item.id === groupId);
      if (group?.activeTaskId) return;

      await this.store.mutate((db) => {
        const stored = db.topicSegments.find((item) => item.id === idle.id);
        if (!stored || stored.status !== "open") return;
        const lastSeq = db.groupMessages
          .filter((message) => message.groupId === groupId)
          .reduce((highest, message) => Math.max(highest, message.seq), 0);
        closeSegmentInPlace(stored, {
          reason: "idle",
          driftScore: null,
          endSeq: lastSeq,
          at: now(),
        });
      });
      await this.consolidateSegment(idle.id);
    } catch (error) {
      if (this.config.nodeEnv !== "test") {
        console.error(
          "[memory] idle sweep failed for group " +
            groupId +
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
          // A resume is a fresh decision by a human, so the retry budget starts
          // over. Without this, a node that exhausted its attempts could never
          // be resumed into a successful run.
          node.attempts = 0;
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

  /**
   * The task's nodes in a dependency-safe execution order.
   *
   * This used to sort by `createdAt` alone -- but `buildPlanNodes()` stamps
   * EVERY node of a task with the same timestamp, so every comparison returned
   * 0 and the order survived only because V8's sort is stable and the planner
   * happened to insert topologically. Correct by accident. `orderForExecution`
   * makes it correct on purpose while preserving the planner's order between
   * nodes that are equally ready, so a plan still runs in the order it reads.
   */
  private chainFor(taskId: string): GroupPlanNode[] {
    const nodes = this.store
      .snapshot()
      .groupPlanNodes.filter((node) => node.groupTaskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return orderForExecution(nodes);
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

  /**
   * Record that a node was skipped because an ancestor failed.
   *
   * Status stays `cancelled` -- adding a `blocked` value to GroupTaskStatus
   * would ripple into flush-trigger's NODE_TERMINAL, the API DTO, the web
   * mirror type and every status pill, for a distinction the error string
   * already carries. What matters is that the reason NAMES the node that
   * actually failed, instead of the old blanket "an earlier node in the chain
   * did not complete" -- which is false for a node on an unrelated branch.
   */
  private async blockNode(
    nodeId: string,
    blocker: GroupPlanNode,
  ): Promise<void> {
    const completedAt = now();
    await this.store.mutate((database) => {
      const node = database.groupPlanNodes.find((item) => item.id === nodeId);
      if (!node) return;
      node.status = "cancelled";
      node.error =
        "Blocked: this node depends on " +
        blocker.nodeRole +
        ", which did not complete";
      node.completedAt = completedAt;
    });
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

/**
 * Do two nodes claim overlapping ground in the shared `./code` tree?
 *
 * This is the runtime-lock COLLISION validation the docs defer as STRETCH. It
 * was safe to defer only while execution was sequential; running two nodes at
 * once makes it the thing that keeps concurrent writers from colliding.
 *
 * Lock keys are globs (`code/apps/server/**`), so string equality is not
 * enough: `code/**` contains `code/apps/server/**`. Both are reduced to their
 * directory prefix and compared for containment in either direction. A
 * read-only node declares no locks and therefore never conflicts.
 */
export function locksConflict(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const prefix = (key: string): string =>
    key.replace(/\*+$/, "").replace(/\/+$/, "");
  for (const a of left) {
    const pa = prefix(a);
    for (const b of right) {
      const pb = prefix(b);
      // An empty prefix came from a bare `**`: it covers everything.
      if (pa === "" || pb === "" || pa === pb) return true;
      if (pa.startsWith(pb + "/") || pb.startsWith(pa + "/")) return true;
    }
  }
  return false;
}

/** Attempts per node, first try included. */
export const MAX_NODE_ATTEMPTS = 2;

/**
 * Is this failure worth trying again?
 *
 * Retrying costs a full model run, so the default is NO. Only failures that
 * are plausibly about the environment rather than the answer are retried: a
 * run that completed and produced a poor result will produce the same poor
 * result the second time, for the same tokens.
 *
 * Deliberately excluded: "Codex completed without an agent message" (the model
 * answered, just emptily), "exceeded CODEX_MAX_OUTPUT_BYTES" (deterministic),
 * anything about group membership, and `spawn ... ENOENT` (the binary is not
 * there; that is a deployment fault and a second attempt cannot fix it).
 */
export function isRetryableFailure(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes("enoent")) return false;
  if (text.includes("without an agent message")) return false;
  if (text.includes("codex_max_output_bytes")) return false;
  return (
    text.includes("timed out") ||
    text.includes("already has an active") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("socket hang up") ||
    /exited with code (?!0)/.test(text)
  );
}

/**
 * A dependency-safe execution order that preserves the planner's ordering.
 *
 * Kahn's algorithm, with the ORIGINAL ARRAY INDEX as the tie-break between
 * equally-ready nodes. That tie-break matters: the planner already returns its
 * nodes topologically ordered and that order is meaningful (it is the sequence
 * the plan reads in), so two independent nodes must keep their planned order
 * rather than being reordered by id or timestamp.
 *
 * Deliberately NOT `task-buffer.ts`'s `topologicalSort()`: that one breaks ties
 * on `completedAt` then id, which is right for assembling a finished
 * transcript and wrong here -- on a fresh task every `completedAt` is null, so
 * it would order the run by UUID.
 *
 * Never drops a node. A dependency outside this set is ignored, and a cycle
 * (which the planner rejects, so this is belt-and-braces) leaves the remaining
 * nodes in their input order rather than silently losing them.
 */
export function orderForExecution(
  nodes: readonly GroupPlanNode[],
): GroupPlanNode[] {
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const pending = nodes.map(
    (node) => new Set(node.dependsOn.filter((id) => indexOf.has(id))),
  );
  const placed = new Set<number>();
  const ordered: GroupPlanNode[] = [];

  while (ordered.length < nodes.length) {
    const ready = pending.findIndex(
      (dependencies, index) => !placed.has(index) && dependencies.size === 0,
    );
    if (ready === -1) break; // cycle: fall through to the remainder below
    placed.add(ready);
    ordered.push(nodes[ready]!);
    const id = nodes[ready]!.id;
    for (const dependencies of pending) dependencies.delete(id);
    pending[ready] = new Set(["__placed__"]);
  }

  for (const [index, node] of nodes.entries()) {
    if (!placed.has(index)) ordered.push(node);
  }
  return ordered;
}
