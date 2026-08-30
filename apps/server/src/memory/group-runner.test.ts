import { lstat, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import { FakeRunner } from "../test-helpers.js";
import type { Agent, TraceSpan } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import type { MemoryPipeline } from "./pipeline.js";
import { RecordingMemoryPipeline } from "../test-helpers.js";
import type { GroupMember } from "../types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        }),
      ),
  );
});

const TERMINAL_TASK_STATUSES = ["completed", "partial", "failed", "cancelled"];

interface Harness {
  service: AgentService;
  runner: FakeRunner;
  pipeline: RecordingMemoryPipeline;
  store: JsonStore;
  root: string;
  backend: Agent;
  frontend: Agent;
  security: Agent;
  members: GroupMember[];
}

async function makeHarness(
  runner: FakeRunner = new FakeRunner(),
  pipeline: MemoryPipeline & { calls?: unknown } = new RecordingMemoryPipeline(),
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-group-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(
    config,
    store,
    new WorkspaceManager(path.join(root, "workspaces"), "local-process"),
    runner,
    pipeline,
  );
  await service.initialize();

  const backend = await service.createAgent({ name: "Backend" });
  const frontend = await service.createAgent({ name: "Frontend" });
  const security = await service.createAgent({ name: "Security" });
  const members: GroupMember[] = [
    { agentId: backend.id, role: "backend" },
    { agentId: frontend.id, role: "frontend" },
    { agentId: security.id, role: "security" },
  ];
  return {
    service,
    runner,
    pipeline: pipeline as RecordingMemoryPipeline,
    store,
    root,
    backend,
    frontend,
    security,
    members,
  };
}

async function runToCompletion(harness: Harness, prompt = "Plan an upload feature.") {
  const group = await harness.service.createGroup({
    name: "Upload Feature Team",
    members: harness.members,
  });
  const task = await harness.service.startGroupTask(group.id, prompt);
  await settle(harness, task.id);
  return { group, task };
}

describe("group lifecycle", () => {
  it("requires exactly one Agent per role", async () => {
    const harness = await makeHarness();
    await expect(
      harness.service.createGroup({
        name: "Too small",
        members: harness.members.slice(0, 2),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      harness.service.createGroup({
        name: "Duplicate role",
        members: [
          { agentId: harness.backend.id, role: "backend" },
          { agentId: harness.frontend.id, role: "backend" },
          { agentId: harness.security.id, role: "security" },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("freezes membership while a task is running", async () => {
    const runner = new FakeRunner();
    const harness = await makeHarness(runner);
    const release = runner.pause();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    await harness.service.startGroupTask(group.id, "Plan an upload feature.");
    await expect.poll(() => runner.requests.length).toBeGreaterThan(0);

    await expect(
      harness.service.updateGroup(group.id, { name: "Renamed" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      harness.service.startGroupTask(group.id, "second task"),
    ).rejects.toMatchObject({ statusCode: 409 });

    release();
    await expect
      .poll(() => harness.service.getGroup(group.id).activeTaskId, {
        timeout: 5_000,
      })
      .toBeNull();
  });

  it("cleans setup artifacts when a member rejects shared code", async () => {
    const harness = await makeHarness();
    await writeFile(path.join(harness.frontend.workspacePath, "code"), "owned", "utf8");
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });

    await expect(
      harness.service.startGroupTask(group.id, "Plan an upload feature."),
    ).rejects.toMatchObject({ statusCode: 409 });

    await expect(lstat(path.join(harness.backend.workspacePath, "code"))).rejects.toThrow();
    expect(await readFile(path.join(harness.frontend.workspacePath, "code"), "utf8")).toBe(
      "owned",
    );
    expect(await readdir(path.join(harness.root, "workspaces", "shared-code"))).toEqual([]);
    expect(harness.store.snapshot().groupTasks).toHaveLength(0);
  });

  it("persists a group span before its node completes", async () => {
    const runner = new FakeRunner();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let spanSeen!: () => void;
    const seen = new Promise<void>((resolve) => {
      spanSeen = resolve;
    });
    runner.run = async (request) => {
      const startedAt = new Date().toISOString();
      const span: TraceSpan = {
        id: "group-active-span",
        runId: request.runId,
        agentId: request.agentId,
        seq: 1,
        type: "reasoning",
        parentId: null,
        status: "started",
        startedAt,
        completedAt: null,
        durationMs: null,
        payload: { kind: "reasoning", text: "thinking", truncated: false },
        itemId: null,
      };
      request.onSpan?.(span);
      spanSeen();
      await pending;
      return { output: "done", threadId: "group-thread", usage: null };
    };
    const harness = await makeHarness(runner);
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(group.id, "Plan it.");

    await spanSeen;
    await expect.poll(() => harness.store.snapshot().runs.length).toBe(1);
    const runId = harness.store.snapshot().runs[0]!.id;
    expect(harness.service.getGroupTask(task.id).nodes[0]!.runId).toBe(runId);
    await expect.poll(() => harness.service.getSpans(runId).spans).toHaveLength(1);
    expect(harness.service.getRun(runId).status).toBe("running");

    release();
    await settle(harness, task.id);
  });

  it("starts a second local-process task after the first completes", async () => {
    const harness = await makeHarness();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });

    const first = await harness.service.startGroupTask(group.id, "First task.");
    await settle(harness, first.id);
    const second = await harness.service.startGroupTask(group.id, "Second task.");
    await settle(harness, second.id);

    expect(harness.service.getGroupTask(first.id).task.status).toBe("completed");
    expect(harness.service.getGroupTask(second.id).task.status).toBe("completed");
    for (const agent of [harness.backend, harness.frontend, harness.security]) {
      await expect(lstat(path.join(agent.workspacePath, "code"))).rejects.toThrow();
    }
  });

  it("gives a re-added Agent a new epoch and a fresh group thread", async () => {
    const harness = await makeHarness();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    await runToCompletionFor(harness, group.id);

    const before = harness.store
      .snapshot()
      .groupParticipants.find((item) => item.agentId === harness.security.id);
    expect(before?.membershipEpoch).toBe(1);
    expect(before?.groupThreadId).not.toBeNull();

    const replacement = await harness.service.createAgent({ name: "Security 2" });
    await harness.service.updateGroup(group.id, {
      members: [
        { agentId: harness.backend.id, role: "backend" },
        { agentId: harness.frontend.id, role: "frontend" },
        { agentId: replacement.id, role: "security" },
      ],
    });
    const removed = harness.store
      .snapshot()
      .groupParticipants.find((item) => item.agentId === harness.security.id);
    expect(removed?.removedAt).not.toBeNull();

    await harness.service.updateGroup(group.id, { members: harness.members });
    const readded = harness.store
      .snapshot()
      .groupParticipants.find((item) => item.agentId === harness.security.id);
    expect(readded?.removedAt).toBeNull();
    expect(readded?.membershipEpoch).toBe(2);
    expect(readded?.groupThreadId).toBeNull();
  });
});

async function settle(harness: Harness, taskId: string): Promise<void> {
  await expect
    .poll(
      () =>
        TERMINAL_TASK_STATUSES.includes(
          harness.service.getGroupTask(taskId).task.status,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function runToCompletionFor(harness: Harness, groupId: string) {
  const task = await harness.service.startGroupTask(
    groupId,
    "Plan an upload feature.",
  );
  await settle(harness, task.id);
  return task;
}

describe("sequential chain execution", () => {
  it("runs the five-node chain in role order and completes", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("completed");
    expect(response.nodes.map((node) => node.nodeRole)).toEqual([
      "backend-contract",
      "frontend-plan",
      "security-review",
      "backend-impl",
      "frontend-impl",
    ]);
    expect(response.nodes.every((node) => node.status === "completed")).toBe(true);
    expect(response.nodes.map((node) => node.agentId)).toEqual([
      harness.backend.id,
      harness.frontend.id,
      harness.security.id,
      harness.backend.id,
      harness.frontend.id,
    ]);
    // Each node depends on exactly its predecessor: a degenerate DAG.
    expect(response.nodes[0]!.dependsOn).toEqual([]);
    expect(response.nodes[3]!.dependsOn).toEqual([response.nodes[2]!.id]);
  });

  it("lets Backend and Frontend take two turns without a lease deadlock", async () => {
    const harness = await makeHarness();
    await runToCompletion(harness);
    expect(harness.runner.requestsFor(harness.backend.id)).toHaveLength(2);
    expect(harness.runner.requestsFor(harness.frontend.id)).toHaveLength(2);
    expect(harness.runner.requestsFor(harness.security.id)).toHaveLength(1);
    // Every lease was handed back.
    expect(
      harness.service.listAgents().every((agent) => agent.status === "ready"),
    ).toBe(true);
  });

  it("writes group messages in seq order, human first", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const messages = harness.service.getGroupTask(task.id).messages;

    expect(messages).toHaveLength(6); // 1 human + 5 agent turns
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(messages[0]!.speakerType).toBe("human");
    expect(messages.slice(1).map((message) => message.speakerAgentId)).toEqual([
      harness.backend.id,
      harness.frontend.id,
      harness.security.id,
      harness.backend.id,
      harness.frontend.id,
    ]);
  });

  it("keeps the group thread separate from the solo thread", async () => {
    const harness = await makeHarness();
    await runToCompletion(harness);

    // No group task may touch Agent.codexThreadId.
    expect(harness.service.getAgent(harness.backend.id).codexThreadId).toBeNull();
    const participant = harness.store
      .snapshot()
      .groupParticipants.find((item) => item.agentId === harness.backend.id);
    expect(participant?.groupThreadId).toBe("fake-thread");
    // And the runner was asked to use the group thread, never the solo one.
    expect(harness.runner.requestsFor(harness.backend.id)[0]!.threadId).toBeNull();
    expect(harness.runner.requestsFor(harness.backend.id)[1]!.threadId).toBe(
      "fake-thread",
    );
  });

  it("prepares shared ./code for every member and passes it to the runner (A2)", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const shared = harness.service.getGroupTask(task.id).task.sharedCodePath;

    for (const agent of [harness.backend, harness.frontend, harness.security]) {
      await writeFile(
        path.join(shared, agent.name + ".txt"),
        agent.name,
        "utf8",
      );
      expect(await readFile(path.join(shared, agent.name + ".txt"), "utf8")).toBe(
        agent.name,
      );
      await expect(lstat(path.join(agent.workspacePath, "code"))).rejects.toThrow();
    }
    // Every group run carried sharedCodePath; that is what becomes --add-dir
    // or the nested bind mount.
    expect(
      harness.runner.requests.every(
        (request) => request.sharedCodePath === shared,
      ),
    ).toBe(true);
  });

  it("records a context packet per node, and dedupes what an Agent already saw", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const { contextInjections, messages, nodes } =
      harness.service.getGroupTask(task.id);

    expect(contextInjections).toHaveLength(5);
    const first = contextInjections.find(
      (injection) => injection.planNodeId === nodes[0]!.id,
    );
    // Node 1 sees only the human prompt and withholds nothing.
    expect(first?.injectedMessageIds).toEqual([messages[0]!.id]);
    expect(first?.withheldMessageIds).toEqual([]);

    // Backend's SECOND turn must not be re-fed its own first message: that is
    // the lastSeenSeq dedupe doing real work, which only happens because an
    // Agent takes two turns.
    const backendSecond = contextInjections.find(
      (injection) => injection.planNodeId === nodes[3]!.id,
    );
    expect(backendSecond?.fromSeqExclusive).toBe(2);
    expect(backendSecond?.withheldMessageIds).toContain(messages[1]!.id);
    expect(backendSecond?.injectedMessageIds).not.toContain(messages[1]!.id);
  });

  it("writes and releases a runtime lock row per write node", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const locks = harness.store
      .snapshot()
      .runtimeLocks.filter((lock) => lock.groupTaskId === task.id);

    // Three write nodes declare an area; the two read-only planning nodes do not.
    expect(locks).toHaveLength(3);
    expect(locks.map((lock) => lock.lockKey).sort()).toEqual([
      "code/apps/server/**",
      "code/apps/server/**",
      "code/apps/web/**",
    ]);
    expect(locks.every((lock) => lock.releasedAt !== null)).toBe(true);
  });

  it("writes the group charter into each private AGENTS.md, never into shared code", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const shared = harness.service.getGroupTask(task.id).task.sharedCodePath;

    for (const agent of [harness.backend, harness.frontend, harness.security]) {
      const instructions = await readFile(
        path.join(agent.workspacePath, "AGENTS.md"),
        "utf8",
      );
      expect(instructions).toContain("Upload Feature Team");
      expect(instructions).toContain("Shared code lives under ./code");
    }
    await expect(readFile(path.join(shared, "AGENTS.md"), "utf8")).rejects.toThrow();
  });

  it("records an AgentRun and trace summary per node", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);
    expect(response.task.nodeRunIds).toHaveLength(5);
    for (const node of response.nodes) {
      expect(node.runId).not.toBeNull();
      const run = harness.service.getRun(node.runId!);
      expect(run.status).toBe("completed");
      expect(run.traceSummary).not.toBeNull();
    }
  });
});

describe("A3 - solo and group runs contend for one lease", () => {
  it("returns 409, not 500, when a solo message arrives during a group node", async () => {
    const runner = new FakeRunner();
    const harness = await makeHarness(runner);
    const release = runner.pause();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(group.id, "Plan it.");
    await expect.poll(() => runner.requests.length).toBeGreaterThan(0);

    await expect(
      harness.service.sendMessage(harness.backend.id, "solo work"),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "This Agent is running group task " + task.id,
    });
    // Stopping an Agent must not kill a running group node either.
    await expect(
      harness.service.stopAgent(harness.backend.id),
    ).rejects.toMatchObject({ statusCode: 409 });

    release();
    await settle(harness, task.id);
    expect(harness.service.getGroupTask(task.id).task.status).toBe("completed");
    // The lease is handed back, so solo work resumes normally.
    expect(harness.service.getAgent(harness.backend.id).status).toBe("ready");
  });
});

describe("failure and cancellation", () => {
  it("stops the chain on a failed node and consolidates partially", async () => {
    const runner = new FakeRunner({
      failFor: (request) =>
        request.prompt.includes("security-review") ? "Codex exploded" : null,
    });
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(runner, pipeline);
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("partial");
    expect(response.nodes.map((node) => node.status)).toEqual([
      "completed",
      "completed",
      "failed",
      "cancelled",
      "cancelled",
    ]);
    expect(response.nodes[2]!.error).toBe("Codex exploded");
    // Nothing is left holding a lock or a lease.
    expect(
      harness.store
        .snapshot()
        .runtimeLocks.every((lock) => lock.releasedAt !== null),
    ).toBe(true);
    expect(
      harness.service.listAgents().every((agent) => agent.status !== "busy"),
    ).toBe(true);
    // Partial work still reaches the memory pipeline.
    expect(pipeline.calls).toHaveLength(1);
  });

  it("cancels a running task, releasing leases and locks", async () => {
    const runner = new FakeRunner();
    const harness = await makeHarness(runner);
    const release = runner.pause();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(group.id, "Plan it.");
    await expect.poll(() => runner.requests.length).toBeGreaterThan(0);

    await harness.service.cancelGroupTask(task.id);
    await settle(harness, task.id);
    expect(harness.service.getGroupTask(task.id).task.status).toBe("cancelled");

    const response = harness.service.getGroupTask(task.id);
    expect(response.nodes.every((node) => node.status === "cancelled")).toBe(true);
    expect(
      harness.store
        .snapshot()
        .runtimeLocks.every((lock) => lock.releasedAt !== null),
    ).toBe(true);
    expect(harness.service.getGroup(group.id).activeTaskId).toBeNull();
    expect(
      harness.service.listAgents().every((agent) => agent.status !== "busy"),
    ).toBe(true);
    release();
  });

  it("clears stale group state on restart", async () => {
    const harness = await makeHarness();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    // Simulate a crash mid-task: rows left running with the group locked.
    await harness.store.mutate((database) => {
      database.groupTasks.push({
        id: "stale-task",
        groupId: group.id,
        prompt: "interrupted",
        sharedCodePath: "/tmp/none",
        status: "running",
        currentNodeId: null,
        nodeRunIds: [],
        flushedAt: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
      });
      database.runtimeLocks.push({
        id: "stale-lock",
        groupTaskId: "stale-task",
        lockKey: "code/apps/server/**",
        holderPlanNodeId: "stale-node",
        acquiredAt: new Date().toISOString(),
        releasedAt: null,
      });
      const stored = database.groups.find((item) => item.id === group.id);
      if (stored) stored.activeTaskId = "stale-task";
    });

    await harness.service.initialize();

    expect(harness.service.getGroupTask("stale-task").task.status).toBe("cancelled");
    expect(harness.service.getGroup(group.id).activeTaskId).toBeNull();
    expect(
      harness.store
        .snapshot()
        .runtimeLocks.every((lock) => lock.releasedAt !== null),
    ).toBe(true);
    // The group is usable again, which is the whole point.
    await expect(
      harness.service.startGroupTask(group.id, "try again"),
    ).resolves.toBeDefined();
  });
});

describe("Bridge 4 - handover to the memory pipeline", () => {
  it("calls the pipeline once with the sink node id after the chain completes", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(pipeline.calls).toHaveLength(1);
    expect(pipeline.calls[0]).toEqual({
      groupTaskId: task.id,
      sinkNodeIds: [response.nodes[4]!.id],
    });
    expect(response.task.flushedAt).not.toBeNull();
  });

  it("never fails a completed task when the pipeline throws", async () => {
    const exploding: MemoryPipeline = {
      async runMemoryPipeline() {
        throw new Error("consolidator unavailable");
      },
      async resetAutoNotes() {},
    };
    const harness = await makeHarness(new FakeRunner(), exploding);
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("completed");
    expect(response.task.flushedAt).toBeNull();
  });
});

describe("group task resume", () => {
  it("resumes a partial task, reusing completed nodes and re-running the rest", async () => {
    let failSecurity = true;
    let securityId = "";
    const runner = new FakeRunner({
      failFor: (request) =>
        failSecurity && request.agentId === securityId
          ? "the model ran out of tokens"
          : null,
    });
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(runner, pipeline);
    securityId = harness.security.id;

    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(
      group.id,
      "Plan an upload feature.",
    );
    await settle(harness, task.id);

    // The chain stops at the security node: two nodes completed, task is partial.
    const partial = harness.service.getGroupTask(task.id);
    expect(partial.task.status).toBe("partial");
    const completedBefore = partial.nodes.filter(
      (node) => node.status === "completed",
    );
    expect(completedBefore).toHaveLength(2);
    expect(runner.requests).toHaveLength(3); // 2 ok + 1 failed

    // Switch model (simulated) and resume.
    failSecurity = false;
    await harness.service.resumeGroupTask(task.id);
    await settle(harness, task.id);

    const done = harness.service.getGroupTask(task.id);
    expect(done.task.status).toBe("completed");
    expect(done.nodes.every((node) => node.status === "completed")).toBe(true);
    // Completed nodes were NOT re-run: 3 (first run) + 3 (resume) = 6.
    expect(runner.requests).toHaveLength(6);
    // The already-completed node kept its original runId.
    const contractBefore = completedBefore.find(
      (node) => node.nodeRole === "backend-contract",
    )!;
    const contractAfter = done.nodes.find(
      (node) => node.nodeRole === "backend-contract",
    )!;
    expect(contractAfter.runId).toBe(contractBefore.runId);
    // The memory pipeline was asked to reset auto notes, then flushed again.
    expect(pipeline.resetCalls).toContain(task.id);
    expect(pipeline.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects resuming a completed task", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    await expect(
      harness.service.resumeGroupTask(task.id),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("group task history", () => {
  it("lists a group's tasks newest first", async () => {
    const harness = await makeHarness();
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    // Seed rows directly: two real runs on one group would collide on the
    // shared ./code link (a separate local-process constraint), which is not
    // what this test is about.
    await harness.store.mutate((db) => {
      const base = {
        groupId: group.id,
        prompt: "p",
        sharedCodePath: "/tmp/shared",
        status: "completed" as const,
        currentNodeId: null,
        nodeRunIds: [],
        flushedAt: null,
        startedAt: null,
        completedAt: null,
      };
      db.groupTasks.push(
        { ...base, id: "t-old", createdAt: "2026-01-01T00:00:00.000Z" },
        { ...base, id: "t-new", createdAt: "2026-01-02T00:00:00.000Z" },
      );
    });

    const tasks = harness.service.listGroupTasks(group.id);
    expect(tasks.map((task) => task.id)).toEqual(["t-new", "t-old"]);
  });
});
