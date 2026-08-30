// Internal contracts shared across the Person 3 memory pipeline.
//
// These are NOT persisted-database types. The persisted types (MemoryNote,
// GrantRecord, LandedMemoryFile, ...) live in ../types.ts and are owned by
// Person 1. This file holds the in-flight shapes that flow between the memory
// modules before anything is written to the store or disk.

import type {
  GroupTaskStatus,
  MemoryMatchKind,
  MemorySkillAssignment,
  MemorySeverity,
  TraceSpan,
} from "../types.js";

/**
 * A note as produced by the consolidator, before safety, review, or landing.
 * It has no `status`, `groupId`, or safety fields yet — review.ts promotes it
 * into a persisted MemoryNote.
 */
export interface CandidateMemoryNote {
  id: string;
  groupTaskId: string;
  content: string;
  severity: MemorySeverity;
  targetAgentIds: string[];
  recognitionMatchKind?: MemoryMatchKind;
  recognitionScores?: Record<string, number>;
  skillKey: string;
  skillAssignments?: MemorySkillAssignment[];
  description: string;
  sourceRunIds: string[];
  sourceSpanIds: string[];
  rationale: string;
}

export interface NoteRecognizer {
  recognizeAgents(
    noteText: string,
    members: readonly {
      id: string;
      name: string;
      description: string;
      instructions: string;
    }[],
  ): Promise<{
    matches: Array<{
      agentId: string;
      score: number;
      matchKind: MemoryMatchKind;
    }>;
    threshold: number;
  }>;
  recognizeSkill?: (
    noteText: string,
    skills: readonly {
      skillKey: string;
      name: string;
      description: string;
      examples?: readonly string[];
    }[],
  ) => Promise<
    | {
        kind: "existing";
        skill: { skillKey: string };
        score: number;
        matchKind: MemoryMatchKind;
      }
    | {
        kind: "new-skill";
        score: number;
        suggestedDescription: string;
      }
  >;
}

/** Result of running a candidate note through safety (redaction + quarantine). */
export interface SafetyResult {
  /** The note with secrets redacted from content and description. */
  note: CandidateMemoryNote;
  redactionFired: boolean;
  quarantineHit: boolean;
  reasons: string[];
}

/** One node's contribution to the extractor input packet. */
export interface TaskBufferEntry {
  planNodeId: string;
  agentId: string;
  nodeRole: string;
  runId: string;
  output: string;
  spans: TraceSpan[];
  injectedMessageIds: string[];
  injectedDependencyNodeIds: string[];
}

/**
 * The reassembled, ordered input packet handed to the consolidator after a
 * group task reaches a flush point. Built by reading the store back — it is not
 * a second live copy of spans. See components/TASK-BUFFER.md.
 */
export interface TaskBuffer {
  groupTaskId: string;
  groupId: string;
  prompt: string;
  status: GroupTaskStatus;
  orderedNodeIds: string[];
  entries: TaskBufferEntry[];
}
