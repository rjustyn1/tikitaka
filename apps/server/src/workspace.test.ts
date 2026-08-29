import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "./types.js";
import {
  removeManagedBlock,
  replaceManagedBlock,
  WorkspaceManager,
} from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("managed blocks", () => {
  it("replaces and removes managed blocks by marker id", () => {
    const withBlock = replaceManagedBlock("Header\n", "memory:note-1", "- first");
    expect(withBlock).toContain("<!-- memory:note-1 -->\n- first\n<!-- /memory:note-1 -->");

    const replaced = replaceManagedBlock(withBlock, "memory:note-1", "- second");
    expect(replaced).not.toContain("- first");
    expect(replaced).toContain("- second");

    const removed = removeManagedBlock(replaced, "memory:note-1");
    expect(removed).not.toContain("memory:note-1");
  });

  it("preserves memory blocks when Agent instructions are regenerated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-workspace-test-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(root);
    await manager.initialize();
    const agent = agentFixture(root);
    await manager.create(agent);

    const agentsPath = path.join(agent.workspacePath, "AGENTS.md");
    const withMemory = replaceManagedBlock(
      await readFile(agentsPath, "utf8"),
      "memory:note-1",
      "- Keep upload validation strict.\n  Source task: task-1",
    );
    await writeFile(agentsPath, withMemory, "utf8");

    await manager.writeInstructions({
      ...agent,
      instructions: "Updated user instructions.",
    });

    const regenerated = await readFile(agentsPath, "utf8");
    expect(regenerated).toContain("Updated user instructions.");
    expect(regenerated).toContain("<!-- memory:note-1 -->");
    expect(regenerated).toContain("Keep upload validation strict.");
  });
});

function agentFixture(root: string): Agent {
  return {
    id: "agent-1",
    name: "Builder",
    description: "",
    instructions: "Initial instructions.",
    status: "ready",
    workspacePath: path.join(root, "agent-1"),
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
