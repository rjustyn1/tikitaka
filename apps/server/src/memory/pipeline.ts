// Memory pipeline: the single entrypoint Person 2's GroupRunner calls after a
// group task reaches a flush point (Bridge 4). It wires the whole Person 3
// chain and FAILS OPEN — any memory error is caught and logged, and the group
// task stays completed/partial.
//
//   runMemoryPipeline()
//     -> SegmentBufferBuilder.build()
//     -> Consolidator.consolidate()
//     -> evaluateNoteSafety()  (per candidate)
//     -> ReviewService.processCandidate()  (auto-land clean normals, park risky)
//     -> Ledger records grants + withholdings (inside review)

import type { Agent, AgentGroup } from "../types.js";
import type { JsonStore } from "../store.js";
import { Consolidator } from "./consolidator.js";
import { GROUP_ROLES } from "./group-chain.js";
import {
  createExtractorClient,
  type ExtractorClient,
  type MemoryConfig,
} from "./extractor-client.js";
import { LandingService } from "./landing.js";
import { LedgerService } from "./ledger.js";
import { ReviewService } from "./review.js";
import { evaluateNoteSafety } from "./safety.js";
import { SegmentBufferBuilder } from "./task-buffer.js";

const now = () => new Date().toISOString();

export interface MemoryPipeline {
  /**
   * Consolidate one CLOSED topic segment. Keyed on the segment, not a task:
   * a segment spans every task that stayed on one subject, which is the point.
   */
  runMemoryPipeline(segmentId: string): Promise<void>;
  /**
   * Called when a task is RESUMED. Removes the auto-generated notes (and their
   * files + grant rows) from the earlier partial flush, so the final flush over
   * the full transcript produces one authoritative set. Human-decided notes
   * (approved/edited/rejected/revoked) are kept.
   */
  resetAutoNotes(groupTaskId: string): Promise<void>;
}

/** What Person 2 wires in until the real pipeline is available. */
export class NoopMemoryPipeline implements MemoryPipeline {
  async runMemoryPipeline(): Promise<void> {
    /* no-op */
  }
  async resetAutoNotes(): Promise<void> {
    /* no-op */
  }
}

export interface MemoryPipelineOptions {
  reviewAllSkills?: boolean;
  /** Consolidator model-call timeout (MEMORY_EXTRACT_TIMEOUT_MS). */
  extractTimeoutMs?: number;
  /** Optional sink for structured errors; defaults to console.error. */
  onError?: (message: string, error: unknown) => void;
}

export class RealMemoryPipeline implements MemoryPipeline {
  private readonly consolidator: Consolidator;
  private readonly review: ReviewService;
  private readonly buffers: SegmentBufferBuilder;
  private readonly landing: LandingService;
  private readonly onError: (message: string, error: unknown) => void;

  constructor(
    private readonly store: JsonStore,
    extractor: ExtractorClient,
    options: MemoryPipelineOptions = {},
  ) {
    const ledger = new LedgerService(store);
    this.landing = new LandingService(store);
    this.consolidator = new Consolidator(extractor, options.extractTimeoutMs);
    this.review = new ReviewService(
      store,
      this.landing,
      ledger,
      options.reviewAllSkills ?? false,
    );
    this.buffers = new SegmentBufferBuilder(store);
    this.onError =
      options.onError ?? ((message, error) => console.error(message, error));
  }

  async runMemoryPipeline(segmentId: string): Promise<void> {
    try {
      const buffer = this.buffers.build({ segmentId });
      const db = this.store.snapshot();

      // Every agent that worked anywhere in the segment, not just in one task.
      const segmentTaskIds = new Set(buffer.groupTaskIds);
      const participantIds = new Set(
        db.groupPlanNodes
          .filter((node) => segmentTaskIds.has(node.groupTaskId))
          .map((node) => node.agentId),
      );
      const members: Agent[] = db.agents.filter((agent) =>
        participantIds.has(agent.id),
      );
      const group: AgentGroup =
        db.groups.find((item) => item.id === buffer.groupId) ??
        syntheticGroup(buffer.groupId, members);

      const candidates = await this.consolidator.consolidate({
        segmentBuffer: buffer,
        group,
        members,
      });

      for (const candidate of candidates) {
        const safety = evaluateNoteSafety(candidate);
        // processCandidate reads candidate ids/severity/routing and safety's
        // redacted content; pass the pre-redaction candidate.
        await this.review.processCandidate(candidate, safety);
      }
      // Note: TopicSegment.flushedAt is stamped by the GroupRunner after this
      // returns (it owns segment lifecycle and stamps it even if extraction
      // produced nothing), so the pipeline does not set it here.
    } catch (error) {
      // Memory must never fail the completed group task.
      this.onError(`Memory pipeline failed for segment ${segmentId}`, error);
    }
  }

  async resetAutoNotes(groupTaskId: string): Promise<void> {
    try {
      const db = this.store.snapshot();
      // Resume hands us a task id, but consolidation is owned by the segment,
      // so clear the whole segment's auto notes and reopen it. The resumed task
      // then rejoins it and the eventual re-flush covers the full segment.
      const segment = db.topicSegments.find((item) =>
        item.groupTaskIds.includes(groupTaskId),
      );
      const scopedTaskIds = new Set(segment?.groupTaskIds ?? [groupTaskId]);
      const taskNotes = db.notes.filter((note) =>
        scopedTaskIds.has(note.groupTaskId),
      );

      // A note is human-decided if a person explicitly acted on it: a review
      // action stamps a reviewerName on its grant rows, and reject/revoke are
      // human-only statuses. Auto-landed notes have only null-reviewer grants.
      const humanDecided = (noteId: string, status: string): boolean =>
        status === "rejected" ||
        status === "revoked" ||
        db.grants.some(
          (grant) => grant.noteId === noteId && grant.reviewerName !== null,
        );

      const autoNotes = taskNotes.filter(
        (note) => !humanDecided(note.id, note.status),
      );
      // Remove any landed files from disk (revokeMemory does not touch the
      // ledger; it only deletes files and marks landedMemoryFiles rows).
      for (const note of autoNotes) {
        await this.landing.revokeMemory(note);
      }

      if (autoNotes.length > 0) {
        const autoIds = new Set(autoNotes.map((note) => note.id));
        await this.store.mutate((database) => {
          database.notes = database.notes.filter((note) => !autoIds.has(note.id));
          database.grants = database.grants.filter(
            (grant) => !autoIds.has(grant.noteId),
          );
          database.landedMemoryFiles = database.landedMemoryFiles.filter(
            (file) => !autoIds.has(file.noteId),
          );
        });
      }

      // Always reopen, even when the earlier flush produced nothing to clean
      // up: the segment must be able to consolidate again after the resume.
      await this.reopenSegment(segment?.id);
    } catch (error) {
      // Resetting notes must never block a resume.
      this.onError(`Failed to reset auto notes for task ${groupTaskId}`, error);
    }
  }

  /**
   * Put a segment back in the accumulating state so a resumed task rejoins it
   * and the eventual re-flush is authoritative over the whole segment.
   */
  private async reopenSegment(segmentId: string | undefined): Promise<void> {
    if (!segmentId) return;
    await this.store.mutate((database) => {
      const segment = database.topicSegments.find(
        (item) => item.id === segmentId,
      );
      if (!segment) return;
      segment.status = "open";
      segment.endSeq = null;
      segment.closeReason = null;
      segment.driftScore = null;
      segment.closedAt = null;
      segment.flushedAt = null;
    });
  }
}

function syntheticGroup(groupId: string, members: Agent[]): AgentGroup {
  return {
    id: groupId,
    name: "",
    description: "",
    // A4: roles are positional here only because this is a fallback for a
    // missing group row. The consolidator reads no group fields (see
    // integrationManifest3 section 5), so the roles are never consulted.
    members: members.map((agent, index) => ({
      agentId: agent.id,
      role: GROUP_ROLES[index] ?? "backend",
    })),
    activeTaskId: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

/**
 * Build the real pipeline. `config` is the single validated memory
 * configuration source: index.ts passes the real AppConfig (a structural
 * superset of MemoryConfig) straight through — there is no separate
 * process.env path.
 */
export function createMemoryPipeline(
  store: JsonStore,
  config: MemoryConfig,
  options: MemoryPipelineOptions = {},
): MemoryPipeline {
  return new RealMemoryPipeline(store, createExtractorClient(config), {
    extractTimeoutMs: config.memoryExtractTimeoutMs,
    ...options,
  });
}
