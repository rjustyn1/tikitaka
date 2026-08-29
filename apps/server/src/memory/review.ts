// Review: decides whether a candidate note auto-activates or needs a human,
// then applies approve / edit / reject / revoke. Landing writes the files;
// review never touches the filesystem directly. See components/REVIEW.md.
//
// The filesystem is the state machine: a note is enforcing IFF landing wrote a
// file. status just mirrors that for the UI.

import type {
  Agent,
  ListNotesQuery,
  MemoryNote,
  MemorySeverity,
  ReviewNoteInput,
  RevokeNoteInput,
} from "../types.js";
import type { JsonStore } from "../store.js";
import { HttpError } from "../errors.js";
import type { LandingService } from "./landing.js";
import type { LedgerService } from "./ledger.js";
import type { CandidateMemoryNote, SafetyResult } from "./types.js";

const now = () => new Date().toISOString();

export interface ApproveNoteInput {
  reviewerName: string;
}
export interface EditNoteInput {
  reviewerName: string;
  content?: string | undefined;
  severity?: MemorySeverity | undefined;
  targetAgentIds?: string[] | undefined;
  description?: string | undefined;
  approveAfterEdit?: boolean | undefined;
}
export interface RejectNoteInput {
  reviewerName: string;
  reason: string;
}

/** A candidate needs a human if it is severe, touched safety, or routes broadly. */
export function requiresHumanReview(
  candidate: CandidateMemoryNote,
  safety: SafetyResult,
  reviewAllSkills = false,
): boolean {
  return (
    reviewAllSkills ||
    candidate.severity === "severe" ||
    safety.redactionFired ||
    safety.quarantineHit ||
    candidate.targetAgentIds.length > 2
  );
}

export class ReviewService {
  constructor(
    private readonly store: JsonStore,
    private readonly landing: LandingService,
    private readonly ledger: LedgerService,
    private readonly reviewAllSkills = false,
  ) {}

  /**
   * Promote a candidate into a persisted MemoryNote. Clean + narrow normal notes
   * auto-activate (land + grants). Everything else is parked pending/quarantined
   * for a human.
   */
  async processCandidate(
    candidate: CandidateMemoryNote,
    safety: SafetyResult,
  ): Promise<MemoryNote> {
    const db = this.store.snapshot();
    const groupId =
      db.groupTasks.find((task) => task.id === candidate.groupTaskId)?.groupId ??
      "";

    const parked: MemoryNote["status"] = safety.quarantineHit
      ? "quarantined"
      : requiresHumanReview(candidate, safety, this.reviewAllSkills)
        ? "pending"
        : "active";

    const note: MemoryNote = {
      id: candidate.id,
      groupTaskId: candidate.groupTaskId,
      groupId,
      content: safety.note.content,
      severity: candidate.severity,
      // Start non-active; activate() flips it only after files are on disk.
      status: parked === "active" ? "candidate" : parked,
      targetAgentIds: candidate.targetAgentIds,
      description: safety.note.description,
      sourceRunIds: candidate.sourceRunIds,
      sourceSpanIds: candidate.sourceSpanIds,
      rationale: candidate.rationale,
      redactionFired: safety.redactionFired,
      quarantineHit: safety.quarantineHit,
      safetyReasons: safety.reasons,
      createdAt: now(),
      updatedAt: now(),
    };

    await this.store.mutate((database) => {
      database.notes.push(note);
    });

    if (parked === "active") {
      return this.activate(note, null);
    }
    return note;
  }

  async approve(noteId: string, input: ApproveNoteInput): Promise<MemoryNote> {
    const note = this.mustGetNote(noteId);
    if (note.status !== "pending" && note.status !== "quarantined") {
      throw new HttpError(409, `Note ${noteId} is not awaiting review`);
    }
    return this.activate(note, input.reviewerName);
  }

  async edit(noteId: string, input: EditNoteInput): Promise<MemoryNote> {
    let note = this.mustGetNote(noteId);
    note = await this.patchNote(noteId, {
      content: input.content ?? note.content,
      severity: input.severity ?? note.severity,
      targetAgentIds: input.targetAgentIds ?? note.targetAgentIds,
      description: input.description ?? note.description,
    });
    if (input.approveAfterEdit) {
      return this.activate(note, input.reviewerName);
    }
    return note;
  }

  async reject(noteId: string, input: RejectNoteInput): Promise<MemoryNote> {
    const note = this.mustGetNote(noteId);
    await this.ledger.recordRejected({
      groupTaskId: note.groupTaskId,
      noteId: note.id,
      candidateAgentIds: note.targetAgentIds,
      reviewerName: input.reviewerName,
      reason: input.reason,
    });
    return this.patchNote(noteId, { status: "rejected" });
  }

  async revoke(noteId: string, input: RevokeNoteInput): Promise<MemoryNote> {
    const note = this.mustGetNote(noteId);
    await this.landing.revokeMemory(note);
    await this.ledger.recordRevoked({
      groupTaskId: note.groupTaskId,
      noteId: note.id,
      grantedAgentIds: note.targetAgentIds,
      reviewerName: input.reviewerName,
      reason: input.reason,
    });
    return this.patchNote(noteId, { status: "revoked" });
  }

  /** Read model for GET /api/notes. Filters by status and/or target Agent. */
  listNotes(query: ListNotesQuery = {}): MemoryNote[] {
    return this.store.snapshot().notes.filter((note) => {
      if (query.status && note.status !== query.status) return false;
      if (query.agentId && !note.targetAgentIds.includes(query.agentId)) {
        return false;
      }
      return true;
    });
  }

  /** Dispatch for the single /review route body. */
  async applyReview(
    noteId: string,
    input: ReviewNoteInput,
  ): Promise<MemoryNote> {
    switch (input.type) {
      case "approve":
        return this.approve(noteId, { reviewerName: input.reviewerName });
      case "edit":
        return this.edit(noteId, input);
      case "reject":
        return this.reject(noteId, input);
    }
  }

  // --- internals -----------------------------------------------------------

  private async activate(
    note: MemoryNote,
    reviewerName: string | null,
  ): Promise<MemoryNote> {
    let landed;
    try {
      landed = await this.landing.landMemory(note);
    } catch (error) {
      // Review succeeded but landing failed: keep it pending, audit the failure,
      // never mark active. Placement must never fail open.
      for (const agentId of note.targetAgentIds) {
        await this.ledger.recordWithheld({
          groupTaskId: note.groupTaskId,
          noteId: note.id,
          agentId,
          reason: "landing_failed",
          reviewerName,
        });
      }
      return this.patchNote(note.id, {
        status: "pending",
        safetyReasons: [
          ...note.safetyReasons,
          `landing_error:${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }

    const pathByAgent = new Map(
      landed.fileWrites.map((write) => [write.agentId, write.path]),
    );
    for (const agentId of landed.grantedAgentIds) {
      await this.ledger.recordGrant({
        groupTaskId: note.groupTaskId,
        noteId: note.id,
        agentId,
        filePath: pathByAgent.get(agentId) ?? "",
        reviewerName,
      });
    }

    // Withheld: task participants who were not routed this note.
    for (const agentId of this.taskParticipants(note.groupTaskId)) {
      if (!note.targetAgentIds.includes(agentId)) {
        await this.ledger.recordWithheld({
          groupTaskId: note.groupTaskId,
          noteId: note.id,
          agentId,
          reason: "not_targeted",
          reviewerName,
        });
      }
    }

    return this.patchNote(note.id, { status: "active" });
  }

  /** Distinct agent IDs that ran a node in this task — independent of group shape. */
  private taskParticipants(groupTaskId: string): string[] {
    const ids = this.store
      .snapshot()
      .groupPlanNodes.filter((node) => node.groupTaskId === groupTaskId)
      .map((node) => node.agentId);
    return [...new Set(ids)];
  }

  private mustGetNote(noteId: string): MemoryNote {
    const note = this.store.snapshot().notes.find((item) => item.id === noteId);
    if (!note) throw new HttpError(404, `Note ${noteId} not found`);
    return note;
  }

  private async patchNote(
    noteId: string,
    patch: Partial<MemoryNote>,
  ): Promise<MemoryNote> {
    return this.store.mutate((database) => {
      const note = database.notes.find((item) => item.id === noteId);
      if (!note) throw new HttpError(404, `Note ${noteId} not found`);
      Object.assign(note, patch, { updatedAt: now() });
      return structuredClone(note);
    });
  }
}

/** Resolve target Agents for a note against the current store (used by callers). */
export function resolveTargetAgents(agents: Agent[], note: MemoryNote): Agent[] {
  return agents.filter((agent) => note.targetAgentIds.includes(agent.id));
}
