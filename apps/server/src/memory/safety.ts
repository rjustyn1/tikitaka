// Safety: redact secrets and detect prompt-injection shapes in candidate notes
// BEFORE anything is landed into an Agent workspace. Pure and fixture-driven.
//
// This is the recall-tuned half of the trust boundary: it is backed by the
// human gate (a redaction hit or quarantine hit forces review), so it is tuned
// to over-catch rather than to be precise. See components/SAFETY.md.

import type { CandidateMemoryNote, SafetyResult } from "./types.js";

const REDACTION_PLACEHOLDER = "[REDACTED_SECRET]";

const secretPatterns: Array<{ reason: string; regex: RegExp }> = [
  { reason: "bearer_token", regex: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  {
    reason: "private_key",
    regex:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { reason: "database_url", regex: /\b(?:postgres|mysql|mongodb):\/\/[^\s]+/gi },
  { reason: "env_assignment", regex: /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s]+/g },
  // Broad on purpose (recall-tuned, backed by HITL): a long unbroken run of
  // key-like characters. Ordered last so more specific patterns win their span.
  { reason: "generic_api_key", regex: /\b[A-Za-z0-9_-]{32,}\b/g },
];

const quarantinePatterns: Array<{ reason: string; regex: RegExp }> = [
  {
    reason: "override_instructions",
    regex: /ignore (all )?(previous|system|developer) instructions/i,
  },
  {
    reason: "reveal_secret",
    regex: /reveal (the )?(system prompt|hidden prompt|secret)/i,
  },
  { reason: "disable_safety", regex: /disable (safety|guardrails|policy)/i },
  { reason: "exfiltration", regex: /exfiltrate|steal|leak/i },
  {
    reason: "shell_exfiltration",
    regex: /run .*(curl|wget).*(secret|token|key)/i,
  },
];

export function redactSecrets(text: string): {
  text: string;
  fired: boolean;
  reasons: string[];
} {
  let output = text;
  let fired = false;
  const reasons: string[] = [];

  for (const { reason, regex } of secretPatterns) {
    // Reset lastIndex — these are module-level /g regexes reused across calls.
    regex.lastIndex = 0;
    if (regex.test(output)) {
      reasons.push(reason);
      fired = true;
    }
    regex.lastIndex = 0;
    output = output.replace(regex, REDACTION_PLACEHOLDER);
  }

  return { text: output, fired, reasons };
}

export function detectQuarantine(text: string): {
  hit: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const { reason, regex } of quarantinePatterns) {
    if (regex.test(text)) {
      reasons.push(reason);
    }
  }
  return { hit: reasons.length > 0, reasons };
}

/**
 * Redact both content and description, then quarantine-check the redacted text.
 * Never throws: if safety processing fails for any reason, the note is marked
 * quarantined so it cannot auto-activate. Placement must never fail open.
 */
export function evaluateNoteSafety(note: CandidateMemoryNote): SafetyResult {
  try {
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
      reasons: [
        ...content.reasons.map((r) => `redaction:${r}`),
        ...description.reasons.map((r) => `redaction:${r}`),
        ...quarantine.reasons.map((r) => `quarantine:${r}`),
      ],
    };
  } catch (error) {
    return {
      note,
      redactionFired: false,
      quarantineHit: true,
      reasons: [
        `quarantine:safety_error:${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}
