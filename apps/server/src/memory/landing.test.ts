import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import type { Agent, MemoryNote } from "../types.js";
import { LandingService } from "./landing.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function setup(): Promise<{
  store: JsonStore;
  landing: LandingService;
  target: Agent;
  other: Agent;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-landing-test-"));
  temporaryDirectories.push(root);

  const target = agentAt("agent-target", path.join(root, "target"));
  const other = agentAt("agent-other", path.join(root, "other"));
  for (const agent of [target, other]) {
    await mkdir(agent.workspacePath, { recursive: true });
    await writeFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      "# Platform-managed Agent instructions\n\nExisting content.\n",
      "utf8",
    );
  }

  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((db) => {
    db.agents.push(target, other);
  });

  return { store, landing: new LandingService(store), target, other, root };
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

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    groupTaskId: "task-1",
    groupId: "group-1",
    content: "The upload endpoint caps files at 10MB.",
    severity: "severe",
    status: "active",
    targetAgentIds: ["agent-target"],
    description: "Upload size limit",
    sourceRunIds: ["run-1"],
    sourceSpanIds: ["span-1"],
    rationale: "",
    redactionFired: false,
    quarantineHit: false,
    safetyReasons: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("LandingService", () => {
  it("lands a severe note only in the target Agent's AGENTS.md", async () => {
    const { landing, target, other } = await setup();
    const result = await landing.landMemory(note());

    const targetMd = await readFile(
      path.join(target.workspacePath, "AGENTS.md"),
      "utf8",
    );
    const otherMd = await readFile(
      path.join(other.workspacePath, "AGENTS.md"),
      "utf8",
    );

    expect(targetMd).toContain("caps files at 10MB");
    expect(targetMd).toContain("<!-- memory:11111111-1111-4111-8111-111111111111 -->");
    expect(targetMd).toContain("Existing content."); // did not clobber
    expect(otherMd).not.toContain("caps files at 10MB");
    expect(result.grantedAgentIds).toEqual(["agent-target"]);
  });

  it("lands a normal note only in the target Agent's skills dir, never the other", async () => {
    const { landing, target, other } = await setup();
    await landing.landMemory(note({ severity: "normal" }));

    const targetSkills = path.join(target.workspacePath, ".agents", "skills");
    const otherSkills = path.join(other.workspacePath, ".agents", "skills");
    expect(await exists(targetSkills)).toBe(true);
    expect(await exists(otherSkills)).toBe(false);
  });

  it("is idempotent: landing the same severe note twice keeps one active file and one block", async () => {
    const { store, landing, target } = await setup();
    await landing.landMemory(note());
    await landing.landMemory(note());

    const md = await readFile(
      path.join(target.workspacePath, "AGENTS.md"),
      "utf8",
    );
    const blockCount = md.split(
      "<!-- memory:11111111-1111-4111-8111-111111111111 -->",
    ).length - 1;
    expect(blockCount).toBe(1);

    const active = store
      .snapshot()
      .landedMemoryFiles.filter((f) => f.removedAt === null);
    expect(active).toHaveLength(1);
  });

  it("revoke removes the file but the landed-file row is retained with removedAt", async () => {
    const { store, landing, target } = await setup();
    await landing.landMemory(note({ severity: "normal" }));
    const skillDir = store.snapshot().landedMemoryFiles[0]!.path;
    expect(await exists(skillDir)).toBe(true);

    await landing.revokeMemory(note({ severity: "normal" }));

    expect(await exists(skillDir)).toBe(false);
    const rows = store.snapshot().landedMemoryFiles;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.removedAt).not.toBeNull();
    expect(landing.listAgentMemory("agent-target")).toHaveLength(0);
  });

  it("does not expose an active landing row after its governed file is deleted", async () => {
    const { store, landing } = await setup();
    await landing.landMemory(note({ severity: "normal" }));
    const filePath = store.snapshot().landedMemoryFiles[0]!.path;

    await rm(filePath, { force: true });

    // The database row remains as audit history, but it no longer represents
    // available memory.
    expect(store.snapshot().landedMemoryFiles[0]?.removedAt).toBeNull();
    expect(landing.listAgentMemory("agent-target")).toEqual([]);
  });

  it("merges notes into one skill and revokes only the matching managed block", async () => {
    const { landing, store, target } = await setup();
    const first = note({
      id: "11111111-1111-4111-8111-111111111111",
      severity: "normal",
      skillKey: "upload-contract",
      content: "Reject uploads over 10MB.",
    });
    const second = note({
      id: "22222222-2222-4222-8222-222222222222",
      severity: "normal",
      skillKey: "upload-contract",
      content: "Return HTTP 413 for an oversized upload.",
    });

    await landing.landMemory(first);
    await landing.landMemory(second);

    const skillPath = store.snapshot().landedMemoryFiles[0]!.path;
    let source = await readFile(skillPath, "utf8");
    expect(source).toContain("memory:11111111-1111-4111-8111-111111111111");
    expect(source).toContain("memory:22222222-2222-4222-8222-222222222222");

    await landing.revokeMemory(first);
    source = await readFile(skillPath, "utf8");
    expect(source).not.toContain("memory:11111111-1111-4111-8111-111111111111");
    expect(source).toContain("memory:22222222-2222-4222-8222-222222222222");

    await landing.revokeMemory(second);
    expect(await exists(path.join(target.workspacePath, ".agents", "skills", "upload-contract"))).toBe(false);
  });
});
