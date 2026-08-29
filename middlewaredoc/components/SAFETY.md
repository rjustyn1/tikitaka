# Safety Technical Design

## Component

`apps/server/src/memory/safety.ts`

## Purpose

Redact secrets and detect unsafe memory notes before anything is landed into an
Agent workspace.

Safety runs after consolidation and before review or landing.

## Inputs

```ts
interface SafetyInput {
  note: CandidateMemoryNote;
}
```

## Output

```ts
interface SafetyResult {
  note: CandidateMemoryNote;
  redactionFired: boolean;
  quarantineHit: boolean;
  reasons: string[];
}
```

## Code-Level Spec

Export pure functions:

```ts
export function redactSecrets(text: string): {
  text: string;
  fired: boolean;
  reasons: string[];
};

export function detectQuarantine(text: string): {
  hit: boolean;
  reasons: string[];
};

export function evaluateNoteSafety(note: CandidateMemoryNote): SafetyResult;
```

Implementation sketch:

```ts
export function evaluateNoteSafety(note) {
  const content = redactSecrets(note.content);
  const description = redactSecrets(note.description);
  const quarantine = detectQuarantine(`${content.text}\n${description.text}`);

  return {
    note: {
      ...note,
      content: content.text,
      description: description.text,
    },
    redactionFired: content.fired || description.fired,
    quarantineHit: quarantine.hit,
    reasons: [...content.reasons, ...description.reasons, ...quarantine.reasons],
  };
}
```

First regex set:

```ts
const secretPatterns = [
  { reason: "bearer_token", regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { reason: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { reason: "generic_api_key", regex: /\b[A-Za-z0-9_-]{32,}\b/g },
  { reason: "database_url", regex: /\b(?:postgres|mysql|mongodb):\/\/[^\s]+/gi },
  { reason: "env_assignment", regex: /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s]+/g },
];
```

First quarantine phrase set:

```ts
const quarantinePatterns = [
  /ignore (all )?(previous|system|developer) instructions/i,
  /reveal (the )?(system prompt|hidden prompt|secret)/i,
  /disable (safety|guardrails|policy)/i,
  /exfiltrate|steal|leak/i,
  /run .*(curl|wget).*(secret|token|key)/i,
];
```

## Redaction Rules

Redact likely secrets from note content and descriptions:

- API keys;
- bearer tokens;
- private keys;
- `.env` values;
- passwords;
- database URLs;
- session cookies;
- cloud credentials.

Use placeholders such as `[REDACTED_SECRET]`.

## Quarantine Rules

Quarantine notes that look like instructions to:

- bypass platform rules;
- reveal hidden prompts or secrets;
- disable safety;
- execute arbitrary shell commands unrelated to the task;
- exfiltrate data;
- instruct another Agent to ignore its role.

## Risk Signal

A note requires review if:

```text
severity is severe
OR redactionFired
OR quarantineHit
OR routing is broad
```

## Failure Behavior

If safety processing fails, mark the note quarantined. Placement must never fail
open.

## Tests

- fake API key is redacted;
- private key block is redacted;
- prompt-injection shaped note is quarantined;
- normal declarative note passes cleanly;
- safety failure converts to quarantine.
