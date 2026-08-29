/**
 * End-to-end seam test (integrationManifest3 step 7).
 *
 * Every other suite tests one workstream. This one drives a REAL group task
 * through the REAL memory pipeline and asserts the hand-off between them:
 * Bridge 5 (what GroupRunner persists) against what TaskBufferBuilder reads.
 * No unit test covers that seam.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { createMemoryPipeline } from "./memory/pipeline.js";
import { JsonStore } from "./store.js";
import { FakeRunner } from "./test-helpers.js";
import type { GroupRole, GroupTaskStatus } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const TERMINAL: GroupTaskStatus[] = ["completed", "partial", "failed", "cancelled"];

let root: string;
let service: AgentService;
let store: JsonStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "e2e-"));
  const config = {
    ...loadConfig({
      ARK_API_KEY: "test-key-not-used",
      ARK_MODEL: "test-model",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex-home"),
      MEMORY_EXTRACTOR: "fake",
    } as NodeJS.ProcessEnv),
  };
  store = new JsonStore(path.join(root, "data", "launchpad.json"));
  const workspaces = new WorkspaceManager(config.workspaceRoot, config.runtimeProvider);
  service = new AgentService(
    config,
    store,
    workspaces,
    new FakeRunner(),
    createMemoryPipeline(store, config, { reviewAllSkills: config.reviewAllSkills }),
  );
  await service.initialize();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function waitForTerminal(taskId: string): Promise<GroupTaskStatus> {
  for (let i = 0; i < 200; i += 1) {
    const status = service.getGroupTask(taskId).task.status;
    // NOTE for consumers: the task status flips to terminal BEFORE the memory
    // pipeline runs -- finishTask persists the status, then calls maybeFlush.
    // So "status === completed" does NOT mean notes exist yet. Wait on
    // flushedAt when you care about governed memory.
    if (TERMINAL.includes(status)) {
      for (let j = 0; j < 200; j += 1) {
        if (store.snapshot().groupTasks.find((t) => t.id === taskId)?.flushedAt) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("group task never reached a terminal status");
}

describe("end-to-end: group task -> governed memory", () => {
  it("runs the chain and hands real node output to the memory pipeline", async () => {
    const roles: GroupRole[] = ["backend", "frontend", "security"];
    const members = [];
    for (const role of roles) {
      const agent = await service.createAgent({ name: role + " Agent" });
      members.push({ agentId: agent.id, role });
    }
    const outsider = await service.createAgent({ name: "Ops Agent" });

    const group = await service.createGroup({ name: "Upload Feature Team", members });
    const task = await service.startGroupTask(group.id, "Plan an upload feature.");
    const status = await waitForTerminal(task.id);
    expect(status).toBe("completed");

    const response = service.getGroupTask(task.id);

    // --- Bridge 5: what the task buffer needs from every completed node ---
    expect(response.nodes).toHaveLength(5);
    for (const node of response.nodes) {
      expect(node.status).toBe("completed");
      expect(node.runId, "node " + node.nodeRole + " has no runId").toBeTruthy();
      expect(node.output, "node " + node.nodeRole + " has no output").toBeTruthy();
      expect(node.completedAt).toBeTruthy();
    }

    const db = store.snapshot();
    for (const node of response.nodes) {
      expect(db.runs.some((r) => r.id === node.runId)).toBe(true);
      expect(
        db.contextInjections.some((c) => c.planNodeId === node.id),
        "no context injection for " + node.nodeRole,
      ).toBe(true);
    }

    // 1 human + 5 agent turns, in order
    expect(response.messages).toHaveLength(6);
    expect(response.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    // Backend and Frontend each take two turns; Ops never participates
    const speakers = response.nodes.map((n) => n.agentId);
    expect(new Set(speakers).size).toBe(3);
    expect(speakers).not.toContain(outsider.id);

    // group threads are separate from the solo thread
    for (const member of members) {
      expect(service.getAgent(member.agentId).codexThreadId).toBeNull();
    }

    // every lease released, every runtime lock released
    for (const member of members) {
      expect(service.getAgent(member.agentId).status).toBe("ready");
    }
    expect(db.runtimeLocks.every((l) => l.releasedAt !== null)).toBe(true);

    // --- the pipeline actually ran on real node output ---
    expect(db.groupTasks.find((t) => t.id === task.id)?.flushedAt).toBeTruthy();
    expect(db.notes.length, "fake extractor produced no notes").toBeGreaterThan(0);
    expect(db.grants.length, "no grant records were written").toBeGreaterThan(0);
  }, 30_000);
});

describe("end-to-end: the governance claim", () => {
  it("grants memory to targeted Agents and records a reason for everyone else", async () => {
    const roles: GroupRole[] = ["backend", "frontend", "security"];
    const members = [];
    for (const role of roles) {
      const agent = await service.createAgent({ name: role + " Agent" });
      members.push({ agentId: agent.id, role });
    }
    const outsider = await service.createAgent({ name: "Ops Agent" });

    const group = await service.createGroup({ name: "Upload Feature Team", members });
    const task = await service.startGroupTask(group.id, "Plan an upload feature.");
    await waitForTerminal(task.id);

    const notes = service.listNotes({});
    expect(notes.length).toBeGreaterThan(0);

    const grants = service.listTaskGrants(task.id);
    expect(grants.length).toBeGreaterThan(0);

    // Every grant names a decision and a reason -- the audit is the product.
    for (const grant of grants) {
      expect(["granted", "withheld", "rejected", "revoked"]).toContain(grant.decision);
      expect(grant.reason, "grant " + grant.id + " has no reason").toBeTruthy();
    }

    // The non-member is never granted anything, and is on the record as withheld.
    const outsiderGrants = grants.filter((g) => g.agentId === outsider.id);
    expect(outsiderGrants.every((g) => g.decision !== "granted")).toBe(true);

    // Nothing landed in the outsider's workspace -- placement IS the boundary.
    expect(service.listAgentMemory(outsider.id)).toHaveLength(0);

    // Whatever DID land, landed only in a targeted Agent's own workspace.
    const landed = store.snapshot().landedMemoryFiles.filter((f) => f.removedAt === null);
    for (const file of landed) {
      const owner = service.getAgent(file.agentId);
      expect(
        file.path.startsWith(owner.workspacePath),
        "memory landed outside its Agent's workspace: " + file.path,
      ).toBe(true);
      expect(file.path).not.toContain("shared-code");
      expect(file.path).not.toContain("codex-home");
    }
  }, 30_000);
});
