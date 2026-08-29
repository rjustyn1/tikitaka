import { access, mkdir, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent, GroupPlanNode } from "../types.js";
import { LandingService } from "./landing.js";
import { LedgerService } from "./ledger.js";
import { ReviewService } from "./review.js";
import type { CandidateMemoryNote, SafetyResult } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-review-test-"));
  temporaryDirectories.push(root);
  const target = agentAt(TARGET, path.join(root, "t"));
  const other = agentAt(OTHER, path.join(root, "o"));
  for (const agent of [target, other]) {
    await mkdir(agent.workspacePath, { recursive: true });
  }
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((db) => {
    db.agents.push(target, other);
    db.groupTasks.push({
      id: "task-1",
      groupId: "group-1",
      prompt: "p",
      sharedCodePath: "/ws/shared/task-1",
      status: "completed",
      currentNodeId: null,
      nodeRunIds: [],
      flushedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:05:00.000Z",
    });
    db.groupPlanNodes.push(planNode("n1", TARGET), planNode("n2", OTHER));
  });

  const ledger = new LedgerService(store);
  const landing = new LandingService(store);
  const review = new ReviewService(store, landing, ledger);
  return { store, ledger, landing, review, target, other };
}

function agentAt(id: string, workspacePath: string): Agent {
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status: "ready",
    workspacePath,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function planNode(id: string, agentId: string): GroupPlanNode {
  return {
    id,
    groupTaskId: "task-1",
    agentId,
    kind: "work",
    nodeRole: "backend",
    dependsOn: [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "completed",
    runId: "run-" + id,
    output: "out",
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    expectedOutput: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
  };
}

function candidate(
  overrides: Partial<CandidateMemoryNote> = {},
): CandidateMemoryNote {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    groupTaskId: "task-1",
    content: "The upload endpoint caps at 10MB.",
    severity: "normal",
    targetAgentIds: [TARGET],
    description: "Upload cap",
    sourceRunIds: ["run-n1"],
    sourceSpanIds: ["span-1"],
    rationale: "",
    ...overrides,
  };
}

function safety(overrides: Partial<SafetyResult> = {}): SafetyResult {
  const note = overrides.note ?? candidate();
  return {
    note,
    redactionFired: false,
    quarantineHit: false,
    reasons: [],
    ...overrides,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

describe("ReviewService", () => {
  it("auto-activates a clean, narrow normal note and lands + grants it", async () => {
    const { review, store, ledger, target } = await setup();
    const note = await review.processCandidate(candidate(), safety());

    expect(note.status).toBe("active");
    expect(await exists(path.join(target.workspacePath, ".agents", "skills"))).toBe(
      true,
    );
    const grants = ledger.listNoteGrants(note.id);
    expect(grants.some((g) => g.decision === "granted" && g.agentId === TARGET)).toBe(
      true,
    );
    // The other task participant is recorded as withheld.
    expect(
      grants.some((g) => g.decision === "withheld" && g.agentId === OTHER),
    ).toBe(true);
    expect(store.snapshot().notes[0]!.status).toBe("active");
  });

  it("parks a severe note as pending without landing anything", async () => {
    const { review, target } = await setup();
    const note = await review.processCandidate(
      candidate({ severity: "severe" }),
      safety({ note: candidate({ severity: "severe" }) }),
    );
    expect(note.status).toBe("pending");
    expect(await exists(path.join(target.workspacePath, "AGENTS.md"))).toBe(false);
  });

  it("parks a redaction-fired note as pending", async () => {
    const { review } = await setup();
    const note = await review.processCandidate(
      candidate(),
      safety({ redactionFired: true, reasons: ["redaction:bearer_token"] }),
    );
    expect(note.status).toBe("pending");
  });

  it("quarantines a note that hit the injection heuristic", async () => {
    const { review } = await setup();
    const note = await review.processCandidate(
      candidate(),
      safety({ quarantineHit: true, reasons: ["quarantine:override_instructions"] }),
    );
    expect(note.status).toBe("quarantined");
  });

  it("approve lands a pending severe note", async () => {
    const { review, ledger, target } = await setup();
    const pending = await review.processCandidate(
      candidate({ severity: "severe" }),
      safety({ note: candidate({ severity: "severe" }) }),
    );
    const active = await review.approve(pending.id, { reviewerName: "Lionel" });

    expect(active.status).toBe("active");
    expect(await exists(path.join(target.workspacePath, "AGENTS.md"))).toBe(true);
    expect(
      ledger.listNoteGrants(active.id).some((g) => g.reviewerName === "Lionel"),
    ).toBe(true);
  });

  it("listNotes filters by status and target Agent", async () => {
    const { review } = await setup();
    await review.processCandidate(candidate(), safety()); // active, targets TARGET
    await review.processCandidate(
      candidate({ id: "22222222-2222-4222-8222-222222222222", severity: "severe" }),
      safety({ note: candidate({ severity: "severe" }) }),
    ); // pending

    expect(review.listNotes()).toHaveLength(2);
    expect(review.listNotes({ status: "active" })).toHaveLength(1);
    expect(review.listNotes({ status: "pending" })).toHaveLength(1);
    expect(review.listNotes({ agentId: TARGET })).toHaveLength(2);
    expect(review.listNotes({ agentId: OTHER })).toHaveLength(0);
  });

  it("revoke deletes files and records a revoked ledger entry", async () => {
    const { review, ledger, landing, target } = await setup();
    const active = await review.processCandidate(candidate(), safety());
    expect(landing.listAgentMemory(TARGET)).toHaveLength(1);

    const revoked = await review.revoke(active.id, {
      reviewerName: "Lionel",
      reason: "no longer applies",
    });

    expect(revoked.status).toBe("revoked");
    expect(await exists(path.join(target.workspacePath, ".agents", "skills"))).toBe(
      true,
    ); // dir may remain
    expect(landing.listAgentMemory(TARGET)).toHaveLength(0);
    expect(
      ledger.listNoteGrants(active.id).some((g) => g.decision === "revoked"),
    ).toBe(true);
  });
});
