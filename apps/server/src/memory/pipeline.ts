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

import type { Agent, AgentGroup } from "../types.js";
import type { JsonStore } from "../store.js";
import { Consolidator } from "./consolidator.js";
import {
  createExtractorClient,
  memoryConfigFromEnv,
  type ExtractorClient,
  type MemoryConfig,
} from "./extractor-client.js";
import { LandingService } from "./landing.js";
import { LedgerService } from "./ledger.js";
import { ReviewService } from "./review.js";
import { evaluateNoteSafety } from "./safety.js";
import { TaskBufferBuilder } from "./task-buffer.js";

const now = () => new Date().toISOString();

export interface MemoryPipeline {
  runMemoryPipeline(groupTaskId: string, sinkNodeIds: string[]): Promise<void>;
}

/** What Person 2 wires in until the real pipeline is available. */
export class NoopMemoryPipeline implements MemoryPipeline {
  async runMemoryPipeline(): Promise<void> {
    /* no-op */
  }
}

export interface MemoryPipelineOptions {
  reviewAllSkills?: boolean;
  /** Optional sink for structured errors; defaults to console.error. */
  onError?: (message: string, error: unknown) => void;
}

export class RealMemoryPipeline implements MemoryPipeline {
  private readonly consolidator: Consolidator;
  private readonly review: ReviewService;
  private readonly buffers: TaskBufferBuilder;
  private readonly onError: (message: string, error: unknown) => void;

  constructor(
    private readonly store: JsonStore,
    extractor: ExtractorClient,
    options: MemoryPipelineOptions = {},
  ) {
    const ledger = new LedgerService(store);
    const landing = new LandingService(store);
    this.consolidator = new Consolidator(extractor);
    this.review = new ReviewService(
      store,
      landing,
      ledger,
      options.reviewAllSkills ?? false,
    );
    this.buffers = new TaskBufferBuilder(store);
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
        const safety = evaluateNoteSafety(candidate);
        // processCandidate reads candidate ids/severity/routing and safety's
        // redacted content; pass the pre-redaction candidate.
        await this.review.processCandidate(candidate, safety);
      }

      await this.store.mutate((database) => {
        const task = database.groupTasks.find((item) => item.id === groupTaskId);
        if (task) task.flushedAt = now();
      });
    } catch (error) {
      // Memory must never fail the completed group task.
      this.onError(`Memory pipeline failed for task ${groupTaskId}`, error);
    }
  }
}

function syntheticGroup(groupId: string, members: Agent[]): AgentGroup {
  return {
    id: groupId,
    name: "",
    description: "",
    memberAgentIds: members.map((agent) => agent.id),
    activeTaskId: null,
    createdAt: now(),
    updatedAt: now(),
  };
}

/**
 * Build the real pipeline. Config defaults to the environment stub until
 * Person 1 lands the memory keys on AppConfig, at which point the real config
 * (a structural superset of MemoryConfig) can be passed straight through.
 */
export function createMemoryPipeline(
  store: JsonStore,
  config: MemoryConfig = memoryConfigFromEnv(),
  options: MemoryPipelineOptions = {},
): MemoryPipeline {
  return new RealMemoryPipeline(store, createExtractorClient(config), options);
}
