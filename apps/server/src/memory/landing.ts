// Landing: the single enforcement point. A memory reaches an Agent IF AND ONLY
// IF landing writes a file into that Agent's private workspace. Severe notes go
// to AGENTS.md (always loaded); normal notes go to a per-Agent skill (loaded
// when relevant). Governed memory is NEVER written into shared code.
// See components/LANDING.md.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import type { Agent, LandedMemoryFile, MemoryNote } from "../types.js";
import type { JsonStore } from "../store.js";
import { memoryMarkerId } from "../workspace.js";
import {
  composeAgentsMemory,
  composeSkill,
  noteSlug,
} from "./workspace-memory.js";
import { WorkspaceMemoryWriter } from "./workspace-memory.js";

const now = () => new Date().toISOString();

/**
 * What approving a note would do to one Agent's file. `before` is empty and
 * `mode` is "create" when the file does not exist yet, which is the common
 * case for a skill; an `AGENTS.md` edit is always a modify.
 */
export interface MemoryFilePreview {
  agentId: string;
  path: string;
  kind: LandedMemoryFile["kind"];
  mode: "create" | "modify";
  before: string;
  after: string;
}

export interface LandMemoryResult {
  noteId: string;
  grantedAgentIds: string[];
  fileWrites: LandedMemoryFile[];
}

function kindForSeverity(note: MemoryNote): LandedMemoryFile["kind"] {
  return note.severity === "severe" ? "agents_md" : "skill";
}

/**
 * A ledger row is evidence that landing once succeeded; it is not current
 * availability. The exact managed block must still be present in its recorded
 * file before a note can be exposed again.
 */
export function isLandedMemoryFileAvailable(file: LandedMemoryFile): boolean {
  if (file.removedAt !== null || !existsSync(file.path)) return false;
  const marker = memoryMarkerId(file.noteId);
  try {
    const content = readFileSync(file.path, "utf8");
    return (
      content.includes("<!-- " + marker + " -->") &&
      content.includes("<!-- /" + marker + " -->")
    );
  } catch {
    return false;
  }
}

/** True only when this Agent still has the note's recorded governed block. */
export function isNoteAvailableToAgent(
  files: readonly LandedMemoryFile[],
  noteId: string,
  agentId: string,
): boolean {
  return files.some(
    (file) =>
      file.noteId === noteId &&
      file.agentId === agentId &&
      isLandedMemoryFileAvailable(file),
  );
}

export class LandingService {
  constructor(
    private readonly store: JsonStore,
    private readonly writer: WorkspaceMemoryWriter = new WorkspaceMemoryWriter(),
  ) {}

  /**
   * The exact file change approving this note would make, per recipient,
   * computed with the same composition the writer uses so the diff a human
   * approves cannot drift from what lands.
   */
  previewMemory(note: MemoryNote): MemoryFilePreview[] {
    const db = this.store.snapshot();
    const agents = db.agents.filter((agent) =>
      note.targetAgentIds.includes(agent.id),
    );
    const kind = kindForSeverity(note);

    return agents.map((agent) => {
      const skillKey =
        note.skillAssignments?.find(
          (assignment) => assignment.agentId === agent.id,
        )?.skillKey ??
        note.skillKey ??
        noteSlug(note);
      const filePath =
        kind === "agents_md"
          ? nodePath.join(agent.workspacePath, "AGENTS.md")
          : nodePath.join(
              agent.workspacePath,
              ".agents",
              "skills",
              skillKey,
              "SKILL.md",
            );

      let before: string | null = null;
      try {
        before = readFileSync(filePath, "utf8");
      } catch {
        before = null;
      }

      const after =
        kind === "agents_md"
          ? composeAgentsMemory(before ?? "", note)
          : composeSkill(before, note, skillKey);

      return {
        agentId: agent.id,
        path: filePath,
        kind,
        mode: before === null ? "create" : "modify",
        // A brand-new skill has no "before"; showing the scaffold as if it were
        // pre-existing would misreport a create as a modify.
        before: before ?? "",
        after,
      };
    });
  }

  async landMemory(note: MemoryNote): Promise<LandMemoryResult> {
    const db = this.store.snapshot();
    const agents = db.agents.filter((agent) =>
      note.targetAgentIds.includes(agent.id),
    );
    const kind = kindForSeverity(note);

    const fileWrites: LandedMemoryFile[] = [];
    for (const agent of agents) {
      const skillKey = note.skillAssignments?.find(
        (assignment) => assignment.agentId === agent.id,
      )?.skillKey ?? note.skillKey;
      const path =
        note.severity === "severe"
          ? await this.writer.appendAgentsMemory(agent, note)
          : await this.writer.writeSkill(agent, note, skillKey);
      fileWrites.push({
        id: randomUUID(),
        noteId: note.id,
        agentId: agent.id,
        kind,
        path,
        ...(kind === "skill" && skillKey ? { skillKey } : {}),
        createdAt: now(),
        removedAt: null,
      });
    }

    await this.store.mutate((database) => {
      for (const write of fileWrites) {
        const alreadyActive = database.landedMemoryFiles.some(
          (existing) =>
            existing.noteId === write.noteId &&
            existing.agentId === write.agentId &&
            existing.kind === write.kind &&
            existing.removedAt === null,
        );
        if (!alreadyActive) database.landedMemoryFiles.push(write);
      }
    });

    return {
      noteId: note.id,
      grantedAgentIds: agents.map((agent) => agent.id),
      fileWrites,
    };
  }

  async revokeMemory(note: MemoryNote): Promise<void> {
    const db = this.store.snapshot();
    const active = db.landedMemoryFiles.filter(
      (file) => file.noteId === note.id && file.removedAt === null,
    );
    const agentsById = new Map(db.agents.map((agent) => [agent.id, agent]));

    for (const file of active) {
      const agent = agentsById.get(file.agentId);
      if (!agent) continue;
        if (file.kind === "agents_md") {
          await this.writer.removeAgentsMemory(agent, note);
        } else {
          await this.writer.removeSkill(agent, note, file.skillKey);
        }
    }

    const revokedAt = now();
    await this.store.mutate((database) => {
      for (const stored of database.landedMemoryFiles) {
        if (stored.noteId === note.id && stored.removedAt === null) {
          stored.removedAt = revokedAt;
        }
      }
    });
  }

  listAgentMemory(agentId: string): LandedMemoryFile[] {
    return this.store
      .snapshot()
      .landedMemoryFiles.filter(
        (file) => file.agentId === agentId && isLandedMemoryFileAvailable(file),
      );
  }
}
