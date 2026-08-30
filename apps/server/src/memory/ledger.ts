// Ledger: the append-only audit layer. Records every grant, withholding,
// rejection, and revocation, one row per Agent per note decision.
//
// The ledger is NOT the enforcement boundary — file presence in the target
// Agent workspace is. The ledger explains it. Its differentiator is the
// *withheld* record: who did NOT receive a memory, and why. See
// components/LEDGER.md.

import { randomUUID } from "node:crypto";
import type { GrantRecord } from "../types.js";
import type { JsonStore } from "../store.js";

const now = () => new Date().toISOString();

/** Named reasons a note was withheld from an Agent. */
export type WithholdReason =
  | "out_of_group"
  | "not_targeted"
  | "private"
  | "quarantined"
  | "rejected"
  | "revoked"
  | "landing_failed";

export interface RecordGrantInput {
  groupTaskId: string;
  noteId: string;
  agentId: string;
  filePath: string;
  reviewerName?: string | null;
}

export interface RecordWithheldInput {
  groupTaskId: string;
  noteId: string;
  agentId: string;
  reason: WithholdReason;
  reviewerName?: string | null;
}

export interface RecordRejectedInput {
  groupTaskId: string;
  noteId: string;
  candidateAgentIds: string[];
  reviewerName: string;
  reason: string;
}

export interface RecordRevokedInput {
  groupTaskId: string;
  noteId: string;
  grantedAgentIds: string[];
  reviewerName: string;
  reason: string;
}

interface BuildGrantRecordInput {
  groupTaskId: string;
  noteId: string;
  agentId: string;
  decision: GrantRecord["decision"];
  reason: string;
  filePath?: string | null;
  reviewerName?: string | null;
}

function buildGrantRecord(input: BuildGrantRecordInput): GrantRecord {
  return {
    id: randomUUID(),
    groupTaskId: input.groupTaskId,
    noteId: input.noteId,
    agentId: input.agentId,
    decision: input.decision,
    reason: input.reason,
    filePath: input.filePath ?? null,
    reviewerName: input.reviewerName ?? null,
    createdAt: now(),
  };
}

export class LedgerService {
  constructor(private readonly store: JsonStore) {}

  async recordGrant(input: RecordGrantInput): Promise<GrantRecord> {
    const record = buildGrantRecord({
      groupTaskId: input.groupTaskId,
      noteId: input.noteId,
      agentId: input.agentId,
      decision: "granted",
      reason: "granted",
      filePath: input.filePath,
      reviewerName: input.reviewerName ?? null,
    });
    await this.store.mutate((db) => {
      db.grants.push(record);
    });
    return record;
  }

  async recordWithheld(input: RecordWithheldInput): Promise<GrantRecord> {
    const record = buildGrantRecord({
      groupTaskId: input.groupTaskId,
      noteId: input.noteId,
      agentId: input.agentId,
      decision: "withheld",
      reason: input.reason,
      reviewerName: input.reviewerName ?? null,
    });
    await this.store.mutate((db) => {
      db.grants.push(record);
    });
    return record;
  }

  async recordRejected(input: RecordRejectedInput): Promise<GrantRecord[]> {
    const records = input.candidateAgentIds.map((agentId) =>
      buildGrantRecord({
        groupTaskId: input.groupTaskId,
        noteId: input.noteId,
        agentId,
        decision: "rejected",
        reason: input.reason,
        reviewerName: input.reviewerName,
      }),
    );
    await this.store.mutate((db) => {
      db.grants.push(...records);
    });
    return records;
  }

  async recordRevoked(input: RecordRevokedInput): Promise<GrantRecord[]> {
    const records = input.grantedAgentIds.map((agentId) =>
      buildGrantRecord({
        groupTaskId: input.groupTaskId,
        noteId: input.noteId,
        agentId,
        decision: "revoked",
        reason: input.reason,
        reviewerName: input.reviewerName,
      }),
    );
    await this.store.mutate((db) => {
      db.grants.push(...records);
    });
    return records;
  }

  listTaskGrants(groupTaskId: string): GrantRecord[] {
    return this.store
      .snapshot()
      .grants.filter((grant) => grant.groupTaskId === groupTaskId);
  }

  listNoteGrants(noteId: string): GrantRecord[] {
    return this.store
      .snapshot()
      .grants.filter((grant) => grant.noteId === noteId);
  }
}
