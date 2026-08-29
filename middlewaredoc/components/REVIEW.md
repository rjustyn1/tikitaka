# Review Technical Design

## Component

`apps/server/src/memory/review.ts`

## Purpose

Decide whether a candidate memory note can auto-activate or needs human review,
then apply approve, edit, reject, and revoke actions.

## State Machine

```text
candidate
  -> active       clean normal note auto-lands
  -> pending      human review required
  -> quarantined  unsafe note, human review required

pending/quarantined
  -> active       approve or edit+approve
  -> rejected

active
  -> revoked
```

## Review Actions

```ts
type ReviewAction =
  | { type: "approve"; reviewerName: string }
  | { type: "edit"; reviewerName: string; patch: MemoryNotePatch }
  | { type: "reject"; reviewerName: string; reason: string }
  | { type: "revoke"; reviewerName: string; reason: string };
```

## Code-Level Spec

Export:

```ts
export class ReviewService {
  constructor(
    private readonly store: JsonStore,
    private readonly landing: LandingService,
    private readonly ledger: LedgerService,
  ) {}

  processCandidate(note: CandidateMemoryNote, safety: SafetyResult): Promise<MemoryNote>;
  approve(noteId: string, input: ApproveNoteInput): Promise<MemoryNote>;
  edit(noteId: string, input: EditNoteInput): Promise<MemoryNote>;
  reject(noteId: string, input: RejectNoteInput): Promise<MemoryNote>;
  revoke(noteId: string, input: RevokeNoteInput): Promise<MemoryNote>;
}
```

Input schemas:

```ts
interface ApproveNoteInput {
  reviewerName: string;
}

interface EditNoteInput {
  reviewerName: string;
  content?: string;
  severity?: MemorySeverity;
  targetAgentIds?: string[];
  description?: string;
  approveAfterEdit?: boolean;
}

interface RejectNoteInput {
  reviewerName: string;
  reason: string;
}

interface RevokeNoteInput {
  reviewerName: string;
  reason: string;
}
```

Review requirement:

```ts
function requiresHumanReview(note: CandidateMemoryNote, safety: SafetyResult): boolean {
  return (
    note.severity === "severe" ||
    safety.redactionFired ||
    safety.quarantineHit ||
    note.targetAgentIds.length > 2
  );
}
```

`processCandidate()`:

```ts
// create MemoryNote with safety fields
// if requiresHumanReview -> status pending/quarantined
// else call landing.landMemory() and mark active
// always call ledger for granted and withheld decisions
```

## Editable Fields

- `content`
- `severity`
- `targetAgentIds`
- `description`

Routing edits may narrow or adjust within the source group. They must not widen
outside the source group without an explicit future policy change.

## Connections

- calls `landing.ts` on approve/edit+approve;
- calls `landing.ts` revoke path on revoke;
- calls `ledger.ts` for every decision;
- never writes workspace files directly.

## Failure Behavior

If review succeeds but landing fails, keep the note pending and record the
landing error. Do not mark it active unless files were written successfully.

## Tests

- clean normal note auto-activates;
- severe note goes pending;
- redacted note goes pending;
- quarantined note cannot auto-activate;
- approve lands files;
- revoke deletes files and records ledger entry.
