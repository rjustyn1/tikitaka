// Consolidator: turns a completed task buffer into candidate memory notes.
//
// It is an extractor, not a summarizer — it finds durable, actionable knowledge
// and routes each note to the right target Agents. It fails OPEN: any parse or
// extraction failure yields zero notes and leaves the group task completed.
// See components/CONSOLIDATOR.md.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Agent, AgentGroup } from "../types.js";
import type { CandidateMemoryNote, TaskBuffer } from "./types.js";
import type { ExtractorClient, ExtractorRequest } from "./extractor-client.js";

export interface ConsolidateInput {
  taskBuffer: TaskBuffer;
  group: AgentGroup;
  members: Agent[];
}

const MAX_NOTES = 5;

const SYSTEM_PROMPT = [
  "You extract governed memory notes from a completed multi-agent task. These",
  "notes become durable memory that the target agents re-read on FUTURE tasks,",
  "so extract reusable facts/decisions/constraints/lessons — not a play-by-play",
  "of this task. Write declarative facts, never commands.",
  "",
  "Return ONLY a JSON object, no markdown fences, of this exact shape:",
  "{",
  '  "notes": [',
  "    {",
  '      "content": "<the durable fact, declarative, <=2000 chars>",',
  '      "severity": "normal" | "severe",',
  '      "targetAgentIds": ["<agent id from the Agents list below>"],',
  '      "description": "<short trigger describing when this applies, <=300 chars>",',
  '      "sourceRunIds": ["<a run id shown under Node outputs>"],',
  '      "sourceSpanIds": ["<a span id shown under Node outputs>"],',
  '      "rationale": "<why this is worth remembering>"',
  "    }",
  "  ]",
  "}",
  "",
  "Rules for EVERY note (all fields are required):",
  '- severity: "severe" for hard constraints that must never be missed (they',
  "  land as always-on memory); otherwise \"normal\".",
  "- targetAgentIds: pick one or more ids from the 'Agents you may target' list.",
  "  Route to the agent(s) who will benefit on future work. Never invent ids.",
  "- description: this is the relevance trigger — the target agent loads the note",
  "  when a future task matches it, so make it specific.",
  "- sourceRunIds / sourceSpanIds: copy the real ids shown under 'Node outputs'.",
  "- Return at most 5 notes. If nothing is durable, return { \"notes\": [] }.",
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
      targetAgentIds: z.array(z.string()).optional(),
      description: z.string().trim().max(300).optional(),
      sourceRunIds: z.array(z.string()).optional(),
      sourceSpanIds: z.array(z.string()).optional(),
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

    const candidates = parsed.notes.map((raw) => normalizeCandidate(raw, input));
    return validateCandidates(candidates, input).slice(0, MAX_NOTES);
  }
}

export function buildExtractorRequest(
  input: ConsolidateInput,
  timeoutMs: number = DEFAULT_EXTRACT_TIMEOUT_MS,
): ExtractorRequest {
  const { taskBuffer, members } = input;

  const agentLines = members
    .map((agent) => `- ${agent.id}  (${agent.name})`)
    .join("\n");

  const nodeBlocks = taskBuffer.entries
    .map((entry) => {
      const spanIds = entry.spans.map((span) => span.id);
      const header =
        `- node ${entry.planNodeId} (role ${entry.nodeRole}, agent ${entry.agentId}): ` +
        `run ${entry.runId || "none"}; spans ${
          spanIds.length > 0 ? spanIds.join(", ") : "none"
        }`;
      const spanDetail = entry.spans
        .map((span) => `    - [${span.id}] ${span.type}: ${spanText(span)}`)
        .join("\n");
      return [header, `  output: ${entry.output}`, spanDetail]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const prompt = [
    "# Task",
    taskBuffer.prompt,
    "",
    "## Agents you may target",
    agentLines,
    "",
    "## Node outputs",
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
): CandidateMemoryNote {
  const content = raw.content.trim();
  return {
    id: randomUUID(),
    groupTaskId: input.taskBuffer.groupTaskId,
    content,
    severity: raw.severity ?? "normal",
    // Routing is resolved (filtered to members / defaulted) in validateCandidates.
    targetAgentIds: raw.targetAgentIds ?? [],
    description:
      raw.description?.trim() ||
      (content.length > 120 ? content.slice(0, 117) + "…" : content),
    sourceRunIds: raw.sourceRunIds ?? [],
    sourceSpanIds: raw.sourceSpanIds ?? [],
    rationale: raw.rationale?.trim() ?? "",
  };
}

/**
 * Turn raw candidates into safe ones:
 * - routing: keep only in-group targets; if the model gave targets but ALL are
 *   out-of-group, drop the note (a real routing error); if it gave none, default
 *   to the whole group (which trips broad-routing review, so a human decides).
 * - provenance: filter cited run/span ids down to ones that actually exist in
 *   the buffer, rather than discarding the whole note for one bad id.
 */
export function validateCandidates(
  candidates: CandidateMemoryNote[],
  input: ConsolidateInput,
): CandidateMemoryNote[] {
  const memberIds = input.members.map((agent) => agent.id);
  const memberSet = new Set(memberIds);
  const spanIds = new Set(
    input.taskBuffer.entries.flatMap((entry) => entry.spans.map((s) => s.id)),
  );
  const runIds = new Set(
    input.taskBuffer.entries
      .map((entry) => entry.runId)
      .filter((id): id is string => Boolean(id)),
  );

  const result: CandidateMemoryNote[] = [];
  for (const note of candidates) {
    const inGroup = note.targetAgentIds.filter((id) => memberSet.has(id));
    if (note.targetAgentIds.length > 0 && inGroup.length === 0) {
      continue; // model tried to route entirely out of group — drop it
    }
    result.push({
      ...note,
      targetAgentIds: inGroup.length > 0 ? inGroup : [...memberIds],
      sourceSpanIds: note.sourceSpanIds.filter((id) => spanIds.has(id)),
      sourceRunIds: note.sourceRunIds.filter((id) => runIds.has(id)),
    });
  }
  return result;
}
