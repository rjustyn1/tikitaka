// Extractor client: the model call behind a tiny interface, so consolidator.ts
// stays testable and the demo can run offline. Three backends: ark (real),
// fake (deterministic offline), off (disabled). See components/EXTRACTOR-CLIENT.md.

export interface ExtractorClient {
  extract(input: ExtractorRequest): Promise<ExtractorResponse>;
}

export interface ExtractorRequest {
  system: string;
  prompt: string;
  timeoutMs: number;
}

export interface ExtractorResponse {
  rawText: string;
}

/**
 * STUB SEAM (Person 1 / config.ts).
 *
 * This is the narrow slice of AppConfig the extractor needs. Once Person 1 adds
 * `memoryExtractor` and `memoryExtractTimeoutMs` to AppConfig, the real config
 * object structurally satisfies this interface and can be passed directly to
 * `createExtractorClient` with no change here. Until then, use
 * `memoryConfigFromEnv()` below.
 */
export interface MemoryConfig {
  memoryExtractor: "ark" | "fake" | "off";
  memoryExtractTimeoutMs: number;
  arkApiKey: string;
  arkModel: string;
  arkBaseUrl: string;
}

/**
 * STUB adapter: reads the memory config straight from the environment until
 * Person 1 lands the keys on AppConfig. Delete this and pass the real AppConfig
 * once `config.memoryExtractor` / `config.memoryExtractTimeoutMs` exist.
 */
export function memoryConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MemoryConfig {
  const extractor = env.MEMORY_EXTRACTOR;
  return {
    memoryExtractor:
      extractor === "ark" || extractor === "off" ? extractor : "fake",
    memoryExtractTimeoutMs: Number(env.MEMORY_EXTRACT_TIMEOUT_MS ?? 30_000),
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: (
      env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3"
    ).replace(/\/+$/, ""),
  };
}

export class ExtractorError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ExtractorError";
  }
}

export function createExtractorClient(config: MemoryConfig): ExtractorClient {
  if (config.memoryExtractor === "off") return new OffExtractorClient();
  if (config.memoryExtractor === "fake") return new FakeExtractorClient();
  return new ArkExtractorClient(config);
}

export class OffExtractorClient implements ExtractorClient {
  async extract(): Promise<ExtractorResponse> {
    return { rawText: JSON.stringify({ notes: [] }) };
  }
}

export class ArkExtractorClient implements ExtractorClient {
  constructor(private readonly config: MemoryConfig) {}

  async extract(input: ExtractorRequest): Promise<ExtractorResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await fetch(`${this.config.arkBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.arkApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.arkModel,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.prompt },
          ],
          temperature: 0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ExtractorError(
          `Ark extractor returned HTTP ${response.status}`,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return { rawText: data.choices?.[0]?.message?.content ?? "" };
    } catch (error) {
      if (error instanceof ExtractorError) throw error;
      throw new ExtractorError("Ark extractor request failed", error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Deterministic offline extractor for tests and demo.
 *
 * It parses the identifiers the consolidator embeds in the prompt (agent IDs it
 * may target, and the run/span IDs it must cite) and emits canned-but-valid
 * notes wired to REAL ids from the buffer, so the notes survive consolidator
 * validation and can actually land during the demo. If it cannot find the
 * identifiers, it safely returns zero notes.
 */
export class FakeExtractorClient implements ExtractorClient {
  async extract(input: ExtractorRequest): Promise<ExtractorResponse> {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

    const agentIds = collectSection(input.prompt, "Agents you may target", uuid);
    const runIds = collectAll(input.prompt, /\brun ([0-9a-f-]{36})/gi);
    const spanIds = collectAll(input.prompt, /\bspans? ([0-9a-f-]{36})/gi);

    if (agentIds.length === 0 || runIds.length === 0 || spanIds.length === 0) {
      return { rawText: JSON.stringify({ notes: [] }) };
    }

    const notes = [
      {
        content:
          "The upload endpoint must reject files larger than 10MB and return HTTP 413.",
        severity: "severe",
        targetAgentIds: [agentIds[0]],
        description:
          "Hard size limit and error contract for the file upload endpoint.",
        sourceRunIds: [runIds[0]],
        sourceSpanIds: [spanIds[0]],
        rationale: "Backend fixed this constraint during the task.",
      },
    ];

    if (agentIds.length > 1) {
      notes.push({
        content:
          "Uploaded object keys are namespaced per user as uploads/{userId}/{uuid}.",
        severity: "normal",
        targetAgentIds: [agentIds[1]],
        description: "Storage key layout for uploaded files.",
        sourceRunIds: [runIds[0]],
        sourceSpanIds: [spanIds[spanIds.length > 1 ? 1 : 0]],
        rationale: "Agreed storage convention worth reusing.",
      });
    }

    return { rawText: JSON.stringify({ notes }) };
  }
}

function collectAll(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(regex)) {
    if (match[1]) out.push(match[1]);
  }
  return dedupe(out);
}

/** Collect UUIDs that appear under a named "## <heading>" section of the prompt. */
function collectSection(text: string, heading: string, uuid: RegExp): string[] {
  const start = text.indexOf(heading);
  if (start === -1) return [];
  const rest = text.slice(start);
  const nextHeading = rest.indexOf("\n##", heading.length);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return dedupe(section.match(uuid) ?? []);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
