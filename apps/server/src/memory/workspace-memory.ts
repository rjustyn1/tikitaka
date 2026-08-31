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
import { isValidSkillKey } from "./skill-catalog.js";

// Re-exported so existing importers of this module are unaffected by the swap.
export { removeManagedBlock, replaceManagedBlock };

const GOVERNED_HEADING = "## Governed Memories";
const PRIVATE_SKILLS_DIR = ".agents/skills";

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

  private skillDir(agent: Agent, skillKey: string): string {
    return path.join(agent.workspacePath, PRIVATE_SKILLS_DIR, skillKey);
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

  /** Normal note -> upsert one managed block in a private Agent skill. */
  async writeSkill(
    agent: Agent,
    note: MemoryNote,
    skillKey: string = note.skillKey ?? noteSlug(note),
  ): Promise<string> {
    if (!isValidSkillKey(skillKey)) {
      throw new Error(`Invalid skill key: ${skillKey}`);
    }
    const dir = this.skillDir(agent, skillKey);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "SKILL.md");
    let existing = "";
    try {
      existing = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = [
        "---",
        `name: ${skillKey}`,
        `description: ${note.description}`,
        "---",
        "",
      ].join("\n");
    }
    const body = [
      note.content,
      "",
      `Source task: ${note.groupTaskId}`,
    ].join("\n");
    await writeFile(
      filePath,
      replaceManagedBlock(existing, `memory:${note.id}`, body),
      "utf8",
    );
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

  /** Revoke a normal note while preserving unrelated memories in the skill. */
  async removeSkill(
    agent: Agent,
    note: MemoryNote,
    skillKey: string = note.skillKey ?? noteSlug(note),
  ): Promise<void> {
    const dir = this.skillDir(agent, skillKey);
    const filePath = path.join(dir, "SKILL.md");
    let existing = "";
    try {
      existing = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const next = removeManagedBlock(existing, `memory:${note.id}`);
    if (!next.includes("<!-- memory:")) {
      await rm(dir, { recursive: true, force: true });
      return;
    }
    await writeFile(filePath, next, "utf8");
  }
}
