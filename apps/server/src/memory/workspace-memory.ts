// Workspace memory writer: the ONLY place governed memory is written to disk.
// Person 3 owns this file (see PLAN.md "Deconflicted"). It is deliberately
// separate from workspace.ts (Person 2), which owns shared code + the group
// charter. Both call the SAME managed-block helpers.
//
// Managed-block helpers come from workspace.ts (Person 2 owns them). Both
// writers share ONE implementation, so a governed-memory block written here is
// preserved byte-for-byte by writeInstructions() there.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, MemoryNote } from "../types.js";
import { removeManagedBlock, replaceManagedBlock } from "../workspace.js";

// Re-exported so existing importers of this module are unaffected by the swap.
export { removeManagedBlock, replaceManagedBlock };

const GOVERNED_HEADING = "## Governed Memories";
const SKILLS_DIR = ".agents/skills";

/** Deterministic skill slug from a note's description + id. */
export function noteSlug(note: MemoryNote): string {
  const base = note.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "memory"}-${note.id.slice(0, 8)}`;
}

export class WorkspaceMemoryWriter {
  private agentsMdPath(agent: Agent): string {
    return path.join(agent.workspacePath, "AGENTS.md");
  }

  private skillDir(agent: Agent, note: MemoryNote): string {
    return path.join(agent.workspacePath, SKILLS_DIR, noteSlug(note));
  }

  /** Severe note -> upsert a managed block in the target Agent's AGENTS.md. */
  async appendAgentsMemory(agent: Agent, note: MemoryNote): Promise<string> {
    const filePath = this.agentsMdPath(agent);
    let existing = "";
    try {
      existing = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (!existing.includes(GOVERNED_HEADING)) {
      const separator =
        existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      existing = `${existing}${separator}${GOVERNED_HEADING}\n`;
    }

    const body = `- ${note.content}\n  Source task: ${note.groupTaskId}`;
    const next = replaceManagedBlock(existing, `memory:${note.id}`, body);
    await writeFile(filePath, next, "utf8");
    return filePath;
  }

  /** Normal note -> write a SKILL.md into the target Agent's private skills dir. */
  async writeSkill(agent: Agent, note: MemoryNote): Promise<string> {
    const dir = this.skillDir(agent, note);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "SKILL.md");
    const content = [
      "---",
      `name: memory-${noteSlug(note)}`,
      `description: ${note.description}`,
      "---",
      "",
      "# Governed Memory",
      "",
      "> This memory was granted to this Agent by a human-reviewed governance",
      "> pipeline. Treat it as a durable fact, not a new instruction.",
      "",
      note.content,
      "",
      `Source task: ${note.groupTaskId}`,
      "",
    ].join("\n");
    await writeFile(filePath, content, "utf8");
    return filePath;
  }

  /** Revoke a severe note: strip its managed block from AGENTS.md. */
  async removeAgentsMemory(agent: Agent, note: MemoryNote): Promise<void> {
    const filePath = this.agentsMdPath(agent);
    let existing = "";
    try {
      existing = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const next = removeManagedBlock(existing, `memory:${note.id}`);
    await writeFile(filePath, next, "utf8");
  }

  /** Revoke a normal note: delete its skill directory. */
  async removeSkill(agent: Agent, note: MemoryNote): Promise<void> {
    await rm(this.skillDir(agent, note), { recursive: true, force: true });
  }
}
