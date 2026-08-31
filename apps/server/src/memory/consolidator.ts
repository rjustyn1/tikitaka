// Consolidator: turns a completed task buffer into candidate memory notes.
//
// It is an extractor, not a summarizer — it finds durable, actionable knowledge
// but never routes them. Recognition happens after extraction. It fails OPEN: any parse or
// extraction failure yields zero notes and leaves the group task completed.
// See components/CONSOLIDATOR.md.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent, AgentGroup } from "../types.js";
import type { CandidateMemoryNote, SegmentBuffer } from "./types.js";
import type { ExtractorClient, ExtractorRequest } from "./extractor-client.js";

export interface ConsolidateInput {
  segmentBuffer: SegmentBuffer;
  group: AgentGroup;
  members: Agent[];
}

// A segment spans several tasks, so it carries more durable material than a
// single task did. Raised from 5 alongside the move to segment consolidation.
const MAX_NOTES = 8;

const SYSTEM_PROMPT = [
  "You extract governed memory notes from a completed multi-agent task. These",
  "notes become durable memory that agents may re-read on FUTURE tasks,",
  "so extract reusable facts/decisions/constraints/lessons — not a play-by-play",
  "of this task. Write declarative facts, never commands.",
  "",
  "Return ONLY a JSON object, no markdown fences, of this exact shape:",
  "{",
  '  "notes": [',
  "    {",
  '      "content": "<the durable fact, declarative, <=2000 chars>",',
  '      "severity": "normal" | "severe",',
  '      "skillKey": "<lowercase kebab-case skill key, 3-64 chars>",',
  '      "description": "<short trigger describing when this applies, <=300 chars>",',
  '      "sourceRunIndices": [<a run number shown under Node outputs, e.g. 1>],',
  '      "sourceSpanIndices": [<a span number shown under Node outputs, e.g. 2>],',
  '      "rationale": "<why this is worth remembering>"',
  "    }",
  "  ]",
  "}",
  "",
  "Rules for EVERY note (all fields are required):",
  '- severity: "severe" for hard constraints that must never be missed (they',
  "  land as always-on memory); otherwise \"normal\".",
  "- skillKey: name the reusable topic, not this task or an Agent. Use only",
  "  lowercase letters, numbers and hyphens; it is a key, never a file path.",
  "- description: this is the relevance trigger — the target agent loads the note",
  "  when a future task matches it, so make it specific.",
  "- sourceRunIndices / sourceSpanIndices: cite provenance by the SHORT INTEGER",
  "  numbers shown under 'Node outputs' as 'run N' and '[span N]'. Use the small",
  "  numbers only — do not copy any long id strings.",
  "- Return at most 8 notes. If nothing is durable, return { \"notes\": [] }.",
].join("\n");

// Lenient on shape (real models omit fields or format ids loosely); we fill
// defaults in normalizeCandidate and filter provenance in validateCandidates,
// so a slightly-off response still yields usable notes instead of zero. Array
// length is capped after validation, not here. Memory fails open.
const extractorOutputSchema = z.object({
  notes: z.array(
    z.object({
      content: z.string().trim().min(1).max(2000),
      severity: z.enum(["normal", "severe"]).optional(),
      skillKey: z.string().trim().optional(),
      description: z.string().trim().max(300).optional(),
      // Provenance is cited by 1-based integer index into the buffer's runs and
      // spans (see collectSources / buildExtractorRequest). z.coerce tolerates a
      // model that returns the number as a string ("2"); non-integers are
      // dropped, and out-of-range indices resolve to nothing in normalizeCandidate.
      sourceRunIndices: z.array(z.coerce.number().int().positive()).optional(),
      sourceSpanIndices: z.array(z.coerce.number().int().positive()).optional(),
      rationale: z.string().trim().max(1000).optional(),
    }),
  ),
});

/** Fallback when no timeout is configured. Large multi-node prompts are slow. */
const DEFAULT_EXTRACT_TIMEOUT_MS = 120_000;

export class Consolidator {
  constructor(
    private readonly extractor: ExtractorClient,
    private readonly timeoutMs: number = DEFAULT_EXTRACT_TIMEOUT_MS,
  ) {}

  async consolidate(input: ConsolidateInput): Promise<CandidateMemoryNote[]> {
    let rawText: string;
    try {
      const response = await this.extractor.extract(
        buildExtractorRequest(input, this.timeoutMs),
      );
      rawText = response.rawText;
    } catch {
      return [];
    }

    const parsed = parseExtractorJson(rawText);
    if (!parsed) return [];

    const sources = collectSources(input.segmentBuffer);
    const candidates = parsed.notes.map((raw) =>
      normalizeCandidate(raw, input, sources),
    );
    return validateCandidates(candidates, input).slice(0, MAX_NOTES);
  }
}

/** Run and span ids in first-appearance order; array position + 1 is the index
 * the extractor prompt shows and the model cites back. Built once and used both
 * to render the prompt and to resolve cited indices back to real ids. */
interface BufferSources {
  runIds: string[];
  spanIds: string[];
}

function collectSources(segmentBuffer: SegmentBuffer): BufferSources {
  const runIds: string[] = [];
  const spanIds: string[] = [];
  for (const entry of segmentBuffer.entries) {
    if (entry.runId && !runIds.includes(entry.runId)) runIds.push(entry.runId);
    for (const span of entry.spans) {
      if (!spanIds.includes(span.id)) spanIds.push(span.id);
    }
  }
  return { runIds, spanIds };
}

export function buildExtractorRequest(
  input: ConsolidateInput,
  timeoutMs: number = DEFAULT_EXTRACT_TIMEOUT_MS,
): ExtractorRequest {
  const { segmentBuffer } = input;
  const sources = collectSources(segmentBuffer);
  // 1-based so "run 1"/"[span 1]" reads naturally; 0 means not found.
  const spanIndexOf = (id: string) => sources.spanIds.indexOf(id) + 1;

  const nodeBlocks = segmentBuffer.entries
    .map((entry) => {
      const runIndex = entry.runId ? sources.runIds.indexOf(entry.runId) + 1 : 0;
      const spanNums = entry.spans.map((span) => spanIndexOf(span.id));
      const header =
        `- node ${entry.planNodeId} (role ${entry.nodeRole}, agent ${entry.agentId}): ` +
        `run ${runIndex > 0 ? runIndex : "none"}; spans ${
          spanNums.length > 0 ? spanNums.join(", ") : "none"
        }`;
      const spanDetail = entry.spans
        .map(
          (span) =>
            `    - [span ${spanIndexOf(span.id)}] ${span.type}: ${spanText(span)}`,
        )
        .join("\n");
      return [header, `  output: ${entry.output}`, spanDetail]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const promptLines = segmentBuffer.prompts
    .map((text, index) => `${index + 1}. ${text}`)
    .join("\n");

  // The transcript is the conversation the notes are about; node outputs remain
  // the citable provenance. Both are shown, and the headings say which is which,
  // so the model does not try to cite a chat line as a run index.
  const transcriptLines = segmentBuffer.transcript
    .map((line) => {
      const speaker =
        line.speakerType === "human"
          ? "User"
          : `Agent ${line.agentId ?? ""}`.trim();
      return `${speaker}: ${line.content}`;
    })
    .join("\n");

  const prompt = [
    "# Topic",
    "These requests were all part of one continuous topic:",
    promptLines,
    "",
    "## Group chat transcript",
    "The conversation to extract from. Not citable as provenance.",
    transcriptLines || "(no messages)",
    "",
    "## Node outputs",
    "Cite provenance from here, by the run and span numbers shown.",
    nodeBlocks,
  ].join("\n");

  return {
    system: SYSTEM_PROMPT,
    prompt,
    timeoutMs,
  };
}

function spanText(span: { payload: unknown }): string {
  const payload = span.payload as Record<string, unknown>;
  if (typeof payload?.text === "string") return payload.text;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.command === "string") return String(payload.command);
  return "";
}

export function parseExtractorJson(
  rawText: string,
): z.infer<typeof extractorOutputSchema> | null {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const json = JSON.parse(stripped);
    const result = extractorOutputSchema.safeParse(json);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function normalizeCandidate(
  raw: z.infer<typeof extractorOutputSchema>["notes"][number],
  input: ConsolidateInput,
  sources: BufferSources,
): CandidateMemoryNote {
  const content = raw.content.trim();
  // Resolve the model's 1-based indices back to real run/span UUIDs. An
  // out-of-range or duplicate index resolves to nothing and is dropped here;
  // validateCandidates then re-checks the survivors against the real buffer.
  const resolve = (indices: number[] | undefined, ids: string[]): string[] => {
    const out = (indices ?? [])
      .map((index) => ids[index - 1])
      .filter((id): id is string => Boolean(id));
    return [...new Set(out)];
  };
  return {
    id: randomUUID(),
    segmentId: input.segmentBuffer.segmentId,
    // Kept as the segment's LAST task so review, ledger, landing and every
    // existing per-task query keep resolving. segmentId is the real owner.
    groupTaskId:
      input.segmentBuffer.groupTaskIds[
        input.segmentBuffer.groupTaskIds.length - 1
      ] ?? "",
    content,
    severity: raw.severity ?? "normal",
    // Recognition supplies recipients after extraction. The consolidator never
    // makes an access-control decision.
    targetAgentIds: [],
    skillKey: raw.skillKey?.trim() ?? "",
    description:
      raw.description?.trim() ||
      (content.length > 120 ? content.slice(0, 117) + "…" : content),
    sourceRunIds: resolve(raw.sourceRunIndices, sources.runIds),
    sourceSpanIds: resolve(raw.sourceSpanIndices, sources.spanIds),
    rationale: raw.rationale?.trim() ?? "",
  };
}

/**
 * Turn raw candidates into safe ones:
 * - provenance: filter cited run/span ids down to ones that actually exist in
 *   the buffer, rather than discarding the whole note for one bad id.
 */
export function validateCandidates(
  candidates: CandidateMemoryNote[],
  input: ConsolidateInput,
): CandidateMemoryNote[] {
  const spanIds = new Set(
    input.segmentBuffer.entries.flatMap((entry) => entry.spans.map((s) => s.id)),
  );
  const runIds = new Set(
    input.segmentBuffer.entries
      .map((entry) => entry.runId)
      .filter((id): id is string => Boolean(id)),
  );

  const result: CandidateMemoryNote[] = [];
  for (const note of candidates) {
    if (!isValidSkillKey(note.skillKey)) continue;
    result.push({
      ...note,
      sourceSpanIds: note.sourceSpanIds.filter((id) => spanIds.has(id)),
      sourceRunIds: note.sourceRunIds.filter((id) => runIds.has(id)),
    });
  }
  return result;
}

export function isValidSkillKey(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value);
}
