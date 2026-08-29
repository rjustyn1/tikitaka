# Consolidator Technical Design

## Component

`apps/server/src/memory/consolidator.ts`

## Purpose

Turn a completed task buffer into candidate memory notes.

The consolidator is an extractor, not a summarizer. It should find durable,
actionable knowledge that matters for future runs and route each note to the
right target Agents.

## Inputs

```ts
interface ConsolidateInput {
  taskBuffer: TaskBuffer;
  group: AgentGroup;
  members: Agent[];
}
```

## Output

```ts
interface CandidateMemoryNote {
  id: string;
  groupTaskId: string;
  content: string;
  severity: "normal" | "severe";
  targetAgentIds: string[];
  description: string;
  sourceRunIds: string[];
  sourceSpanIds: string[];
  rationale: string;
}
```

## Code-Level Spec

Export:

```ts
export class Consolidator {
  constructor(private readonly extractor: ExtractorClient) {}

  consolidate(input: ConsolidateInput): Promise<CandidateMemoryNote[]>;
}
```

Implementation flow:

```ts
async consolidate(input) {
  const request = buildExtractorRequest(input);
  const response = await extractor.extract(request);
  const parsed = parseExtractorJson(response.rawText);
  const candidates = parsed.notes.map((raw) => normalizeCandidate(raw, input));
  return validateCandidates(candidates, input);
}
```

Extractor JSON schema:

```ts
const extractorOutputSchema = z.object({
  notes: z.array(z.object({
    content: z.string().trim().min(1).max(2000),
    severity: z.enum(["normal", "severe"]),
    targetAgentIds: z.array(z.string().uuid()).min(1),
    description: z.string().trim().min(1).max(300),
    sourceRunIds: z.array(z.string().uuid()).min(1),
    sourceSpanIds: z.array(z.string().uuid()).min(1),
    rationale: z.string().trim().max(1000),
  })).max(5),
});
```

Prompt contract:

```text
You are extracting governed memory notes.
Return strict JSON only.
Extract only durable facts, decisions, constraints, or collaboration lessons.
Do not create commands.
Do not route outside the selected group members.
Every note must cite sourceRunIds and sourceSpanIds.
```

Normalization:

```ts
function normalizeCandidate(raw, input): CandidateMemoryNote {
  return {
    id: randomUUID(),
    groupTaskId: input.taskBuffer.groupTaskId,
    ...raw,
  };
}
```

## Extraction Rules

- Extract declarative facts, constraints, decisions, and reusable task lessons.
- Do not extract random chat, status updates, or one-off implementation detail.
- Do not rewrite an Agent's role.
- Route only to selected group members unless a human later edits routing.
- Every note must cite source run IDs and span IDs.
- Cap first version to at most five notes per task.

## Validation

Reject candidate notes when:

- content is empty;
- target agents are outside the source group;
- source span IDs do not exist in the task buffer;
- description is missing for a normal note;
- severe note has no concrete hard constraint;
- output exceeds the note cap.

## Failure Behavior

If extraction fails or returns invalid JSON, produce zero notes and let the group
task remain completed. Memory must fail open.

## Tests

- extracts multiple targeted notes from a fixture task buffer;
- rejects notes targeting out-of-group Agents;
- rejects notes with missing source span IDs;
- caps notes at five;
- returns zero notes on malformed extractor output.
