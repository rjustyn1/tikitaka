// Landing: the single enforcement point. A memory reaches an Agent IF AND ONLY
// IF landing writes a file into that Agent's private workspace. Severe notes go
// to AGENTS.md (always loaded); normal notes go to a per-Agent skill (loaded
// when relevant). Governed memory is NEVER written into shared code.
// See components/LANDING.md.

import { randomUUID } from "node:crypto";
import type { Agent, LandedMemoryFile, MemoryNote } from "../types.js";
import type { JsonStore } from "../store.js";
import { WorkspaceMemoryWriter } from "./workspace-memory.js";

const now = () => new Date().toISOString();

export interface LandMemoryResult {
  noteId: string;
  grantedAgentIds: string[];
  fileWrites: LandedMemoryFile[];
}

function kindForSeverity(note: MemoryNote): LandedMemoryFile["kind"] {
  return note.severity === "severe" ? "agents_md" : "skill";
}

export class LandingService {
  constructor(
    private readonly store: JsonStore,
    private readonly writer: WorkspaceMemoryWriter = new WorkspaceMemoryWriter(),
  ) {}

  async landMemory(note: MemoryNote): Promise<LandMemoryResult> {
    const db = this.store.snapshot();
    const agents = db.agents.filter((agent) =>
      note.targetAgentIds.includes(agent.id),
    );
    const kind = kindForSeverity(note);

    const fileWrites: LandedMemoryFile[] = [];
    for (const agent of agents) {
      const path =
        note.severity === "severe"
          ? await this.writer.appendAgentsMemory(agent, note)
          : await this.writer.writeSkill(agent, note);
      fileWrites.push({
        id: randomUUID(),
        noteId: note.id,
        agentId: agent.id,
        kind,
        path,
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
        await this.writer.removeSkill(agent, note);
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
        (file) => file.agentId === agentId && file.removedAt === null,
      );
  }
}
