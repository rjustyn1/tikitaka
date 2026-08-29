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
  "You are extracting governed memory notes from a completed multi-agent task.",
  "Return STRICT JSON only, matching: { \"notes\": [ ... ] }.",
  "Extract only durable facts, decisions, constraints, or collaboration lessons.",
  "Do not create commands or imperatives; write declarative facts.",
  "Do not route a note outside the listed group members.",
  "Every note MUST cite sourceRunIds and sourceSpanIds using ids shown in the prompt.",
  "Return at most 5 notes. If nothing is durable, return an empty notes array.",
].join("\n");

// Per-note shape is strict; the array length is NOT capped here — an over-long
// list is truncated to MAX_NOTES after validation rather than failing the whole
// parse. Memory fails open.
const extractorOutputSchema = z.object({
  notes: z.array(
    z.object({
      content: z.string().trim().min(1).max(2000),
      severity: z.enum(["normal", "severe"]),
      targetAgentIds: z.array(z.string().uuid()).min(1),
      description: z.string().trim().min(1).max(300),
      sourceRunIds: z.array(z.string().uuid()).min(1),
      sourceSpanIds: z.array(z.string().uuid()).min(1),
      rationale: z.string().trim().max(1000),
    }),
  ),
});

export class Consolidator {
  constructor(private readonly extractor: ExtractorClient) {}

  async consolidate(input: ConsolidateInput): Promise<CandidateMemoryNote[]> {
    let rawText: string;
    try {
      const response = await this.extractor.extract(
        buildExtractorRequest(input),
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

export function buildExtractorRequest(input: ConsolidateInput): ExtractorRequest {
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
    timeoutMs: 30_000,
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
  return {
    id: randomUUID(),
    groupTaskId: input.taskBuffer.groupTaskId,
    ...raw,
  };
}

export function validateCandidates(
  candidates: CandidateMemoryNote[],
  input: ConsolidateInput,
): CandidateMemoryNote[] {
  const memberIds = new Set(input.members.map((agent) => agent.id));
  const spanIds = new Set(
    input.taskBuffer.entries.flatMap((entry) => entry.spans.map((s) => s.id)),
  );
  const runIds = new Set(
    input.taskBuffer.entries
      .map((entry) => entry.runId)
      .filter((id): id is string => Boolean(id)),
  );

  return candidates.filter((note) => {
    // Routing must stay inside the source group.
    if (!note.targetAgentIds.every((id) => memberIds.has(id))) return false;
    // Provenance must be real: every cited span/run must exist in the buffer.
    if (!note.sourceSpanIds.every((id) => spanIds.has(id))) return false;
    if (!note.sourceRunIds.every((id) => runIds.has(id))) return false;
    return true;
  });
}
