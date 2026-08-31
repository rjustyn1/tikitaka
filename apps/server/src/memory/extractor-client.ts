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
 * The narrow slice of AppConfig the extractor needs. AppConfig is a structural
 * superset of this, so the real config object is passed straight into
 * `createExtractorClient` (see index.ts). Kept as its own interface so the
 * extractor has no dependency on the full config module.
 */
export interface MemoryConfig {
  /** Master runtime switch for governed-memory processing. */
  memoryEnabled?: boolean;
  memoryExtractor: "ark" | "fake" | "off";
  memoryExtractTimeoutMs: number;
  arkApiKey: string;
  arkModel: string;
  arkBaseUrl: string;
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
 * TEST/DEMO ONLY — NOT a real extractor.
 *
 * This client does NO language understanding. Its two notes are hardcoded and
 * TOPIC-BLIND: it emits the same canned upload-feature text regardless of what
 * the task was actually about, as long as it can find the identifiers the
 * consolidator embeds in the prompt. Never read its output as real extraction.
 *
 * It exists so `npm run check` runs offline and the demo works without a live
 * model. It parses only short run/span indices (provenance); routing belongs to
 * the recognition layer, not extraction. If it cannot find provenance, it
 * safely returns zero notes.
 */
export class FakeExtractorClient implements ExtractorClient {
  async extract(input: ExtractorRequest): Promise<ExtractorResponse> {
    // Provenance is now cited by the short integer indices the prompt prints as
    // `run N` and `[span N]`, not by echoing UUIDs. See consolidator.ts.
    const runIndices = collectInts(input.prompt, /\brun (\d+)/gi);
    const spanIndices = collectInts(input.prompt, /\[span (\d+)\]/gi);

    if (
      runIndices.length === 0 ||
      spanIndices.length === 0
    ) {
      return { rawText: JSON.stringify({ notes: [] }) };
    }

    const notes = [
      {
        content:
          "The upload endpoint must reject files larger than 10MB and return HTTP 413.",
        severity: "severe",
        skillKey: "upload-size-limits",
        description:
          "Hard size limit and error contract for the file upload endpoint.",
        sourceRunIndices: [runIndices[0]],
        sourceSpanIndices: [spanIndices[0]],
        rationale: "Backend fixed this constraint during the task.",
      },
    ];

    notes.push({
      content:
        "Uploaded object keys are namespaced per user as uploads/{userId}/{uuid}.",
      severity: "normal",
      skillKey: "upload-storage-keys",
      description: "Storage key layout for uploaded files.",
      sourceRunIndices: [runIndices[0]],
      sourceSpanIndices: [spanIndices[spanIndices.length > 1 ? 1 : 0]],
      rationale: "Agreed storage convention worth reusing.",
    });

    return { rawText: JSON.stringify({ notes }) };
  }
}

/** Collect the first capture group of every match as a deduped integer list. */
function collectInts(text: string, regex: RegExp): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(regex)) {
    if (match[1]) out.push(Number(match[1]));
  }
  return [...new Set(out)];
}
