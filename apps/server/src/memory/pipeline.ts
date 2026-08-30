// Memory pipeline: the single entrypoint Person 2's GroupRunner calls after a
// group task reaches a flush point (Bridge 4). It wires the whole Person 3
// chain and FAILS OPEN — any memory error is caught and logged, and the group
// task stays completed/partial.
//
//   runMemoryPipeline()
//     -> TaskBufferBuilder.build()
//     -> Consolidator.consolidate()
//     -> evaluateNoteSafety()  (per candidate)
//     -> ReviewService.processCandidate()  (auto-land clean normals, park risky)
//     -> Ledger records grants + withholdings (inside review)

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
import { TaskBufferBuilder } from "./task-buffer.js";
import type { CandidateMemoryNote, NoteRecognizer } from "./types.js";

const now = () => new Date().toISOString();

export interface MemoryPipeline {
  runMemoryPipeline(groupTaskId: string, sinkNodeIds: string[]): Promise<void>;
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
  /** Optional runtime router; absent preserves legacy consolidator routing. */
  recognizer?: NoteRecognizer;
  /** Optional sink for structured errors; defaults to console.error. */
  onError?: (message: string, error: unknown) => void;
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
  private readonly buffers: TaskBufferBuilder;
  private readonly landing: LandingService;
  private readonly onError: (message: string, error: unknown) => void;
  private readonly recognizer: NoteRecognizer | undefined;

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
    this.buffers = new TaskBufferBuilder(store);
    this.recognizer = options.recognizer;
    this.onError =
      options.onError ?? ((message, error) => console.error(message, error));
  }

  async runMemoryPipeline(
    groupTaskId: string,
    sinkNodeIds: string[],
  ): Promise<void> {
    try {
      const buffer = this.buffers.build({ groupTaskId, sinkNodeIds });
      const db = this.store.snapshot();

      const participantIds = new Set(
        db.groupPlanNodes
          .filter((node) => node.groupTaskId === groupTaskId)
          .map((node) => node.agentId),
      );
      const members: Agent[] = db.agents.filter((agent) =>
        participantIds.has(agent.id),
      );
      const group: AgentGroup =
        db.groups.find((item) => item.id === buffer.groupId) ??
        syntheticGroup(buffer.groupId, members);

      const candidates = await this.consolidator.consolidate({
        taskBuffer: buffer,
        group,
        members,
      });

      for (const candidate of candidates) {
        const routed = await this.routeCandidate(candidate, members);
        if (!routed) continue;
        const safety = evaluateNoteSafety(routed);
        // processCandidate reads candidate ids/severity/routing and safety's
        // redacted content; pass the pre-redaction candidate.
        await this.review.processCandidate(routed, safety);
      }
      // Note: GroupTask.flushedAt is stamped by the GroupRunner after this
      // returns (it owns the task lifecycle and stamps it even if extraction
      // produced nothing), so the pipeline does not set it here.
    } catch (error) {
      // Memory must never fail the completed group task.
      this.onError(`Memory pipeline failed for task ${groupTaskId}`, error);
    }
  }

  private async routeCandidate(
    candidate: CandidateMemoryNote,
    members: Agent[],
  ): Promise<CandidateMemoryNote | null> {
    if (!this.recognizer) return null;
    try {
      const recognition = await this.recognizer.recognizeAgents(
        [candidate.description, candidate.content].join("\n"),
        members,
      );
      if (recognition.matches.length === 0) return null;
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
      const taskNotes = db.notes.filter(
        (note) => note.groupTaskId === groupTaskId,
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
      if (autoNotes.length === 0) return;

      // Remove any landed files from disk (revokeMemory does not touch the
      // ledger; it only deletes files and marks landedMemoryFiles rows).
      for (const note of autoNotes) {
        await this.landing.revokeMemory(note);
      }

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
    } catch (error) {
      // Resetting notes must never block a resume.
      this.onError(`Failed to reset auto notes for task ${groupTaskId}`, error);
    }
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
  const recognizer = options.recognizer ?? createRuntimeRecognizer(config);
  return new RealMemoryPipeline(store, createExtractorClient(config), {
    extractTimeoutMs: config.memoryExtractTimeoutMs,
    ...options,
    ...(recognizer ? { recognizer } : {}),
  });
}

function createRuntimeRecognizer(
  config: MemoryConfig & RecognitionRuntimeConfig,
): NoteRecognizer | undefined {
  const mode = config.memoryRecognizer ?? "fake";
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
    const pythonPath = config.memorySbertPython?.trim() ?? "";
    const modelPath = config.memorySbertModelDir?.trim() ?? "";
    const bridgePath = config.memorySbertBridge?.trim() ?? "";
    if (!pythonPath || !modelPath || !bridgePath) {
      throw new Error(
        "MEMORY_RECOGNIZER=sbert requires MEMORY_SBERT_PYTHON, MEMORY_SBERT_MODEL_DIR, and MEMORY_SBERT_BRIDGE",
      );
    }
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
