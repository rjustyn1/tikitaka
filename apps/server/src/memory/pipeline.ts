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

import { existsSync, statSync } from "node:fs";
import type { Agent, AgentGroup, MemorySkillAssignment } from "../types.js";
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
import {
  ArkEmbeddingClient,
  FakeEmbeddingClient,
  Recognizer,
  SbertEmbeddingClient,
} from "./recognizer.js";
import { evaluateNoteSafety } from "./safety.js";
import { loadAgentSkillProfiles } from "./skill-catalog.js";
import { SegmentBufferBuilder } from "./task-buffer.js";
import type { CandidateMemoryNote, NoteRecognizer } from "./types.js";

const now = () => new Date().toISOString();

/**
 * What the consolidator is doing right now.
 *
 * The pipeline is deliberately fire-and-forget -- memory must never fail a
 * completed task -- which also means nothing in the store says "a run is in
 * flight". Without this the UI could only infer activity from its after
 * effects, and would show "idle" through the whole of a slow extraction. So
 * the phase is tracked in memory here and read over the API.
 */
/**
 * The pipeline's stages, in the order MEMORY_PIPELINE.md runs them:
 * buffer -> consolidate -> recognize agents -> recognize skills -> safety ->
 * review. Recognition is two levels -- which Agents a note is for, then which
 * skill file it becomes inside each of those Agents -- and they are reported
 * separately because the second is where a new skill gets proposed.
 *
 * Landing is not its own phase: LandingService is driven by ReviewService, so
 * the write happens inside `reviewing` and claiming otherwise would invent an
 * ordering the code does not have.
 */
export const MEMORY_PHASES = [
  "buffering",
  "consolidating",
  "recognizing-agents",
  "recognizing-skills",
  "safety",
  "reviewing",
] as const;

export type MemoryPhase = (typeof MEMORY_PHASES)[number];

export interface MemoryRunStatus {
  segmentId: string;
  groupId: string | null;
  phase: MemoryPhase;
  startedAt: string;
  /** Nodes in scope: a mid-DAG drift flush covers only part of a task. */
  nodeCount: number | null;
  /** Candidates the consolidator returned; 0 until consolidation finishes. */
  candidates: number;
  /** 1-based position in that list, so the panel can count runs through. */
  candidateIndex: number;
}

export interface MemoryLastRun {
  segmentId: string;
  groupId: string | null;
  finishedAt: string;
  durationMs: number;
  ok: boolean;
  /** Candidates the consolidator returned, before routing dropped any. */
  candidates: number;
  /** Candidates that survived routing and reached review. */
  notes: number;
  error: string | null;
}

export interface MemoryPipelineStatus {
  active: MemoryRunStatus[];
  lastRun: MemoryLastRun | null;
}

export interface MemoryPipeline {
  /**
   * Consolidate one CLOSED topic segment. Keyed on the segment, not a task:
   * a segment spans every task that stayed on one subject, which is the point.
   */
  runMemoryPipeline(segmentId: string, onlyNodeIds?: string[]): Promise<void>;
  /** Live consolidator activity, for the status panel. */
  status(): MemoryPipelineStatus;
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
  status(): MemoryPipelineStatus {
    return { active: [], lastRun: null };
  }
  async resetAutoNotes(): Promise<void> {
    /* no-op */
  }
}

export interface MemoryPipelineOptions {
  reviewAllSkills?: boolean;
  /** Consolidator model-call timeout (MEMORY_EXTRACT_TIMEOUT_MS). */
  extractTimeoutMs?: number;
  /** Optional runtime router; absent preserves legacy consolidator routing. */
  recognizer?: NoteRecognizer;
  /** Overrides the extractor the config would select. Used by DEMO_MODE. */
  extractor?: ExtractorClient;
  /**
   * Drop a candidate when the group already holds a live note with the same
   * skill key. Consolidation runs more than once over a task -- a mid-DAG
   * flush, then the segment close -- and the same durable rule is often worth
   * stating from both, which shows up as the same note twice.
   */
  dedupeBySkillKey?: boolean;
  /** Optional sink for structured errors; defaults to console.error. */
  onError?: (message: string, error: unknown) => void;
  /**
   * Demo pacing. The offline extractor and recognizer return instantly, so a
   * whole run finishes in ~100ms and the status panel shows nothing but a
   * flicker. Holding each phase briefly makes the stages readable. Zero (the
   * default) means no pacing at all -- this must never slow a real run.
   */
  phaseDelayMs?: number;
}

export interface RecognitionRuntimeConfig {
  memoryRecognizer?: "ark" | "fake" | "sbert" | "off";
  memoryEmbeddingModel?: string;
  memorySbertPython?: string;
  memorySbertModelDir?: string;
  memorySbertBridge?: string;
  memoryRecognitionAgentThreshold?: number;
  memoryRecognitionSkillThreshold?: number;
  memoryEmbeddingTimeoutMs?: number;
}

export class RealMemoryPipeline implements MemoryPipeline {
  private readonly consolidator: Consolidator;
  private readonly review: ReviewService;
  private readonly buffers: SegmentBufferBuilder;
  private readonly landing: LandingService;
  private readonly onError: (message: string, error: unknown) => void;
  private readonly recognizer: NoteRecognizer | undefined;
  /** Runs in flight, keyed by segment: concurrent flushes are possible. */
  private readonly active = new Map<string, MemoryRunStatus>();
  private lastRun: MemoryLastRun | null = null;
  private readonly phaseDelayMs: number;
  private readonly dedupeBySkillKey: boolean;

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
    this.recognizer = options.recognizer;
    this.phaseDelayMs = options.phaseDelayMs ?? 0;
    this.dedupeBySkillKey = options.dedupeBySkillKey ?? false;
    this.onError =
      options.onError ?? ((message, error) => console.error(message, error));
  }

  status(): MemoryPipelineStatus {
    return {
      active: [...this.active.values()],
      lastRun: this.lastRun,
    };
  }

  /** Move a run to a phase, pausing first when demo pacing is on. */
  private async enterPhase(
    run: MemoryRunStatus,
    phase: MemoryPhase,
  ): Promise<void> {
    if (this.phaseDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.phaseDelayMs));
    }
    run.phase = phase;
  }

  async runMemoryPipeline(
    segmentId: string,
    onlyNodeIds?: string[],
  ): Promise<void> {
    const startedAtMs = Date.now();
    const run: MemoryRunStatus = {
      segmentId,
      groupId: null,
      phase: "buffering",
      startedAt: now(),
      nodeCount: onlyNodeIds?.length ?? null,
      candidates: 0,
      candidateIndex: 0,
    };
    this.active.set(segmentId, run);
    let candidateCount = 0;
    let noteCount = 0;
    try {
      const buffer = this.buffers.build({ segmentId, onlyNodeIds });
      run.groupId = buffer.groupId;
      await this.enterPhase(run, "consolidating");
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
      candidateCount = candidates.length;
      run.candidates = candidates.length;

      for (const [index, candidate] of candidates.entries()) {
        run.candidateIndex = index + 1;
        // A rule the group already holds is not news. Rejected and revoked
        // notes do not count: a human decided those, and the same fact
        // arising again is a new decision to make, not a duplicate.
        if (
          this.dedupeBySkillKey &&
          candidate.skillKey &&
          db.notes.some(
            (note) =>
              note.groupId === buffer.groupId &&
              note.skillKey === candidate.skillKey &&
              note.status !== "rejected" &&
              note.status !== "revoked",
          )
        ) {
          continue;
        }
        const routed = await this.routeCandidate(candidate, members, run);
        if (!routed) continue;
        noteCount += 1;
        await this.enterPhase(run, "safety");
        const safety = evaluateNoteSafety(routed);
        await this.enterPhase(run, "reviewing");
        // processCandidate reads candidate ids/severity/routing and safety's
        // redacted content; pass the pre-redaction candidate.
        await this.review.processCandidate(routed, safety);
      }
      // Note: TopicSegment.flushedAt is stamped by the GroupRunner after this
      // returns (it owns segment lifecycle and stamps it even if extraction
      // produced nothing), so the pipeline does not set it here.
      this.lastRun = {
        segmentId,
        groupId: run.groupId,
        finishedAt: now(),
        durationMs: Date.now() - startedAtMs,
        ok: true,
        candidates: candidateCount,
        notes: noteCount,
        error: null,
      };
    } catch (error) {
      // Memory must never fail the completed group task.
      this.onError(`Memory pipeline failed for segment ${segmentId}`, error);
      this.lastRun = {
        segmentId,
        groupId: run.groupId,
        finishedAt: now(),
        durationMs: Date.now() - startedAtMs,
        ok: false,
        candidates: candidateCount,
        notes: noteCount,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Always clear, or a failed run leaves the panel claiming it is busy.
      this.active.delete(segmentId);
    }
  }

  private async routeCandidate(
    candidate: CandidateMemoryNote,
    members: Agent[],
    run?: MemoryRunStatus,
  ): Promise<CandidateMemoryNote | null> {
    if (!this.recognizer) return null;
    try {
      if (run) await this.enterPhase(run, "recognizing-agents");
      const recognition = await this.recognizer.recognizeAgents(
        [candidate.description, candidate.content].join("\n"),
        members,
      );
      if (recognition.matches.length === 0) return null;
      if (run) await this.enterPhase(run, "recognizing-skills");
      const skillAssignments = await this.assignSkills(
        [candidate.description, candidate.content].join("\n"),
        candidate.skillKey,
        recognition.matches,
        members,
      );
      if (skillAssignments === null) return null;
      return {
        ...candidate,
        targetAgentIds: recognition.matches.map((match) => match.agentId),
        recognitionMatchKind: recognition.matches[0]!.matchKind,
        recognitionScores: Object.fromEntries(
          recognition.matches.map((match) => [match.agentId, match.score]),
        ),
        ...(skillAssignments.length > 0 ? { skillAssignments } : {}),
      };
    } catch (error) {
      this.onError(
        `Recognition failed for note ${candidate.id}; note withheld`,
        error,
      );
      return null;
    }
  }

  private async assignSkills(
    noteText: string,
    proposedSkillKey: string,
    matches: Awaited<ReturnType<NoteRecognizer["recognizeAgents"]>>["matches"],
    members: Agent[],
  ): Promise<MemorySkillAssignment[] | null> {
    if (!this.recognizer?.recognizeSkill) return [];
    const assignments = await Promise.all(
      matches.map(async (match) => {
        const agent = members.find((member) => member.id === match.agentId);
        if (!agent) return null;
        const skills = await loadAgentSkillProfiles(agent);
        const decision = await this.recognizer!.recognizeSkill!(noteText, skills);
        if (decision.kind === "existing") {
          return {
            agentId: agent.id,
            skillKey: decision.skill.skillKey,
            score: decision.score,
            matchKind: "threshold" as const,
          };
        }
        // A generated key colliding with an unrelated existing skill is not a
        // safe implicit merge. Drop the candidate for review/re-extraction.
        if (skills.some((skill) => skill.skillKey === proposedSkillKey)) {
          return null;
        }
        return {
          agentId: agent.id,
          skillKey: proposedSkillKey,
          score: decision.score,
          matchKind: "new-skill" as const,
        };
      }),
    );
    if (assignments.some((assignment) => assignment === null)) return null;
    return assignments as MemorySkillAssignment[];
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
  config: MemoryConfig & RecognitionRuntimeConfig,
  options: MemoryPipelineOptions = {},
): MemoryPipeline {
  // This is intentionally the first branch. A disabled memory subsystem must
  // not initialize a recognizer, inspect local model files, or construct an
  // extractor client that could later make a network call.
  if (config.memoryEnabled === false) return new NoopMemoryPipeline();
  const recognizer = options.recognizer ?? createRuntimeRecognizer(config);
  return new RealMemoryPipeline(store, options.extractor ?? createExtractorClient(config), {
    extractTimeoutMs: config.memoryExtractTimeoutMs,
    ...options,
    ...(recognizer ? { recognizer } : {}),
  });
}

function sbertRuntime(config: MemoryConfig & RecognitionRuntimeConfig): {
  pythonPath: string;
  modelPath: string;
  bridgePath: string;
} {
  const pythonPath = config.memorySbertPython?.trim() ?? "";
  const modelPath = config.memorySbertModelDir?.trim() ?? "";
  const bridgePath = config.memorySbertBridge?.trim() ?? "";
  const weights = modelPath ? modelPath + "/model.safetensors" : "";

  const reason = !pythonPath
    ? "MEMORY_SBERT_PYTHON is empty"
    : !modelPath || !existsSync(modelPath)
      ? "checkpoint directory is missing"
    : !bridgePath || !existsSync(bridgePath)
      ? "embedding bridge is missing"
      : !existsSync(weights)
        ? "model.safetensors is missing"
        : statSync(weights).size < 1_000_000
          ? "model.safetensors is a Git LFS pointer, not real weights (run: git lfs pull)"
          : null;
  if (reason !== null) {
    throw new Error(
      "MEMORY_RECOGNIZER=sbert requires a usable local runtime: " +
        reason +
        ". No automatic fake fallback is configured.",
    );
  }
  return { pythonPath, modelPath, bridgePath };
}

function createRuntimeRecognizer(
  config: MemoryConfig & RecognitionRuntimeConfig,
): NoteRecognizer | undefined {
  const mode = config.memoryRecognizer ?? "sbert";
  if (mode === "off") return undefined;
  const options = {
    ...(config.memoryRecognitionAgentThreshold !== undefined
      ? { agentThreshold: config.memoryRecognitionAgentThreshold }
      : {}),
    ...(config.memoryRecognitionSkillThreshold !== undefined
      ? { skillThreshold: config.memoryRecognitionSkillThreshold }
      : {}),
  };
  if (mode === "fake") return new Recognizer(new FakeEmbeddingClient(), options);
  if (mode === "sbert") {
    const { pythonPath, modelPath, bridgePath } = sbertRuntime(config);
    return new Recognizer(
      new SbertEmbeddingClient({
        pythonPath,
        modelPath,
        bridgePath,
        ...(config.memoryEmbeddingTimeoutMs !== undefined
          ? { timeoutMs: config.memoryEmbeddingTimeoutMs }
          : {}),
      }),
      options,
    );
  }

  const model = config.memoryEmbeddingModel?.trim() ?? "";
  if (!model || !config.arkApiKey.trim()) {
    throw new Error(
      "MEMORY_RECOGNIZER=ark requires MEMORY_EMBEDDING_MODEL and ARK_API_KEY",
    );
  }
  return new Recognizer(
    new ArkEmbeddingClient({
      apiKey: config.arkApiKey,
      model,
      baseUrl: config.arkBaseUrl,
      ...(config.memoryEmbeddingTimeoutMs !== undefined
        ? { timeoutMs: config.memoryEmbeddingTimeoutMs }
        : {}),
    }),
    options,
  );
}
