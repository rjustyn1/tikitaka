import { describe, expect, it } from "vitest";
import {
  FakePlannerClient,
  MAX_PLAN_NODES,
  TaskPlanner,
  buildPlanNodes,
  buildPlannerRequest,
  deriveOwnership,
  fallbackPlan,
  parsePlannerJson,
  validatePlan,
  type PlanRejection,
  type PlannerAgent,
  type PlannerClient,
  type PlannerRequest,
  type PlannerResponse,
} from "./planner.js";

const AGENTS: PlannerAgent[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Backend",
    description: "Owns the HTTP API and storage.",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Frontend",
    description: "Owns the React app.",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Security",
    description: "Reviews auth and secret boundaries.",
  },
];

/** A planner client that returns whatever text the test hands it. */
function clientReturning(rawText: string): PlannerClient {
  return {
    async extract(_input: PlannerRequest): Promise<PlannerResponse> {
      return { rawText };
    },
  };
}

function plannerJson(nodes: unknown[]): string {
  return JSON.stringify({ nodes });
}

/** A minimal well-formed node, overridable per test. */
function rawNode(overrides: Record<string, unknown> = {}) {
  return {
    agent: 1,
    nodeRole: "api-contract",
    instruction: "Define the endpoint contract.",
    expectedOutput: "A contract.",
    dependsOn: [],
    area: "server",
    writes: true,
    ...overrides,
  };
}

/** Run the ladder and report which rung rejected, or "ok". */
function rejectionFor(nodes: unknown[]): PlanRejection | "parse" | "ok" {
  const parsed = parsePlannerJson(plannerJson(nodes));
  if (!parsed) return "parse";
  const result = validatePlan(parsed, AGENTS);
  return result.ok ? "ok" : result.reason;
}

describe("the planner prompt", () => {
  it("numbers the roster and never shows the model an id", () => {
    const request = buildPlannerRequest({ prompt: "Add uploads.", agents: AGENTS });
    expect(request.prompt).toContain("1. Backend — Owns the HTTP API and storage.");
    expect(request.prompt).toContain("3. Security — Reviews auth");
    // The UUID-echo failure mode DECISIONS.md warned about cannot occur if the
    // model is never shown a UUID to echo.
    for (const agent of AGENTS) {
      expect(request.prompt).not.toContain(agent.id);
    }
  });

  it("includes the group's standing description as context above the task", () => {
    const request = buildPlannerRequest({
      prompt: "Add a 10MB size limit.",
      groupDescription: "We maintain the file upload service.",
      agents: AGENTS,
    });
    expect(request.prompt).toContain("# Team context");
    expect(request.prompt).toContain("We maintain the file upload service.");
    // Additive, not a replacement: the task is still there, and it reads
    // AFTER the standing context.
    expect(request.prompt).toContain("Add a 10MB size limit.");
    expect(request.prompt.indexOf("# Team context")).toBeLessThan(
      request.prompt.indexOf("# Task"),
    );
  });

  it("omits the context heading entirely when the group has no description", () => {
    for (const groupDescription of [undefined, "", "   "]) {
      const request = buildPlannerRequest({
        prompt: "Add uploads.",
        groupDescription,
        agents: AGENTS,
      });
      expect(request.prompt).not.toContain("# Team context");
      expect(request.prompt.startsWith("# Task")).toBe(true);
    }
  });

  it("carries the task prompt verbatim", () => {
    const request = buildPlannerRequest({
      prompt: "Add a 10MB upload limit.",
      agents: AGENTS,
    });
    expect(request.prompt).toContain("Add a 10MB upload limit.");
  });
});

describe("the validation ladder", () => {
  it("accepts a well-formed plan", () => {
    expect(rejectionFor([rawNode(), rawNode({ agent: 2, dependsOn: [0] })])).toBe(
      "ok",
    );
  });

  it("rejects an empty plan", () => {
    expect(rejectionFor([])).toBe("empty");
  });

  it("rejects a plan over the node cap", () => {
    const nodes = Array.from({ length: MAX_PLAN_NODES + 1 }, () => rawNode());
    expect(rejectionFor(nodes)).toBe("too-many-nodes");
  });

  it("rejects an agent index outside the roster, in either direction", () => {
    expect(rejectionFor([rawNode({ agent: 0 })])).toBe("unknown-agent");
    expect(rejectionFor([rawNode({ agent: 4 })])).toBe("unknown-agent");
    expect(rejectionFor([rawNode({ agent: 1.5 })])).toBe("unknown-agent");
  });

  it("rejects a node with no instruction", () => {
    expect(rejectionFor([rawNode({ instruction: "   " })])).toBe(
      "missing-instruction",
    );
  });

  it("rejects a dependency that names no node", () => {
    expect(rejectionFor([rawNode({ dependsOn: [7] })])).toBe("bad-dependency");
    expect(rejectionFor([rawNode({ dependsOn: [-1] })])).toBe("bad-dependency");
  });

  it("rejects a self-dependency", () => {
    expect(rejectionFor([rawNode({ dependsOn: [0] })])).toBe("self-dependency");
  });

  it("rejects a repeated dependency", () => {
    expect(
      rejectionFor([rawNode(), rawNode({ agent: 2, dependsOn: [0, 0] })]),
    ).toBe("duplicate-dependency");
  });

  it("rejects a cycle", () => {
    expect(
      rejectionFor([
        rawNode({ dependsOn: [1] }),
        rawNode({ agent: 2, dependsOn: [0] }),
      ]),
    ).toBe("cycle");
  });

  it("rejects a longer cycle that no pairwise check would catch", () => {
    expect(
      rejectionFor([
        rawNode({ dependsOn: [2] }),
        rawNode({ agent: 2, dependsOn: [0] }),
        rawNode({ agent: 3, dependsOn: [1] }),
      ]),
    ).toBe("cycle");
  });

  it("rejects the whole plan, never a repaired part of it", () => {
    const parsed = parsePlannerJson(
      plannerJson([rawNode(), rawNode({ agent: 99 })]),
    )!;
    const result = validatePlan(parsed, AGENTS);
    expect(result.ok).toBe(false);
    // The first node was valid; it does not survive on its own.
    expect(result).not.toHaveProperty("nodes");
  });

  it("returns nodes in topological order, with dependencies remapped", () => {
    // Declared last-first: node 0 depends on node 1.
    const parsed = parsePlannerJson(
      plannerJson([
        rawNode({ nodeRole: "second", dependsOn: [1] }),
        rawNode({ agent: 2, nodeRole: "first", dependsOn: [] }),
      ]),
    )!;
    const result = validatePlan(parsed, AGENTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((node) => node.nodeRole)).toEqual([
      "first",
      "second",
    ]);
    // Remapped: "second" is now at index 1 and depends on index 0.
    expect(result.nodes[1]!.dependsOnIndexes).toEqual([0]);
    expect(result.nodes[0]!.dependsOnIndexes).toEqual([]);
  });

  it("maps the agent index back to the real id", () => {
    const parsed = parsePlannerJson(plannerJson([rawNode({ agent: 3 })]))!;
    const result = validatePlan(parsed, AGENTS);
    expect(result.ok && result.nodes[0]!.agentId).toBe(AGENTS[2]!.id);
  });

  it("derives a node role when the model omits one", () => {
    const parsed = parsePlannerJson(
      plannerJson([{ agent: 2, instruction: "Do the thing." }]),
    )!;
    const result = validatePlan(parsed, AGENTS);
    expect(result.ok && result.nodes[0]!.nodeRole).toBe("frontend-1");
  });
});

describe("ownership hints and runtime locks", () => {
  it("maps a named area to its glob only when the node writes", () => {
    expect(deriveOwnership("server", true)).toEqual({
      readOnly: false,
      fileOwnershipHints: ["code/apps/server/**"],
      runtimeLocks: ["code/apps/server/**"],
    });
  });

  it("makes a non-writing node read-only whatever area it claims", () => {
    expect(deriveOwnership("server", false)).toEqual({
      readOnly: true,
      fileOwnershipHints: [],
      runtimeLocks: [],
    });
  });

  it("degrades an unknown area to read-only rather than trusting it", () => {
    // The failure direction is always LESS access. A model that invents a path
    // gets nothing, not that path.
    for (const area of ["../../etc", "**", "none", undefined]) {
      expect(deriveOwnership(area, true)).toEqual({
        readOnly: true,
        fileOwnershipHints: [],
        runtimeLocks: [],
      });
    }
  });

  it("never lets a model-authored glob through", () => {
    const parsed = parsePlannerJson(
      plannerJson([rawNode({ area: "/etc/**", writes: true })]),
    )!;
    const result = validatePlan(parsed, AGENTS);
    expect(result.ok && result.nodes[0]!.fileOwnershipHints).toEqual([]);
    expect(result.ok && result.nodes[0]!.readOnly).toBe(true);
  });
});

describe("materialising a plan into persisted nodes", () => {
  it("gives every node an id, an instruction, and resolved dependencies", () => {
    const parsed = parsePlannerJson(
      plannerJson([rawNode(), rawNode({ agent: 2, dependsOn: [0] })]),
    )!;
    const validated = validatePlan(parsed, AGENTS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const nodes = buildPlanNodes("task-1", validated.nodes, "2026-01-01T00:00:00.000Z");
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.groupTaskId).toBe("task-1");
    expect(nodes[0]!.instruction).toBe("Define the endpoint contract.");
    expect(nodes[1]!.dependsOn).toEqual([nodes[0]!.id]);
    expect(nodes[0]!.dependsOn).toEqual([]);
    expect(nodes.every((node) => node.status === "queued")).toBe(true);
    expect(nodes.every((node) => node.contextSnapshotSeq === 0)).toBe(true);
  });

  it("accumulates TRANSITIVE ancestors, not just direct dependencies", () => {
    // 0 -> 1 -> 2. Node 2 may read node 0's output even though it does not
    // depend on it directly; a chain gave this for free, a DAG must compute it.
    const parsed = parsePlannerJson(
      plannerJson([
        rawNode(),
        rawNode({ agent: 2, dependsOn: [0] }),
        rawNode({ agent: 3, dependsOn: [1] }),
      ]),
    )!;
    const validated = validatePlan(parsed, AGENTS);
    if (!validated.ok) throw new Error("expected a valid plan");

    const nodes = buildPlanNodes("t", validated.nodes, "2026-01-01T00:00:00.000Z");
    expect(nodes[0]!.allowedPlanNodeIds).toEqual([]);
    expect(nodes[1]!.allowedPlanNodeIds).toEqual([nodes[0]!.id]);
    expect(nodes[2]!.allowedPlanNodeIds).toEqual([nodes[0]!.id, nodes[1]!.id]);
  });

  it("keeps a join node's ancestors from BOTH branches", () => {
    // 0 -> 1, 0 -> 2, then 3 joins 1 and 2.
    const parsed = parsePlannerJson(
      plannerJson([
        rawNode(),
        rawNode({ agent: 2, dependsOn: [0] }),
        rawNode({ agent: 3, dependsOn: [0] }),
        rawNode({ agent: 1, dependsOn: [1, 2] }),
      ]),
    )!;
    const validated = validatePlan(parsed, AGENTS);
    if (!validated.ok) throw new Error("expected a valid plan");

    const nodes = buildPlanNodes("t", validated.nodes, "2026-01-01T00:00:00.000Z");
    expect(nodes[3]!.allowedPlanNodeIds).toHaveLength(3);
    expect(new Set(nodes[3]!.allowedPlanNodeIds)).toEqual(
      new Set([nodes[0]!.id, nodes[1]!.id, nodes[2]!.id]),
    );
  });

  it("is safe to execute front to back, because the array is topologically ordered", () => {
    const parsed = parsePlannerJson(
      plannerJson([
        rawNode({ nodeRole: "last", dependsOn: [1] }),
        rawNode({ agent: 2, nodeRole: "middle", dependsOn: [2] }),
        rawNode({ agent: 3, nodeRole: "first", dependsOn: [] }),
      ]),
    )!;
    const validated = validatePlan(parsed, AGENTS);
    if (!validated.ok) throw new Error("expected a valid plan");

    const nodes = buildPlanNodes("t", validated.nodes, "2026-01-01T00:00:00.000Z");
    const seen = new Set<string>();
    for (const node of nodes) {
      // Every dependency was already visited by a plain forward loop.
      for (const dependency of node.dependsOn) expect(seen.has(dependency)).toBe(true);
      seen.add(node.id);
    }
  });
});

describe("different prompts produce different plans", () => {
  it("plans from the model's answer, not from a constant", async () => {
    const backendOnly = new TaskPlanner(
      clientReturning(
        plannerJson([
          rawNode({ agent: 1, nodeRole: "harden-api", instruction: "Harden the API." }),
        ]),
      ),
    );
    const wholeTeam = new TaskPlanner(
      clientReturning(
        plannerJson([
          rawNode({ agent: 3, nodeRole: "threat-model", writes: false, area: "none" }),
          rawNode({ agent: 1, nodeRole: "fix-backend", dependsOn: [0] }),
          rawNode({ agent: 2, nodeRole: "fix-web", area: "web", dependsOn: [0] }),
        ]),
      ),
    );

    const small = await backendOnly.plan({ prompt: "Rate-limit /uploads.", agents: AGENTS });
    const large = await wholeTeam.plan({ prompt: "Audit and fix auth.", agents: AGENTS });

    expect(small.source).toBe("model");
    expect(large.source).toBe("model");
    expect(small.nodes).toHaveLength(1);
    expect(large.nodes).toHaveLength(3);
    expect(small.nodes[0]!.nodeRole).toBe("harden-api");
    expect(large.nodes.map((node) => node.nodeRole)).toEqual([
      "threat-model",
      "fix-backend",
      "fix-web",
    ]);
    // The security node planned nothing it may write.
    expect(large.nodes[0]!.readOnly).toBe(true);
  });

  it("selects a subset of the group rather than using every member", async () => {
    const planner = new TaskPlanner(
      clientReturning(plannerJson([rawNode({ agent: 2, area: "web" })])),
    );
    const result = await planner.plan({ prompt: "Tweak a button.", agents: AGENTS });
    expect(result.nodes.map((node) => node.agentId)).toEqual([AGENTS[1]!.id]);
  });
});

describe("failure behaviour", () => {
  const rejected: Array<string> = [];
  const planner = (rawText: string) =>
    new TaskPlanner(clientReturning(rawText), 1000, (reason) =>
      rejected.push(reason),
    );

  it("falls back to a deterministic plan on unparseable output", async () => {
    rejected.length = 0;
    const result = await planner("not json at all").plan({
      prompt: "Ship it.",
      agents: AGENTS,
    });
    expect(result.source).toBe("fallback");
    expect(rejected).toEqual(["parse"]);
    // A task with zero nodes cannot run, so the fallback is a real plan.
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.every((node) => node.instruction.length > 0)).toBe(true);
  });

  it("falls back, and names the rung, on a cyclic plan", async () => {
    rejected.length = 0;
    const result = await planner(
      plannerJson([
        rawNode({ dependsOn: [1] }),
        rawNode({ agent: 2, dependsOn: [0] }),
      ]),
    ).plan({ prompt: "Ship it.", agents: AGENTS });
    expect(result.source).toBe("fallback");
    expect(rejected).toEqual(["cycle"]);
    // The cyclic graph never reaches execution: the fallback is acyclic.
    expect(result.nodes[0]!.dependsOnIndexes).toEqual([]);
    expect(result.nodes[1]!.dependsOnIndexes).toEqual([0]);
  });

  it("falls back when the model call throws", async () => {
    rejected.length = 0;
    const throwing: PlannerClient = {
      async extract(_input: PlannerRequest): Promise<PlannerResponse> {
        throw new Error("network down");
      },
    };
    const result = await new TaskPlanner(throwing, 1000, (reason) =>
      rejected.push(reason),
    ).plan({ prompt: "Ship it.", agents: AGENTS });
    expect(result.source).toBe("fallback");
    expect(rejected).toEqual(["transport"]);
    expect(result.nodes).toHaveLength(3);
  });

  it("plans nothing for a group with no members", async () => {
    const result = await planner(plannerJson([rawNode()])).plan({
      prompt: "Ship it.",
      agents: [],
    });
    expect(result.nodes).toEqual([]);
  });

  it("caps the fallback at the node cap for an oversized group", () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      id: "agent-" + index,
      name: "Agent " + index,
      description: "",
    }));
    expect(fallbackPlan({ prompt: "x", agents: many })).toHaveLength(MAX_PLAN_NODES);
  });
});

describe("the offline planner client", () => {
  it("produces a valid plan with no network and no Ark key", async () => {
    const result = await new TaskPlanner(new FakePlannerClient()).plan({
      prompt: "Add uploads.",
      agents: AGENTS,
    });
    expect(result.source).toBe("model");
    expect(result.nodes).toHaveLength(3);
    // A planning step, then a write step per remaining agent, fanning out.
    expect(result.nodes[0]!.readOnly).toBe(true);
    expect(result.nodes[1]!.dependsOnIndexes).toEqual([0]);
    expect(result.nodes[2]!.dependsOnIndexes).toEqual([0]);
  });

  it("is deterministic for the same roster", async () => {
    const planner = new TaskPlanner(new FakePlannerClient());
    const first = await planner.plan({ prompt: "a", agents: AGENTS });
    const second = await planner.plan({ prompt: "b", agents: AGENTS });
    expect(first.nodes).toEqual(second.nodes);
  });
});

describe("join nodes", () => {
  it("marks a fan-in node as a join, and a single-dependency node as work", () => {
    // The watermark in ARCHITECTURE.md section 9 needs a boundary to fire on,
    // and a join is it: the point where every branch has reported in.
    const parsed = parsePlannerJson(
      plannerJson([
        rawNode(),
        rawNode({ agent: 2, dependsOn: [0] }),
        rawNode({ agent: 3, dependsOn: [0] }),
        rawNode({ agent: 1, dependsOn: [1, 2] }),
      ]),
    )!;
    const validated = validatePlan(parsed, AGENTS);
    if (!validated.ok) throw new Error("expected a valid plan");

    const nodes = buildPlanNodes("t", validated.nodes, "2026-01-01T00:00:00.000Z");
    expect(nodes.map((node) => node.kind)).toEqual([
      "work",
      "work",
      "work",
      "join",
    ]);
  });

  it("leaves a purely sequential plan with no join nodes", () => {
    const nodes = buildPlanNodes(
      "t",
      fallbackPlan({ prompt: "x", agents: AGENTS }),
      "2026-01-01T00:00:00.000Z",
    );
    expect(nodes.every((node) => node.kind === "work")).toBe(true);
  });
});
