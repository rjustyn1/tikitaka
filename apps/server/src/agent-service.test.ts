import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentGroup,
  AgentRunner,
  GroupPlanNode,
  GroupRuntimeLock,
  GroupTask,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeHarness(runner: AgentRunner = new FakeRunner()): Promise<{
  service: AgentService;
  store: JsonStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
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
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { service, store };
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const { service } = await makeHarness(runner);
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("starts a fresh Codex thread when requested", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          output: "done",
          threadId: request.threadId ?? "new-thread-" + requests.length,
          usage: null,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Fresh" });

    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).codexThreadId).toBe("new-thread-1");

    const second = await service.sendMessage(agent.id, {
      content: "prove landed memory",
      freshThread: true,
    });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(requests.map((request) => request.threadId)).toEqual([null, null]);
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("surfaces group-held Agent leases as 409s", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Leased" });
    const holder = { kind: "group" as const, groupTaskId: randomUUID(), planNodeId: randomUUID() };

    await service.acquireAgent(agent.id, holder);
    await expect(service.sendMessage(agent.id, "solo")).rejects.toMatchObject({
      statusCode: 409,
      message: "This Agent is running group task " + holder.groupTaskId,
    });
    await expect(service.stopAgent(agent.id)).rejects.toMatchObject({
      statusCode: 409,
      message:
        "This Agent is running group task " +
        holder.groupTaskId +
        ". Cancel the group task first.",
    });

    await service.releaseAgent(agent.id, holder);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });
});

describe("Group contracts", () => {
  it("creates and updates role-bound groups", async () => {
    const service = await makeService();
    const [backend, frontend, security] = await Promise.all([
      service.createAgent({ name: "Backend" }),
      service.createAgent({ name: "Frontend" }),
      service.createAgent({ name: "Security" }),
    ]);

    const group = await service.createGroup({
      name: "Upload Feature Team",
      members: [
        { agentId: backend.id, role: "backend" },
        { agentId: frontend.id, role: "frontend" },
        { agentId: security.id, role: "security" },
      ],
    });
    expect(group.members.map((member) => member.role).sort()).toEqual([
      "backend",
      "frontend",
      "security",
    ]);

    const updated = await service.updateGroup(group.id, {
      description: "Builds upload flows",
    });
    expect(updated.description).toBe("Builds upload flows");
    expect(service.listGroups()).toHaveLength(1);
  });

  it("rejects membership updates while a group task is active", async () => {
    const { service, store } = await makeHarness();
    const [backend, frontend, security] = await Promise.all([
      service.createAgent({ name: "Backend" }),
      service.createAgent({ name: "Frontend" }),
      service.createAgent({ name: "Security" }),
    ]);
    const group = await service.createGroup({
      name: "Frozen",
      members: [
        { agentId: backend.id, role: "backend" },
        { agentId: frontend.id, role: "frontend" },
        { agentId: security.id, role: "security" },
      ],
    });
    await store.mutate((database) => {
      const stored = database.groups.find((item) => item.id === group.id);
      if (stored) stored.activeTaskId = randomUUID();
    });

    await expect(
      service.updateGroup(group.id, {
        members: [
          { agentId: backend.id, role: "backend" },
          { agentId: security.id, role: "frontend" },
          { agentId: frontend.id, role: "security" },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("cleans stale group runtime state on initialize", async () => {
    const { service, store } = await makeHarness();
    const agent = await service.createAgent({ name: "Restarted" });
    const group = groupFixture(agent);
    const task = taskFixture(group);
    const node = nodeFixture(task, agent);
    const lock = lockFixture(task, node);
    await store.mutate((database) => {
      database.groups.push(group);
      database.groupTasks.push(task);
      database.groupPlanNodes.push(node);
      database.runtimeLocks.push(lock);
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
    });

    await service.initialize();
    const snapshot = store.snapshot();
    expect(snapshot.groupTasks.find((item) => item.id === task.id)?.status).toBe(
      "cancelled",
    );
    expect(snapshot.groups.find((item) => item.id === group.id)?.activeTaskId).toBeNull();
    expect(snapshot.groupPlanNodes.find((item) => item.id === node.id)?.status).toBe(
      "cancelled",
    );
    expect(snapshot.runtimeLocks.find((item) => item.id === lock.id)?.releasedAt)
      .not.toBeNull();
    expect(service.getAgent(agent.id).status).toBe("ready");
  });
});

function groupFixture(agent: Agent): AgentGroup {
  const id = randomUUID();
  return {
    id,
    name: "Restart group",
    description: "",
    members: [
      { agentId: agent.id, role: "backend" },
      { agentId: randomUUID(), role: "frontend" },
      { agentId: randomUUID(), role: "security" },
    ],
    activeTaskId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function taskFixture(group: AgentGroup): GroupTask {
  const id = randomUUID();
  group.activeTaskId = id;
  return {
    id,
    groupId: group.id,
    prompt: "do work",
    sharedCodePath: "/tmp/shared-code/" + id,
    status: "running",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: null,
  };
}

function nodeFixture(task: GroupTask, agent: Agent): GroupPlanNode {
  return {
    id: randomUUID(),
    groupTaskId: task.id,
    agentId: agent.id,
    kind: "work",
    nodeRole: "backend-contract",
    dependsOn: [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "running",
    runId: null,
    output: null,
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    instruction: "",
    expectedOutput: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: null,
  };
}

function lockFixture(task: GroupTask, node: GroupPlanNode): GroupRuntimeLock {
  return {
    id: randomUUID(),
    groupTaskId: task.id,
    lockKey: "code/apps/server/**",
    holderPlanNodeId: node.id,
    acquiredAt: "2026-01-01T00:00:01.000Z",
    releasedAt: null,
  };
}
