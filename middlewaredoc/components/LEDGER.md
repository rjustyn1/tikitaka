# Ledger Technical Design

## Component

`apps/server/src/memory/ledger.ts`

## Purpose

Record grant, withholding, review, landing, and revoke decisions.

The ledger is the audit layer that proves who received a memory and who did not.

## Ledger Record

```ts
interface GrantRecord {
  id: string;
  groupTaskId: string;
  noteId: string;
  agentId: string;
  decision: "granted" | "withheld" | "rejected" | "revoked";
  reason: string;
  filePath: string | null;
  reviewerName: string | null;
  createdAt: string;
}
```

## Code-Level Spec

Export:

```ts
export class LedgerService {
  constructor(private readonly store: JsonStore) {}

  recordGrant(input: RecordGrantInput): Promise<GrantRecord>;
  recordWithheld(input: RecordWithheldInput): Promise<GrantRecord>;
  recordRejected(input: RecordRejectedInput): Promise<GrantRecord[]>;
  recordRevoked(input: RecordRevokedInput): Promise<GrantRecord[]>;
  listTaskGrants(groupTaskId: string): GrantRecord[];
  listNoteGrants(noteId: string): GrantRecord[];
}
```

Input types:

```ts
interface RecordGrantInput {
  groupTaskId: string;
  noteId: string;
  agentId: string;
  filePath: string;
  reviewerName?: string | null;
}

interface RecordWithheldInput {
  groupTaskId: string;
  noteId: string;
  agentId: string;
  reason: GrantRecord["reason"];
  reviewerName?: string | null;
}

interface RecordRejectedInput {
  groupTaskId: string;
  noteId: string;
  candidateAgentIds: string[];
  reviewerName: string;
  reason: string;
}

interface RecordRevokedInput {
  groupTaskId: string;
  noteId: string;
  grantedAgentIds: string[];
  reviewerName: string;
  reason: string;
}
```

Grant/withheld creation:

```ts
function buildGrantRecord(input): GrantRecord {
  return {
    id: randomUUID(),
    groupTaskId: input.groupTaskId,
    noteId: input.noteId,
    agentId: input.agentId,
    decision: input.decision,
    reason: input.reason,
    filePath: input.filePath ?? null,
    reviewerName: input.reviewerName ?? null,
    createdAt: now(),
  };
}
```

## Withholding Reasons

```text
out_of_group
not_targeted
private
quarantined
rejected
revoked
landing_failed
```

## Rules

- Write one record per Agent per note decision.
- Record both grants and denials.
- Keep records append-only.
- Do not use ledger state as the enforcement boundary.
- Enforcement is file presence in the target Agent workspace.

## Connections

- `consolidator.ts` provides source note and routing.
- `review.ts` records review decisions.
- `landing.ts` returns file paths for grant records.
- API routes expose task and note ledger views.

## Tests

- records grant for target Agent;
- records `out_of_group` for non-member;
- records `not_targeted` for member not routed;
- records revoke without deleting old grant record;
- ledger is append-only.
