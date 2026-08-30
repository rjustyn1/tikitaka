/**
 * The task planner: it decides WHAT the plan is, instead of stamping a
 * constant.
 *
 * This replaces `V1_CHAIN` (A4's "hardcoded sequential chain, exactly three
 * roles"). The planner receives the task prompt plus every candidate Agent's
 * `description` and returns an ordered, validated graph: which Agents are
 * relevant, in what order, with a short instruction ("mini plan") for each.
 *
 * It deliberately mirrors the extractor boundary in `consolidator.ts` -- one
 * model call behind a tiny interface, a fake client for offline tests, a schema
 * on the output, and a validation ladder before anything is trusted -- with two
 * corrections learned from that boundary:
 *
 *  1. THE MODEL NEVER ECHOES A UUID. `DECISIONS.md` warned against asking a
 *     model to reproduce 36-character ids character-for-character, and the
 *     consolidator does it anyway: one transposed character silently drops a
 *     note. Here the model works in SMALL INTEGER INDICES -- agent `[1]`, node
 *     `[2]` -- and the server maps them back to real ids. A wrong index is an
 *     out-of-range error the validator catches, not a silent drop.
 *
 *  2. IT DOES NOT FAIL OPEN TO NOTHING. Zero memory notes is a fine outcome;
 *     zero plan nodes is a task that cannot run. Any failure -- transport,
 *     malformed JSON, schema, cycle, bad index -- falls back to a deterministic
 *     one-node-per-member sequential plan. Invalid planner output still never
 *     reaches execution; it is discarded whole, never partially repaired.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GroupPlanNode } from "../types.js";

// ---------------------------------------------------------------------------
// Limits (all enforced, none advisory)
// ---------------------------------------------------------------------------

/**
 * Hard cap on plan size, mirroring the consolidator's max-5-notes cap. A plan
 * longer than this is rejected outright rather than truncated: truncating a
 * graph can strand a node's dependency, and a half-plan is worse than a
 * predictable fallback.
 */
export const MAX_PLAN_NODES = 8;

/** Cap on the candidate roster shown to the planner, so the prompt stays bounded. */
export const MAX_PLANNER_AGENTS = 12;

export const MAX_INSTRUCTION_CHARS = 1200;
export const MAX_EXPECTED_OUTPUT_CHARS = 300;
export const MAX_NODE_ROLE_CHARS = 60;

/** Fallback when no timeout is configured, matching the extractor's default. */
const DEFAULT_PLAN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Ownership hints and runtime locks are SERVER-DERIVED, never model-authored
// ---------------------------------------------------------------------------

/**
 * The planner picks a named AREA from this fixed set; the server maps it to the
 * glob. The model never writes a path.
 *
 * This is the answer to "who assigns fileOwnershipHints/runtimeLocks -- the
 * planner, or a fixed rule layered on top of its output". It is a fixed rule:
 * a model that can emit an arbitrary glob can emit `**` or an absolute path,
 * and file placement is the whole security claim the architecture rests on. An
 * unrecognised area degrades to read-only with no hints and no locks, so the
 * failure direction is always "less access", never more.
 */
export const WORK_AREAS = {
  server: "code/apps/server/**",
  web: "code/apps/web/**",
  shared: "code/packages/**",
  docs: "code/docs/**",
  all: "code/**",
} as const;

export type WorkArea = keyof typeof WORK_AREAS;

const WORK_AREA_NAMES = Object.keys(WORK_AREAS) as WorkArea[];

/**
 * Ownership from (area, writes).
 *
 * Lock ROWS are written for write nodes so the UI can show which area a node
 * held. Lock COLLISION validation remains STRETCH -- it cannot fire while one
 * node runs at a time.
 */
export function deriveOwnership(
  area: string | undefined,
  writes: boolean | undefined,
): Pick<GroupPlanNode, "readOnly" | "fileOwnershipHints" | "runtimeLocks"> {
  const glob = area === undefined ? undefined : WORK_AREAS[area as WorkArea];
  if (!writes || !glob) {
    return { readOnly: true, fileOwnershipHints: [], runtimeLocks: [] };
  }
  return {
    readOnly: false,
    fileOwnershipHints: [glob],
    runtimeLocks: [glob],
  };
}

// ---------------------------------------------------------------------------
// The client seam
// ---------------------------------------------------------------------------

export interface PlannerRequest {
  system: string;
  prompt: string;
  timeoutMs: number;
}

export interface PlannerResponse {
  rawText: string;
}

/**
 * Structurally identical to `ExtractorClient`, and deliberately so: the same
 * `createExtractorClient(config)` instance can be passed straight in, without
 * this module depending on the extraction pipeline or duplicating an Ark
 * transport. Declared here rather than imported so the planner owns its own
 * boundary.
 */
export interface PlannerClient {
  extract(input: PlannerRequest): Promise<PlannerResponse>;
}

// ---------------------------------------------------------------------------
// Input / output contract (this is what Person 1 executes and Person 4 renders)
// ---------------------------------------------------------------------------

/** One candidate Agent, as the planner sees it. `description` is the signal. */
export interface PlannerAgent {
  id: string;
  name: string;
  description: string;
}

export interface PlanRequest {
  /** The user's task, verbatim. */
  prompt: string;
  /** Every member of the group. The planner may select a subset. */
  agents: readonly PlannerAgent[];
}

/**
 * One planned node, before it is given an id.
 *
 * `dependsOnIndexes` are positions in THIS array. `nodes` is returned in
 * topological order, so a sequential executor that walks the array front to
 * back is always correct -- which is what `GroupRunner.executeGroupTask()`
 * does today.
 */
export interface PlannedNode {
  agentId: string;
  nodeRole: string;
  instruction: string;
  expectedOutput: string;
  dependsOnIndexes: number[];
  readOnly: boolean;
  fileOwnershipHints: string[];
  runtimeLocks: string[];
}

export interface PlanResult {
  nodes: PlannedNode[];
  /**
   * Which path produced this plan. Not persisted -- it exists so callers can
   * log a degraded plan instead of mistaking it for a real one.
   */
  source: "model" | "fallback";
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a planner for a multi-agent software team. You are given a task and",
  "a numbered list of available agents with their descriptions. You decide who",
  "works on the task, in what order, and what each one is told to do.",
  "",
  "Return ONLY a JSON object, no markdown fences, of this exact shape:",
  "{",
  '  "nodes": [',
  "    {",
  '      "agent": <agent number from the list>,',
  '      "nodeRole": "<short kebab-case step name, e.g. api-contract>",',
  '      "instruction": "<what this agent must do on this step, <=1200 chars>",',
  '      "expectedOutput": "<what this step must produce, <=300 chars>",',
  '      "dependsOn": [<indexes of earlier nodes in THIS array, 0-based>],',
  '      "area": "server" | "web" | "shared" | "docs" | "all" | "none",',
  '      "writes": true | false',
  "    }",
  "  ]",
  "}",
  "",
  "Rules:",
  '- "agent" is a NUMBER from the agent list. Never write an agent id or name.',
  '- "dependsOn" holds 0-based positions in your own "nodes" array. Use [] for',
  "  a step with no prerequisite. The graph must be acyclic. Do not repeat an",
  "  index, and never depend on the node itself.",
  "- Pick agents by their description and the task. Skip agents that are not",
  "  relevant. An agent may take more than one step.",
  `- Return at most ${MAX_PLAN_NODES} nodes. Fewer is better than padding.`,
  '- "writes" is true only for a step that edits files. Planning, review and',
  '  analysis steps are false. "area" names where the edits land; use "none"',
  "  when the step writes nothing.",
  "- Every field is required on every node.",
].join("\n");

export function buildPlannerRequest(
  input: PlanRequest,
  timeoutMs: number = DEFAULT_PLAN_TIMEOUT_MS,
): PlannerRequest {
  const agentLines = input.agents
    .map(
      (agent, index) =>
        `${index + 1}. ${agent.name} — ${
          agent.description.trim() || "no description provided"
        }`,
    )
    .join("\n");

  const prompt = [
    "# Task",
    input.prompt,
    "",
    "## Available agents",
    agentLines,
  ].join("\n");

  return { system: SYSTEM_PROMPT, prompt, timeoutMs };
}

// ---------------------------------------------------------------------------
// Schema + validation ladder
// ---------------------------------------------------------------------------

/**
 * Shape only. Ranges, indices, cycles and duplicates are checked in
 * `validatePlan`, where a rejection can name what was wrong.
 *
 * Extra keys are tolerated (models add commentary fields); missing or
 * wrong-typed REQUIRED fields are not. Unlike the consolidator, nothing here is
 * defaulted into existence: a node without an instruction is exactly the bug
 * this whole item exists to fix.
 */
const plannerOutputSchema = z.object({
  nodes: z.array(
    z.object({
      agent: z.number(),
      nodeRole: z.string().optional(),
      instruction: z.string(),
      expectedOutput: z.string().optional(),
      dependsOn: z.array(z.number()).optional(),
      area: z.string().optional(),
      writes: z.boolean().optional(),
    }),
  ),
});

export function parsePlannerJson(
  rawText: string,
): z.infer<typeof plannerOutputSchema> | null {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const result = plannerOutputSchema.safeParse(JSON.parse(stripped));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Why a plan was rejected. Returned rather than thrown, so callers can log it. */
export type PlanRejection =
  | "empty"
  | "too-many-nodes"
  | "unknown-agent"
  | "missing-instruction"
  | "bad-dependency"
  | "duplicate-dependency"
  | "self-dependency"
  | "cycle";

export type PlanValidation =
  | { ok: true; nodes: PlannedNode[] }
  | { ok: false; reason: PlanRejection };

/**
 * The ladder. Every rung rejects the WHOLE plan -- there is no partial repair,
 * because a plan with one node quietly dropped is a plan whose dependencies no
 * longer mean what they say.
 */
export function validatePlan(
  raw: z.infer<typeof plannerOutputSchema>,
  agents: readonly PlannerAgent[],
): PlanValidation {
  const rawNodes = raw.nodes;
  if (rawNodes.length === 0) return { ok: false, reason: "empty" };
  if (rawNodes.length > MAX_PLAN_NODES) {
    return { ok: false, reason: "too-many-nodes" };
  }

  const prepared: PlannedNode[] = [];
  for (const [index, node] of rawNodes.entries()) {
    // Agent reference: a 1-based position in the roster we showed it.
    const agentPosition = node.agent - 1;
    const agent = agents[agentPosition];
    if (!Number.isInteger(node.agent) || !agent) {
      return { ok: false, reason: "unknown-agent" };
    }

    const instruction = node.instruction.trim();
    if (instruction.length === 0) {
      return { ok: false, reason: "missing-instruction" };
    }

    const dependsOn = node.dependsOn ?? [];
    const seen = new Set<number>();
    for (const dependency of dependsOn) {
      if (
        !Number.isInteger(dependency) ||
        dependency < 0 ||
        dependency >= rawNodes.length
      ) {
        return { ok: false, reason: "bad-dependency" };
      }
      if (dependency === index) return { ok: false, reason: "self-dependency" };
      if (seen.has(dependency)) {
        return { ok: false, reason: "duplicate-dependency" };
      }
      seen.add(dependency);
    }

    prepared.push({
      agentId: agent.id,
      nodeRole: normaliseNodeRole(node.nodeRole, agent.name, index),
      instruction: instruction.slice(0, MAX_INSTRUCTION_CHARS),
      expectedOutput:
        node.expectedOutput?.trim().slice(0, MAX_EXPECTED_OUTPUT_CHARS) ||
        "A written result for this step.",
      dependsOnIndexes: [...dependsOn],
      ...deriveOwnership(node.area, node.writes),
    });
  }

  const order = topologicalOrder(prepared);
  if (!order) return { ok: false, reason: "cycle" };

  return { ok: true, nodes: reindex(prepared, order) };
}

/**
 * Kahn's algorithm. Returns the visit order, or null if any node never becomes
 * ready -- which, on a graph with no dangling references (already checked
 * above), means a cycle.
 */
function topologicalOrder(nodes: readonly PlannedNode[]): number[] | null {
  const remaining = nodes.map((node) => new Set(node.dependsOnIndexes));
  const order: number[] = [];
  const placed = new Set<number>();

  while (order.length < nodes.length) {
    // Lowest index first, so the result is deterministic for a given input.
    const ready = remaining.findIndex(
      (dependencies, index) => !placed.has(index) && dependencies.size === 0,
    );
    if (ready === -1) return null;
    order.push(ready);
    placed.add(ready);
    for (const dependencies of remaining) dependencies.delete(ready);
    remaining[ready] = new Set([-1]); // never ready again
  }
  return order;
}

/** Rewrite the array into topological order, remapping dependency indexes. */
function reindex(
  nodes: readonly PlannedNode[],
  order: readonly number[],
): PlannedNode[] {
  const positionOf = new Map<number, number>();
  order.forEach((original, position) => positionOf.set(original, position));
  return order.map((original) => {
    const node = nodes[original]!;
    return {
      ...node,
      dependsOnIndexes: node.dependsOnIndexes
        .map((dependency) => positionOf.get(dependency)!)
        .sort((left, right) => left - right),
    };
  });
}

function normaliseNodeRole(
  raw: string | undefined,
  agentName: string,
  index: number,
): string {
  const slug = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NODE_ROLE_CHARS);
  if (slug) return slug;
  const fromName = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (fromName || "step") + "-" + (index + 1);
}

// ---------------------------------------------------------------------------
// The deterministic fallback
// ---------------------------------------------------------------------------

/**
 * One node per member, in membership order, sequential.
 *
 * Used when the model is unavailable or its output is rejected, and by
 * `buildChainNodes()` for callers that have not moved to the async planner yet.
 * The instruction is generic on purpose -- it says what this Agent is for and
 * what the task is, and claims nothing the planner would have decided.
 */
export function fallbackPlan(input: PlanRequest): PlannedNode[] {
  const agents = input.agents.slice(0, MAX_PLAN_NODES);
  return agents.map((agent, index) => ({
    agentId: agent.id,
    nodeRole: normaliseNodeRole(undefined, agent.name, index),
    instruction: [
      "Work the task from your own role: " +
        (agent.description.trim() || agent.name) +
        ".",
      "Task: " + input.prompt.trim(),
      index === 0
        ? "You are first. Establish what the following steps need from you."
        : "Build on the completed steps above and do not redo their work.",
    ].join("\n"),
    expectedOutput: "This step's contribution to the task.",
    dependsOnIndexes: index === 0 ? [] : [index - 1],
    ...deriveOwnership("all", true),
  }));
}

// ---------------------------------------------------------------------------
// Materialisation: PlannedNode[] -> persisted GroupPlanNode[]
// ---------------------------------------------------------------------------

/**
 * Give every node an id and resolve indexes to ids.
 *
 * `allowedPlanNodeIds` is the TRANSITIVE ancestor set, not just direct
 * dependencies: a node may read every output it (indirectly) depends on, which
 * is what the degenerate chain gave for free and a real DAG has to compute.
 * `contextSnapshotSeq` stays 0 and is stamped when the node becomes runnable.
 */
export function buildPlanNodes(
  groupTaskId: string,
  planned: readonly PlannedNode[],
  createdAt: string,
): GroupPlanNode[] {
  const ids = planned.map(() => randomUUID());
  const ancestorsOf: Array<Set<number>> = [];

  return planned.map((node, index) => {
    const ancestors = new Set<number>();
    for (const dependency of node.dependsOnIndexes) {
      ancestors.add(dependency);
      // Safe because the array is in topological order: every dependency was
      // visited before this node, so its ancestor set is already built.
      for (const inherited of ancestorsOf[dependency] ?? []) {
        ancestors.add(inherited);
      }
    }
    ancestorsOf[index] = ancestors;

    return {
      id: ids[index]!,
      groupTaskId,
      agentId: node.agentId,
      // A node with more than one dependency is where branches reconverge --
      // which is exactly what `GROUP-CHAT-DESIGN.md` means by a join: "the group
      // returns to one shared state". Nothing branches on `kind` yet; recording
      // it truthfully is what lets an incremental flush trigger find a safe
      // consolidation boundary later (ARCHITECTURE.md section 9's watermark).
      kind: node.dependsOnIndexes.length > 1 ? "join" : "work",
      nodeRole: node.nodeRole,
      dependsOn: node.dependsOnIndexes.map((dependency) => ids[dependency]!),
      contextSnapshotSeq: 0,
      allowedPlanNodeIds: [...ancestors]
        .sort((left, right) => left - right)
        .map((ancestor) => ids[ancestor]!),
      status: "queued",
      runId: null,
      output: null,
      error: null,
      readOnly: node.readOnly,
      fileOwnershipHints: [...node.fileOwnershipHints],
      runtimeLocks: [...node.runtimeLocks],
      instruction: node.instruction,
      expectedOutput: node.expectedOutput,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
  });
}

// ---------------------------------------------------------------------------
// The planner itself
// ---------------------------------------------------------------------------

export class TaskPlanner {
  constructor(
    private readonly client: PlannerClient,
    private readonly timeoutMs: number = DEFAULT_PLAN_TIMEOUT_MS,
    /** Injected so a rejected plan is visible in the log, not just silently degraded. */
    private readonly onReject: (reason: PlanRejection | "transport" | "parse") => void = () => {},
  ) {}

  async plan(input: PlanRequest): Promise<PlanResult> {
    const agents = input.agents.slice(0, MAX_PLANNER_AGENTS);
    if (agents.length === 0) return { nodes: [], source: "fallback" };

    const request: PlanRequest = { prompt: input.prompt, agents };

    let rawText: string;
    try {
      const response = await this.client.extract(
        buildPlannerRequest(request, this.timeoutMs),
      );
      rawText = response.rawText;
    } catch {
      this.onReject("transport");
      return { nodes: fallbackPlan(request), source: "fallback" };
    }

    const parsed = parsePlannerJson(rawText);
    if (!parsed) {
      this.onReject("parse");
      return { nodes: fallbackPlan(request), source: "fallback" };
    }

    const validated = validatePlan(parsed, agents);
    if (!validated.ok) {
      this.onReject(validated.reason);
      return { nodes: fallbackPlan(request), source: "fallback" };
    }

    return { nodes: validated.nodes, source: "model" };
  }
}

/**
 * Deterministic offline planner for tests and the demo.
 *
 * TEST/DEMO ONLY. It reads the roster out of the prompt and emits a valid
 * index-based plan -- a planning step, then a write step per remaining agent,
 * fanning out from the first. It is topic-blind: it does not read the task, so
 * its instructions describe the shape of the plan, never the actual work. Do
 * not mistake its output for a real plan.
 */
export class FakePlannerClient implements PlannerClient {
  async extract(input: PlannerRequest): Promise<PlannerResponse> {
    const count = countRosterLines(input.prompt);
    if (count === 0) return { rawText: JSON.stringify({ nodes: [] }) };

    const nodes = [
      {
        agent: 1,
        nodeRole: "plan",
        instruction:
          "Break the task down and state what each following step needs.",
        expectedOutput: "A step-by-step plan.",
        dependsOn: [] as number[],
        area: "none",
        writes: false,
      },
    ];

    for (let position = 2; position <= Math.min(count, MAX_PLAN_NODES); position += 1) {
      nodes.push({
        agent: position,
        nodeRole: "implement-" + position,
        instruction: "Carry out your part of the plan from the first step.",
        expectedOutput: "This step's implementation.",
        dependsOn: [0],
        area: "all",
        writes: true,
      });
    }

    return { rawText: JSON.stringify({ nodes }) };
  }
}

/** Count the "N. Name — description" roster lines the planner prompt embeds. */
function countRosterLines(prompt: string): number {
  const start = prompt.indexOf("## Available agents");
  if (start === -1) return 0;
  return prompt
    .slice(start)
    .split("\n")
    .filter((line) => /^\d+\.\s/.test(line)).length;
}
