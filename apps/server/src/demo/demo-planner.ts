/**
 * An offline planner that produces a DAG worth looking at.
 *
 * `FakePlannerClient` fans every step off the first one and stops — a shape
 * with no rejoin, so the plan graph has nothing to show. This builds the shape
 * the product actually claims: one planning step, parallel implementation,
 * a join that waits on all of them, then a review pass.
 *
 * Selected by DEMO_MODE=1. Roles are worded to match the mock runner's work
 * table, so each step writes files that fit what it says it did.
 */
import type { PlannerClient, PlannerRequest, PlannerResponse } from "../memory/planner.js";

/** Count the "N. Name — description" roster lines the planner prompt embeds. */
function countRosterLines(prompt: string): number {
  const start = prompt.indexOf("## Available agents");
  if (start === -1) return 0;
  return prompt
    .slice(start)
    .split("\n")
    .filter((line) => /^\d+\.\s/.test(line)).length;
}

interface PlanNode {
  agent: number;
  nodeRole: string;
  instruction: string;
  expectedOutput: string;
  dependsOn: number[];
  area: string;
  writes: boolean;
}

/** Work steps, in the order they are handed out to the roster. */
/**
 * The parallel steps, one per working Agent. There are deliberately three:
 * a branch is only honest if a distinct Agent can actually take it, and the
 * roster has three Agents that do development work. A fourth branch would
 * have to be handed to `ops`, which does not do this kind of work, or to an
 * Agent already busy on another branch -- and the lease would serialise it
 * anyway, so the graph would claim a parallelism the run cannot deliver.
 */
const STEPS = [
  {
    nodeRole: "api",
    instruction:
      "Implement register, login with session tokens, and the to-do endpoints " +
      "scoped to the signed-in user.",
    expectedOutput: "The auth module, the to-do store, and the ownership rule.",
    area: "backend",
  },
  {
    nodeRole: "ui",
    instruction:
      "Build the login form and the list view in plain HTML and JS.",
    expectedOutput: "The page and its script.",
    area: "frontend",
  },
  {
    nodeRole: "security-review",
    instruction:
      "Review authentication, input validation and secret handling.",
    expectedOutput: "Findings, and the rules that follow from them.",
    area: "security",
  },
];

/** Never branch wider than the number of Agents that can take a branch. */
const MAX_PARALLEL = STEPS.length;

export class DemoPlannerClient implements PlannerClient {
  async extract(input: PlannerRequest): Promise<PlannerResponse> {
    const roster = countRosterLines(input.prompt);
    if (roster === 0) return { rawText: JSON.stringify({ nodes: [] }) };

    // Node 0 plans. Everything else is indexed from there.
    const nodes: PlanNode[] = [
      {
        agent: 1,
        nodeRole: "plan",
        instruction:
          "Break the task down and state what each following step needs.",
        expectedOutput: "A step-by-step plan the others can work from.",
        dependsOn: [],
        area: "none",
        writes: true,
      },
    ];

    // One branch per working Agent, never more. `roster` can be larger (the
    // team also carries ops), so the cap is the step list, not the roster.
    const parallelCount = Math.max(2, Math.min(MAX_PARALLEL, roster));
    const parallelIndexes: number[] = [];
    for (let i = 0; i < parallelCount; i += 1) {
      const step = STEPS[i]!;
      nodes.push({
        agent: i + 1,
        nodeRole: step.nodeRole,
        instruction: step.instruction,
        expectedOutput: step.expectedOutput,
        dependsOn: [0],
        area: step.area,
        writes: true,
      });
      parallelIndexes.push(nodes.length - 1);
    }

    // The join: it must wait on EVERY branch, which is what makes the graph a
    // DAG rather than a fan of independent chains.
    nodes.push({
      agent: 1,
      nodeRole: "integration-check",
      instruction:
        "Check the parts fit together: the UI, the endpoints and the session model.",
      expectedOutput: "Anything that disagrees between the parts.",
      dependsOn: [...parallelIndexes],
      area: "all",
      writes: true,
    });
    const joinIndex = nodes.length - 1;

    // Two steps after the join, not one. The first is where consolidation
    // fires, so the second is still running while memory is being written --
    // which is the whole point of showing the two side by side.
    nodes.push({
      agent: 1,
      nodeRole: "hardening",
      instruction:
        "Apply the guards the review asked for, then stop.",
      expectedOutput: "The guards added, and why.",
      dependsOn: [joinIndex],
      area: "backend",
      writes: true,
    });
    const hardeningIndex = nodes.length - 1;

    nodes.push({
      agent: 1,
      nodeRole: "final-review",
      instruction: "Summarise what shipped and what the team should remember.",
      expectedOutput: "The durable rules worth keeping.",
      dependsOn: [hardeningIndex],
      area: "none",
      writes: true,
    });

    return { rawText: JSON.stringify({ nodes }) };
  }
}
