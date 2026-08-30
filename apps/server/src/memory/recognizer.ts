import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export type MatchKind = "threshold" | "fallback";

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

export interface EmbeddingClientConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface SbertEmbeddingClientConfig {
  pythonPath: string;
  bridgePath: string;
  modelPath: string;
  timeoutMs?: number;
}

export type SbertEmbeddingRunner = (
  config: SbertEmbeddingClientConfig,
  text: string,
) => Promise<number[]>;

export interface RecognizerAgent {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

export interface SkillProfile {
  skillKey: string;
  name: string;
  description: string;
  examples?: readonly string[];
}

export interface AgentMatch {
  agentId: string;
  score: number;
  matchKind: MatchKind;
}

export interface AgentRecognition {
  matches: AgentMatch[];
  threshold: number;
}

export type SkillDecision =
  | {
      kind: "existing";
      skill: SkillProfile;
      score: number;
      matchKind: MatchKind;
    }
  | {
      kind: "new-skill";
      score: number;
      suggestedDescription: string;
    };

export interface RecognizerOptions {
  agentThreshold?: number;
  skillThreshold?: number;
}

const DEFAULT_AGENT_THRESHOLD = 0.35;
const DEFAULT_SKILL_THRESHOLD = 0.45;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Cosine similarity for normalized or unnormalized vectors. Incompatible
 * vectors are treated as non-matches rather than being allowed to route a
 * note accidentally.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export class Recognizer {
  private readonly profileCache = new Map<
    string,
    { fingerprint: string; embedding: number[] }
  >();

  constructor(
    private readonly embeddings: EmbeddingClient,
    private readonly options: RecognizerOptions = {},
  ) {}

  async recognizeAgents(
    noteText: string,
    members: readonly RecognizerAgent[],
  ): Promise<AgentRecognition> {
    if (members.length === 0) {
      return { matches: [], threshold: this.agentThreshold() };
    }

    const noteEmbedding = await this.embeddings.embed(noteText);
    const scored = await Promise.all(
      members.map(async (agent, index) => ({
        agentId: agent.id,
        score: cosineSimilarity(
          noteEmbedding,
          await this.profileEmbedding(agent),
        ),
        index,
      })),
    );
    scored.sort((left, right) => right.score - left.score || left.index - right.index);

    const threshold = this.agentThreshold();
    const thresholdMatches = scored.filter((item) => item.score >= threshold);
    const selected = thresholdMatches.length > 0 ? thresholdMatches : scored.slice(0, 1);
    const matchKind: MatchKind = thresholdMatches.length > 0 ? "threshold" : "fallback";
    return {
      threshold,
      matches: selected.map(({ agentId, score }) => ({ agentId, score, matchKind })),
    };
  }

  /** Match skills for one already-recognized Agent. Never searches other Agents. */
  async recognizeSkill(
    noteText: string,
    skills: readonly SkillProfile[],
  ): Promise<SkillDecision> {
    const noteEmbedding = await this.embeddings.embed(noteText);
    if (skills.length === 0) {
      return {
        kind: "new-skill",
        score: 0,
        suggestedDescription: summarizeSkill(noteText),
      };
    }

    const scored = await Promise.all(
      skills.map(async (skill, index) => ({
        skill,
        score: cosineSimilarity(noteEmbedding, await this.skillEmbedding(skill)),
        index,
      })),
    );
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    const best = scored[0]!;
    if (best.score < this.skillThreshold()) {
      return {
        kind: "new-skill",
        score: best.score,
        suggestedDescription: summarizeSkill(noteText),
      };
    }
    return {
      kind: "existing",
      skill: best.skill,
      score: best.score,
      matchKind: "threshold",
    };
  }

  clearCache(): void {
    this.profileCache.clear();
  }

  private agentThreshold(): number {
    return this.options.agentThreshold ?? DEFAULT_AGENT_THRESHOLD;
  }

  private skillThreshold(): number {
    return this.options.skillThreshold ?? DEFAULT_SKILL_THRESHOLD;
  }

  private async profileEmbedding(agent: RecognizerAgent): Promise<number[]> {
    return this.cachedEmbedding(
      `agent:${agent.id}`,
      [agent.name, agent.description, agent.instructions].join("\n"),
    );
  }

  private async skillEmbedding(skill: SkillProfile): Promise<number[]> {
    return this.cachedEmbedding(
      `skill:${skill.skillKey}`,
      [skill.name, skill.description, ...(skill.examples ?? [])].join("\n"),
    );
  }

  private async cachedEmbedding(cacheKey: string, text: string): Promise<number[]> {
    const fingerprint = hashText(text);
    const cached = this.profileCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) return cached.embedding;
    const embedding = await this.embeddings.embed(text);
    this.profileCache.set(cacheKey, { fingerprint, embedding });
    return embedding;
  }
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EmbeddingError";
  }
}

/** OpenAI-compatible embeddings endpoint, including Ark deployments. */
export class ArkEmbeddingClient implements EmbeddingClient {
  constructor(private readonly config: EmbeddingClientConfig) {}

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS,
    );
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.config.model, input: [text] }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new EmbeddingError(`Embedding service returned HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        data?: Array<{ embedding?: unknown }>;
      };
      const embedding = data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
        throw new EmbeddingError("Embedding service returned an invalid vector");
      }
      return embedding;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError("Embedding request failed", error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Local CPU bridge for the trained SentenceTransformers checkpoint. The Python
 * process receives text only over stdin and returns one JSON vector on stdout;
 * no model call or note content travels over the network.
 */
export class SbertEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly config: SbertEmbeddingClientConfig,
    private readonly runner: SbertEmbeddingRunner = runSbertEmbedding,
  ) {}

  async embed(text: string): Promise<number[]> {
    try {
      return await this.runner(this.config, text);
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError("Local SBERT embedding failed", error);
    }
  }
}

export async function runSbertEmbedding(
  config: SbertEmbeddingClientConfig,
  text: string,
): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    const child = spawn(
      config.pythonPath,
      [config.bridgePath, "--model-path", config.modelPath],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() => reject(new EmbeddingError("Local SBERT embedding timed out")));
    }, config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(() => reject(new EmbeddingError("Could not start local SBERT bridge", error)));
    });
    child.on("close", (code) => {
      settle(() => {
        if (code !== 0) {
          reject(
            new EmbeddingError(
              `Local SBERT bridge exited with code ${code}: ${stderr.trim() || "no error output"}`,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { embeddings?: unknown };
          const vector = Array.isArray(parsed.embeddings) ? parsed.embeddings[0] : undefined;
          if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
            throw new EmbeddingError("Local SBERT bridge returned an invalid vector");
          }
          resolve(vector);
        } catch (error) {
          reject(
            error instanceof EmbeddingError
              ? error
              : new EmbeddingError("Local SBERT bridge returned invalid JSON", error),
          );
        }
      });
    });
    child.stdin.end(JSON.stringify({ texts: [text] }));
  });
}

/** Deterministic lexical stand-in for tests and offline demo paths. */
export class FakeEmbeddingClient implements EmbeddingClient {
  constructor(private readonly dimensions = 128) {}

  async embed(text: string): Promise<number[]> {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    for (const token of tokenize(text)) {
      const digest = createHash("sha256").update(token).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      vector[index] = vector[index]! + 1;
    }
    return vector;
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function summarizeSkill(noteText: string): string {
  const normalized = noteText.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? normalized.slice(0, 177) + "..." : normalized;
}
