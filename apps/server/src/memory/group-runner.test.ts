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
import { MAX_NODE_ATTEMPTS } from "./group-runner.js";
import type { MemoryPipeline } from "./pipeline.js";
import { TaskPlanner, type PlannerClient } from "./planner.js";
import { RecordingMemoryPipeline } from "../test-helpers.js";
import { SegmentBufferBuilder } from "./task-buffer.js";
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
  // Third arg accepts EITHER a ready TaskPlanner (recognition-branch call
  // sites) OR a plan-fixture object (origin/main call sites). Both styles are
  // in use across this file, so the harness discriminates at runtime.
  plannerOrExtra:
    | TaskPlanner
    | {
        planJson?: string;
        maxParallel?: number;
        onPlanPrompt?: (prompt: string) => void;
      } = {},
): Promise<Harness> {
  const explicitPlanner =
    plannerOrExtra instanceof TaskPlanner ? plannerOrExtra : undefined;
  const extra = plannerOrExtra instanceof TaskPlanner ? {} : plannerOrExtra;
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-group-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...(extra.maxParallel === undefined
      ? {}
      : { GROUP_MAX_PARALLEL_NODES: String(extra.maxParallel) }),
    // FakeRunner echoes the injected transcript back as its output, so message
    // content compounds run over run and a few nodes blow the real 120k char
    // cap on their own. Raise it here so segment tests exercise topic drift
    // rather than that fixture artifact; the cap itself is covered by
    // topic-segment.test.ts.
    MEMORY_SEGMENT_MAX_CHARS: "100000000",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(
    path.join(root, "workspaces"),
    "local-process",
  );
  const planner =
    explicitPlanner ??
    (extra.planJson === undefined && extra.onPlanPrompt === undefined
      ? undefined
      : new TaskPlanner({
          async extract(input) {
            extra.onPlanPrompt?.(input.prompt);
            return { rawText: extra.planJson ?? JSON.stringify({ nodes: [] }) };
          },
        }));
  const service = planner
    ? new AgentService(config, store, workspaces, runner, pipeline, planner)
    : new AgentService(config, store, workspaces, runner, pipeline);
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
  it("accepts flexible membership and rejects duplicate Agents", async () => {
    const harness = await makeHarness();
    const group = await harness.service.createGroup({
      name: "Small team",
      members: harness.members.slice(0, 2),
    });
    expect(group.members).toEqual(harness.members.slice(0, 2));

    await expect(
      harness.service.createGroup({
        name: "Duplicate Agent",
        members: [
          { agentId: harness.backend.id, role: "backend" },
          { agentId: harness.backend.id, role: "reviewer" },
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

  it("releases unselected members before a later task", async () => {
    const subsetClient: PlannerClient = {
      async extract() {
        return {
          rawText: JSON.stringify({
            nodes: [
              {
                agent: 1,
                nodeRole: "focused-work",
                instruction: "Complete the focused work.",
                expectedOutput: "A result.",
                dependsOn: [],
                area: "all",
                writes: true,
              },
            ],
          }),
        };
      },
    };
    const harness = await makeHarness(
      new FakeRunner(),
      new RecordingMemoryPipeline(),
      new TaskPlanner(subsetClient),
    );
    const group = await harness.service.createGroup({
      name: "Subset team",
      members: harness.members,
    });

    const first = await harness.service.startGroupTask(group.id, "First task.");
    await settle(harness, first.id);
    for (const agent of [harness.backend, harness.frontend, harness.security]) {
      await expect(lstat(path.join(agent.workspacePath, "code"))).rejects.toThrow();
    }

    const second = await harness.service.startGroupTask(group.id, "Second task.");
    await settle(harness, second.id);
    expect(harness.service.getGroupTask(second.id).task.status).toBe("completed");
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

describe("planner execution", () => {
  it("runs planner nodes in validated topological order and completes", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("completed");
    expect(response.nodes.map((node) => node.nodeRole)).toEqual([
      "plan",
      "implement-2",
      "implement-3",
    ]);
    expect(response.nodes.every((node) => node.status === "completed")).toBe(true);
    expect(response.nodes.map((node) => node.agentId)).toEqual([
      harness.backend.id,
      harness.frontend.id,
      harness.security.id,
    ]);
    expect(response.nodes[0]!.dependsOn).toEqual([]);
    expect(response.nodes[1]!.dependsOn).toEqual([response.nodes[0]!.id]);
    expect(response.nodes[2]!.dependsOn).toEqual([response.nodes[0]!.id]);
    expect(response.nodes.every((node) => node.instruction.length > 0)).toBe(true);
  });

  it("returns every planner-selected Agent lease after execution", async () => {
    const harness = await makeHarness();
    await runToCompletion(harness);
    expect(harness.runner.requestsFor(harness.backend.id)).toHaveLength(1);
    expect(harness.runner.requestsFor(harness.frontend.id)).toHaveLength(1);
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

    expect(messages).toHaveLength(4); // 1 human + 3 planner-selected turns
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3, 4]);
    expect(messages[0]!.speakerType).toBe("human");
    expect(messages.slice(1).map((message) => message.speakerAgentId)).toEqual([
      harness.backend.id,
      harness.frontend.id,
      harness.security.id,
    ]);
  });

  it("keeps the group thread separate from the solo thread", async () => {
    const harness = await makeHarness();
    const { group } = await runToCompletion(harness);
    await runToCompletionFor(harness, group.id);

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

  it("records a context packet per node with only declared dependencies", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const { contextInjections, messages, nodes } =
      harness.service.getGroupTask(task.id);

    expect(contextInjections).toHaveLength(3);
    const first = contextInjections.find(
      (injection) => injection.planNodeId === nodes[0]!.id,
    );
    // Node 1 sees only the human prompt and withholds nothing.
    expect(first?.injectedMessageIds).toEqual([messages[0]!.id]);
    expect(first?.withheldMessageIds).toEqual([]);

    for (const node of nodes.slice(1)) {
      const injection = contextInjections.find(
        (candidate) => candidate.planNodeId === node.id,
      );
      expect(injection?.injectedDependencyNodeIds).toEqual(node.dependsOn);
    }
  });

  it("writes and releases a runtime lock row per write node", async () => {
    const harness = await makeHarness();
    const { task } = await runToCompletion(harness);
    const locks = harness.store
      .snapshot()
      .runtimeLocks.filter((lock) => lock.groupTaskId === task.id);

    // The fake planner emits one read-only plan and two write nodes.
    expect(locks).toHaveLength(2);
    expect(locks.map((lock) => lock.lockKey)).toEqual(["code/**", "code/**"]);
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
    expect(response.task.nodeRunIds).toHaveLength(response.nodes.length);
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

describe("planner input", () => {
  it("gives the planner the group's description as well as the task prompt", async () => {
    // Additive: a short prompt still gets planned against what the team is for.
    let seen = "";
    const harness = await makeHarness(
      new FakeRunner(),
      new RecordingMemoryPipeline(),
      { onPlanPrompt: (prompt) => { seen = prompt; } },
    );
    const group = await harness.service.createGroup({
      name: "Upload Team",
      description: "We maintain the file upload service.",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(
      group.id,
      "Add a size limit.",
    );
    await settle(harness, task.id);

    expect(seen).toContain("We maintain the file upload service.");
    expect(seen).toContain("Add a size limit.");
    // Context comes first, the task reads inside it.
    expect(seen.indexOf("We maintain")).toBeLessThan(
      seen.indexOf("Add a size limit."),
    );
  });
});

describe("parallel execution", () => {
  /** Fan-out where the two branches own DIFFERENT areas of the shared tree. */
  const disjointPlan = JSON.stringify({
    nodes: [
      { agent: 1, nodeRole: "contract", instruction: "x", expectedOutput: "y",
        dependsOn: [], area: "none", writes: false },
      { agent: 2, nodeRole: "web-work", instruction: "x", expectedOutput: "y",
        dependsOn: [0], area: "web", writes: true },
      { agent: 3, nodeRole: "server-work", instruction: "x", expectedOutput: "y",
        dependsOn: [0], area: "server", writes: true },
    ],
  });

  /** The same fan-out, but both branches claim the whole tree. */
  const overlappingPlan = JSON.stringify({
    nodes: [
      { agent: 1, nodeRole: "contract", instruction: "x", expectedOutput: "y",
        dependsOn: [], area: "none", writes: false },
      { agent: 2, nodeRole: "all-a", instruction: "x", expectedOutput: "y",
        dependsOn: [0], area: "all", writes: true },
      { agent: 3, nodeRole: "all-b", instruction: "x", expectedOutput: "y",
        dependsOn: [0], area: "all", writes: true },
    ],
  });

  /** Fan-out where BOTH branches belong to the same Agent. */
  const sameAgentPlan = JSON.stringify({
    nodes: [
      { agent: 1, nodeRole: "contract", instruction: "x", expectedOutput: "y",
        dependsOn: [], area: "none", writes: false },
      { agent: 2, nodeRole: "web-a", instruction: "x", expectedOutput: "y",
        dependsOn: [0], area: "web", writes: true },
      { agent: 2, nodeRole: "docs-a", instruction: "x", expectedOutput: "y",
        dependsOn: [0], area: "docs", writes: true },
    ],
  });

  /**
   * Records the greatest number of runs in flight at once.
   *
   * Counting cumulative requests cannot tell "ran together" from "ran one after
   * the other"; holding each run open for a beat and watching the peak can.
   */
  class ConcurrencyRunner extends FakeRunner {
    inFlight = 0;
    peak = 0;
    override async run(request: Parameters<FakeRunner["run"]>[0]) {
      this.inFlight += 1;
      this.peak = Math.max(this.peak, this.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return await super.run(request);
      } finally {
        this.inFlight -= 1;
      }
    }
  }

  async function peakConcurrency(planJson: string, maxParallel?: number) {
    const runner = new ConcurrencyRunner();
    const harness = await makeHarness(runner, new RecordingMemoryPipeline(), {
      planJson,
      ...(maxParallel === undefined ? {} : { maxParallel }),
    });
    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(group.id, "Plan it.");
    await settle(harness, task.id);
    return { peak: runner.peak, harness, task };
  }

  it("runs independent branches at the same time when their areas are disjoint", async () => {
    const { peak, harness, task } = await peakConcurrency(disjointPlan);
    expect(peak).toBe(2);
    expect(
      harness.service
        .getGroupTask(task.id)
        .nodes.every((node) => node.status === "completed"),
    ).toBe(true);
  });

  it("serialises two branches that claim overlapping ground", async () => {
    // The runtime-lock collision rule. Both want code/**, so one waits even
    // though the DAG says they are independent.
    const { peak, harness, task } = await peakConcurrency(overlappingPlan);
    expect(peak).toBe(1);
    expect(
      harness.service
        .getGroupTask(task.id)
        .nodes.every((node) => node.status === "completed"),
    ).toBe(true);
  });

  it("never overlaps two nodes held by the same Agent", async () => {
    // The A3 lease is not re-entrant. Areas are disjoint here, so the Agent
    // rule is the only thing that can hold the second node back.
    const { peak, harness, task } = await peakConcurrency(sameAgentPlan);
    expect(peak).toBe(1);
    expect(
      harness.service
        .getGroupTask(task.id)
        .nodes.every((node) => node.status === "completed"),
    ).toBe(true);
  });

  it("restores strictly sequential execution at GROUP_MAX_PARALLEL_NODES=1", async () => {
    const { peak, harness, task } = await peakConcurrency(disjointPlan, 1);
    expect(peak).toBe(1);
    expect(harness.service.getGroupTask(task.id).task.status).toBe("completed");
  });
});

describe("failure and cancellation", () => {
  it("contains a failure to its own branch and consolidates partially", async () => {
    // The plan is a fan-out: node 0 (backend), then nodes 1 (frontend) and 2
    // (security) BOTH depending only on node 0. Failing node 1 must not touch
    // node 2 -- node 2's only dependency completed, so it is still runnable.
    // This loop used to `break` on any failure and abandon node 2 with it.
    let failingAgentId = "";
    const runner = new FakeRunner({
      failFor: (request) => (request.agentId === failingAgentId ? "Codex exploded" : null),
    });
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(runner, pipeline);
    failingAgentId = harness.frontend.id;
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("partial");
    expect(response.nodes.map((node) => node.status)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(response.nodes[1]!.error).toBe("Codex exploded");
    // The independent branch really ran, rather than being marked completed
    // without ever reaching the runner.
    expect(response.nodes[2]!.runId).not.toBeNull();
    expect(
      runner.requests.some((request) => request.agentId === harness.security.id),
    ).toBe(true);
    // Nothing is left holding a lock or a lease.
    expect(
      harness.store
        .snapshot()
        .runtimeLocks.every((lock) => lock.releasedAt !== null),
    ).toBe(true);
    expect(
      harness.service.listAgents().every((agent) => agent.status !== "busy"),
    ).toBe(true);
    // Partial work joins the open topic segment rather than consolidating on
    // the spot -- it reaches the pipeline when that segment closes.
    expect(pipeline.calls).toHaveLength(0);
    const segment = harness.store
      .snapshot()
      .topicSegments.find((item) => item.groupId === response.task.groupId)!;
    expect(segment.status).toBe("open");
    expect(segment.groupTaskIds).toContain(task.id);
  });

  it("blocks the nodes that actually depend on a failure, and names it", async () => {
    // Fail node 0 instead. Nodes 1 and 2 both depend on it, so both really are
    // blocked -- containment must not run them, and the reason recorded must
    // name the node that failed rather than the old blanket "an earlier node in
    // the chain did not complete".
    let failingAgentId = "";
    const runner = new FakeRunner({
      failFor: (request) => (request.agentId === failingAgentId ? "Codex exploded" : null),
    });
    const harness = await makeHarness(runner);
    failingAgentId = harness.backend.id;
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("failed");
    expect(response.nodes.map((node) => node.status)).toEqual([
      "failed",
      "cancelled",
      "cancelled",
    ]);
    for (const blocked of response.nodes.slice(1)) {
      expect(blocked.error).toBe(
        "Blocked: this node depends on " +
          response.nodes[0]!.nodeRole +
          ", which did not complete",
      );
      // Blocked means never started, not started-and-abandoned.
      expect(blocked.runId).toBeNull();
    }
    // The blocked Agents were never asked to run.
    expect(runner.requests).toHaveLength(1);
    expect(
      harness.store
        .snapshot()
        .runtimeLocks.every((lock) => lock.releasedAt !== null),
    ).toBe(true);
  });

  it("retries a transient failure, keeping each attempt as its own run", async () => {
    // A timeout is about the environment, not the answer, so it is worth one
    // more try. Both attempts must survive in the audit.
    let attemptsSeen = 0;
    let backendId = "";
    const runner = new FakeRunner({
      failFor: (request) => {
        if (request.agentId !== backendId) return null;
        attemptsSeen += 1;
        return attemptsSeen === 1 ? "Codex timed out after 600000 ms" : null;
      },
    });
    const harness = await makeHarness(runner);
    backendId = harness.backend.id;
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(response.task.status).toBe("completed");
    expect(attemptsSeen).toBe(2);
    const root = response.nodes[0]!;
    expect(root.status).toBe("completed");
    expect(root.attempts).toBe(2);

    // Two attempts are two REAL runs: the failed one is not overwritten.
    const runsForRoot = harness.store
      .snapshot()
      .runs.filter((run) => run.agentId === backendId);
    expect(runsForRoot).toHaveLength(2);
    expect(runsForRoot.filter((run) => run.status === "failed")).toHaveLength(1);
    expect(runsForRoot.filter((run) => run.status === "completed")).toHaveLength(1);
    // The node points at the successful attempt, and the task lists both.
    expect(root.runId).toBe(
      runsForRoot.find((run) => run.status === "completed")!.id,
    );
    expect(response.task.nodeRunIds).toEqual(
      expect.arrayContaining(runsForRoot.map((run) => run.id)),
    );
  });

  it("does not retry a failure that a second run cannot fix", async () => {
    // The model answered; it just answered badly. Retrying burns tokens for
    // the same result.
    let calls = 0;
    let backendId = "";
    const runner = new FakeRunner({
      failFor: (request) => {
        if (request.agentId !== backendId) return null;
        calls += 1;
        return "Codex completed without an agent message";
      },
    });
    const harness = await makeHarness(runner);
    backendId = harness.backend.id;
    const { task } = await runToCompletion(harness);

    expect(calls).toBe(1);
    expect(harness.service.getGroupTask(task.id).nodes[0]!.attempts).toBe(1);
  });

  it("gives up after the attempt cap and blocks downstream as usual", async () => {
    let calls = 0;
    let backendId = "";
    const runner = new FakeRunner({
      failFor: (request) => {
        if (request.agentId !== backendId) return null;
        calls += 1;
        return "Codex timed out after 600000 ms";
      },
    });
    const harness = await makeHarness(runner);
    backendId = harness.backend.id;
    const { task } = await runToCompletion(harness);
    const response = harness.service.getGroupTask(task.id);

    expect(calls).toBe(MAX_NODE_ATTEMPTS);
    expect(response.nodes[0]!.status).toBe("failed");
    expect(response.nodes[0]!.attempts).toBe(MAX_NODE_ATTEMPTS);
    // Retry exhaustion behaves exactly like any other failure downstream.
    expect(response.nodes.slice(1).every((n) => n.status === "cancelled")).toBe(
      true,
    );
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
  const UPLOAD = "Plan and implement an upload feature with storage and a contract.";
  const SAME_TOPIC = "Add resumable upload support to that storage endpoint.";
  const NEW_TOPIC = "Configure Kubernetes cluster autoscaling for production.";

  /** Every group task opens or joins exactly one topic segment. */
  function segmentsOf(harness: Harness, groupId: string) {
    return harness.store
      .snapshot()
      .topicSegments.filter((segment) => segment.groupId === groupId);
  }

  it("does not consolidate when a task completes - the segment is still open", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group, task } = await runToCompletion(harness, UPLOAD);

    // The subject has not changed, so there is nothing to consolidate yet.
    expect(pipeline.calls).toHaveLength(0);
    expect(segmentsOf(harness, group.id)).toHaveLength(1);
    expect(segmentsOf(harness, group.id)[0]!.status).toBe("open");
    // The task itself is still stamped, so it is never reconsidered.
    expect(harness.service.getGroupTask(task.id).task.flushedAt).not.toBeNull();
  });

  it("keeps a follow-up on the same subject in one segment", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group } = await runToCompletion(harness, UPLOAD);

    const second = await harness.service.startGroupTask(group.id, SAME_TOPIC);
    await settle(harness, second.id);

    expect(pipeline.calls).toHaveLength(0);
    const segments = segmentsOf(harness, group.id);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.groupTaskIds).toHaveLength(2);
  });

  it("consolidates the whole segment when the subject changes", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group, task } = await runToCompletion(harness, UPLOAD);

    const second = await harness.service.startGroupTask(group.id, SAME_TOPIC);
    await settle(harness, second.id);

    // A prompt on a different subject closes the accumulated segment.
    const third = await harness.service.startGroupTask(group.id, NEW_TOPIC);
    await settle(harness, third.id);

    // Consolidation is fire-and-forget, so wait for the hand-off rather than
    // reading calls the instant settle() returns.
    await expect.poll(() => pipeline.calls.length).toBe(1);

    const segments = segmentsOf(harness, group.id);
    expect(segments).toHaveLength(2);

    const closed = segments.find((segment) => segment.status === "closed")!;
    expect(closed.closeReason).toBe("topic_shift");
    expect(closed.driftScore).toBeGreaterThan(0);
    // Both upload tasks consolidated together -- the point of the feature.
    expect(closed.groupTaskIds).toEqual([task.id, second.id]);

    expect(pipeline.calls).toEqual([{ segmentId: closed.id }]);
    await expect
      .poll(
        () =>
          segmentsOf(harness, group.id).find((s) => s.id === closed.id)!
            .flushedAt,
      )
      .not.toBeNull();

    // The new subject starts a fresh, still-accumulating segment.
    const open = segments.find((segment) => segment.status === "open")!;
    expect(open.groupTaskIds).toEqual([third.id]);
  });

  it("consolidates each segment exactly once across repeated shifts", async () => {
    // Long enough that the pooled Kubernetes segment clears MIN_EVIDENCE_TERMS
    // and the return to uploads can be judged a shift.
    const NEW_TOPIC_FOLLOWUP =
      "Tune the Kubernetes autoscaling thresholds, node pool sizing, and " +
      "scheduler priorities across the production cluster.";
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group } = await runToCompletion(harness, UPLOAD);

    // Two prompts per subject, so each pooled segment clears MIN_EVIDENCE_TERMS
    // and the following prompt can actually be judged a shift.
    for (const prompt of [SAME_TOPIC, NEW_TOPIC, NEW_TOPIC_FOLLOWUP, UPLOAD]) {
      const task = await harness.service.startGroupTask(group.id, prompt);
      await settle(harness, task.id);
    }

    // Two shifts: upload -> kubernetes, kubernetes -> upload.
    await expect.poll(() => pipeline.calls.length).toBe(2);
    const segmentIds = pipeline.calls.map((call) => call.segmentId);
    expect(new Set(segmentIds).size).toBe(2);

    const closed = segmentsOf(harness, group.id).filter(
      (segment) => segment.status === "closed",
    );
    expect(closed).toHaveLength(2);
    expect(closed.every((segment) => segment.closeReason === "topic_shift")).toBe(true);
    expect(closed.every((segment) => segment.groupTaskIds.length === 2)).toBe(true);
    // Five sequential group tasks, each re-injecting the growing transcript.
  }, 30_000);

  it("captures the prior chat, and only the prior chat, the moment the subject changes", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group } = await runToCompletion(harness, UPLOAD);
    const second = await harness.service.startGroupTask(group.id, SAME_TOPIC);
    await settle(harness, second.id);

    const beforeShift = harness.store
      .snapshot()
      .groupMessages.filter((message) => message.groupId === group.id);
    expect(beforeShift.length).toBeGreaterThan(4);

    const third = await harness.service.startGroupTask(group.id, NEW_TOPIC);

    // The boundary is recorded in the SAME transaction as the off-topic prompt,
    // so it is already durable before the new task has run anything.
    const closed = segmentsOf(harness, group.id).find(
      (segment) => segment.status === "closed",
    )!;
    expect(closed.closeReason).toBe("topic_shift");
    // Everything up to (not including) the off-topic prompt.
    expect(closed.endSeq).toBe(Math.max(...beforeShift.map((m) => m.seq)));

    // What the consolidator actually receives.
    const buffer = new SegmentBufferBuilder(harness.store).build({
      segmentId: closed.id,
    });
    // Every human prompt in the segment survives verbatim, INDEPENDENT of the
    // transcript. This matters: the transcript trims oldest-first under budget
    // pressure, so the prompt that defined the topic would otherwise be the
    // first thing dropped. Carrying prompts in the envelope is what guarantees
    // the consolidator always knows what the topic was.
    expect(buffer.prompts).toEqual([UPLOAD, SAME_TOPIC]);
    expect(buffer.transcript.length).toBeGreaterThan(0);
    // The off-topic prompt belongs to the NEXT segment and must not leak in.
    expect(buffer.transcript.map((line) => line.content)).not.toContain(NEW_TOPIC);
    // Whatever survived trimming is inside the segment's range.
    expect(Math.max(...buffer.transcript.map((line) => line.seq))).toBeLessThanOrEqual(
      closed.endSeq!,
    );

    await settle(harness, third.id);

    // Agent turns from the new task carry higher seqs and stay out too, even
    // though consolidation runs concurrently with that task.
    const afterBuffer = new SegmentBufferBuilder(harness.store).build({
      segmentId: closed.id,
    });
    expect(afterBuffer.transcript).toEqual(buffer.transcript);
    expect(afterBuffer.groupTaskIds).not.toContain(third.id);
  });

  it("consolidates a quiet segment on the idle sweep, so the last topic is not lost", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group } = await runToCompletion(harness, UPLOAD);

    // Nothing has closed the segment: the user simply stopped working.
    expect(pipeline.calls).toHaveLength(0);

    // Age the transcript past the idle window.
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await harness.store.mutate((db) => {
      for (const message of db.groupMessages) message.createdAt = stale;
    });

    harness.service.sweepIdleSegments(group.id);

    await expect.poll(() => pipeline.calls.length).toBe(1);
    const closed = segmentsOf(harness, group.id)[0]!;
    expect(closed.status).toBe("closed");
    expect(closed.closeReason).toBe("idle");
  });

  it("leaves an active segment alone on the idle sweep", async () => {
    const pipeline = new RecordingMemoryPipeline();
    const harness = await makeHarness(new FakeRunner(), pipeline);
    const { group } = await runToCompletion(harness, UPLOAD);

    harness.service.sweepIdleSegments(group.id);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pipeline.calls).toHaveLength(0);
    expect(segmentsOf(harness, group.id)[0]!.status).toBe("open");
  });

  it("never fails a completed task when the pipeline throws", async () => {
    const exploding: MemoryPipeline = {
      async runMemoryPipeline() {
        throw new Error("consolidator unavailable");
      },
      async resetAutoNotes() {},
    };
    const harness = await makeHarness(new FakeRunner(), exploding);
    const { group } = await runToCompletion(harness, UPLOAD);
    // Two prompts, so the pooled segment clears MIN_EVIDENCE_TERMS and the
    // third can actually be judged a shift.
    const second = await harness.service.startGroupTask(group.id, SAME_TOPIC);
    await settle(harness, second.id);
    const third = await harness.service.startGroupTask(group.id, NEW_TOPIC);
    await settle(harness, third.id);

    expect(harness.service.getGroupTask(third.id).task.status).toBe("completed");
    // The failed extraction leaves the segment unflushed so it can be retried.
    await expect
      .poll(() =>
        segmentsOf(harness, group.id).some(
          (segment) => segment.status === "closed",
        ),
      )
      .toBe(true);
    const closed = segmentsOf(harness, group.id).find(
      (segment) => segment.status === "closed",
    )!;
    expect(closed.flushedAt).toBeNull();
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
    // Completed nodes were NOT re-run: 3 (first run) + 1 (resume) = 4.
    expect(runner.requests).toHaveLength(4);
    // The already-completed node kept its original runId.
    const firstCompletedBefore = completedBefore[0]!;
    const firstCompletedAfter = done.nodes.find(
      (node) => node.id === firstCompletedBefore.id,
    )!;
    expect(firstCompletedAfter.runId).toBe(firstCompletedBefore.runId);
    // The memory pipeline was asked to reset auto notes for the resumed task.
    expect(pipeline.resetCalls).toContain(task.id);
    // Consolidation is owned by the segment now, so the resumed task rejoins
    // its still-open segment instead of triggering a second per-task flush.
    expect(pipeline.calls).toHaveLength(0);
    const segment = harness.store
      .snapshot()
      .topicSegments.find((item) => item.groupTaskIds.includes(task.id))!;
    expect(segment.status).toBe("open");
    expect(segment.flushedAt).toBeNull();
  });

  it("re-runs branches that were BLOCKED, not just the node that failed", async () => {
    // The payoff of containment: blocked is not dead. Fail the root node, so
    // both branches are blocked rather than failed, then let the root succeed
    // and resume. Every previously-blocked node must actually run.
    let failBackend = true;
    let backendId = "";
    const runner = new FakeRunner({
      failFor: (request) =>
        failBackend && request.agentId === backendId ? "Codex exploded" : null,
    });
    const harness = await makeHarness(runner);
    backendId = harness.backend.id;

    const group = await harness.service.createGroup({
      name: "Upload Feature Team",
      members: harness.members,
    });
    const task = await harness.service.startGroupTask(group.id, "Plan it.");
    await settle(harness, task.id);

    const blocked = harness.service.getGroupTask(task.id);
    expect(blocked.task.status).toBe("failed");
    expect(blocked.nodes.map((node) => node.status)).toEqual([
      "failed",
      "cancelled",
      "cancelled",
    ]);
    // Only the root was ever attempted.
    expect(runner.requests).toHaveLength(1);

    failBackend = false;
    await harness.service.resumeGroupTask(task.id);
    await settle(harness, task.id);

    const resumed = harness.service.getGroupTask(task.id);
    expect(resumed.task.status).toBe("completed");
    expect(resumed.nodes.every((node) => node.status === "completed")).toBe(true);
    // The blocked reason is cleared, not left behind on a now-successful node.
    expect(resumed.nodes.every((node) => node.error === null)).toBe(true);
    // 1 failed attempt + 3 nodes on the resume.
    expect(runner.requests).toHaveLength(4);
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
