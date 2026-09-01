/**
 * An offline extractor whose notes describe the work that actually happened.
 *
 * `FakeExtractorClient` returns the same two canned upload notes whatever it
 * is given, which reads as broken next to a to-do app: the DAG builds one
 * thing and the memory panel remembers another. This picks its notes from
 * what the buffer actually contains, so the demo stays coherent, and emits
 * nothing when it recognises nothing rather than inventing a memory.
 *
 * Selected by DEMO_MODE=1. It is still canned -- no model is called.
 */
import type {
  ExtractorClient,
  ExtractorRequest,
  ExtractorResponse,
} from "../memory/extractor-client.js";

interface CannedNote {
  /** Only emitted when the buffer shows this work was done. */
  evidence: RegExp;
  content: string;
  severity: "normal" | "severe";
  skillKey: string;
  description: string;
  rationale: string;
}

const NOTES: CannedNote[] = [
  {
    evidence: /scrypt|password|salt/i,
    content:
      "Passwords are hashed with scrypt and a per-user salt. Plaintext passwords " +
      "are never stored and never logged.",
    severity: "severe",
    skillKey: "password-hashing",
    description: "Password storage rule for this codebase.",
    rationale: "Backend established this while building register and login.",
  },
  {
    evidence: /enumerat|same answer|identically|timingSafeEqual/i,
    content:
      "Login must answer identically for an unknown email and a wrong password, " +
      "so the endpoint cannot be used to enumerate accounts.",
    severity: "severe",
    skillKey: "login-enumeration",
    description: "Login must not leak whether an account exists.",
    rationale: "Security review called this out on the auth path.",
  },
  {
    evidence: /ownerId|ownership|scoped to the/i,
    content:
      "Every to-do carries an ownerId, and every read filters by the session " +
      "user. A client-supplied ownerId is never trusted.",
    severity: "normal",
    skillKey: "todo-ownership",
    description: "Ownership is enforced server-side on every read.",
    rationale: "Agreed when the to-do endpoints were written.",
  },
  {
    evidence: /session token|opaque|Bearer/i,
    content:
      "Session tokens are opaque and random; they never encode the user id, and " +
      "they must never be logged because the token is the credential.",
    severity: "severe",
    skillKey: "session-tokens",
    description: "Session token handling rule.",
    rationale: "Established with the session model, reaffirmed in review.",
  },
  {
    evidence: /textContent|innerHTML/i,
    content:
      "The UI renders user-supplied to-do titles with textContent, never " +
      "innerHTML.",
    severity: "normal",
    skillKey: "ui-escaping",
    description: "How the UI renders user text.",
    rationale: "Frontend chose this when building the list view.",
  },
  {
    evidence: /re-check ownership|ownedBy|id AND owner/i,
    content:
      "Every mutating route resolves the record by id AND owner. Holding an id " +
      "is not authorisation on its own.",
    severity: "severe",
    skillKey: "mutation-ownership",
    description: "Mutating routes must re-check ownership.",
    rationale: "Found by the integration check, fixed in hardening.",
  },
  {
    evidence: /trim|MAX_TITLE|200 characters/i,
    content:
      "To-do titles are trimmed and capped at 200 characters; an empty title is " +
      "rejected with a 400.",
    severity: "normal",
    skillKey: "todo-validation",
    description: "Input validation for to-do titles.",
    rationale: "Set when the create endpoint was written.",
  },
];

/** Provenance indices, cited the way the real prompt prints them. */
function collectInts(text: string, pattern: RegExp): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(pattern)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) found.add(value);
  }
  return [...found];
}

export class DemoExtractorClient implements ExtractorClient {
  async extract(input: ExtractorRequest): Promise<ExtractorResponse> {
    const runIndices = collectInts(input.prompt, /\brun (\d+)/gi);
    const spanIndices = collectInts(input.prompt, /\[span (\d+)\]/gi);
    // No provenance means nothing can be cited, and an uncitable note is not a
    // note this pipeline will accept.
    if (runIndices.length === 0 || spanIndices.length === 0) {
      return { rawText: JSON.stringify({ notes: [] }) };
    }

    const notes = NOTES.filter((note) => note.evidence.test(input.prompt)).map(
      (note, index) => ({
        content: note.content,
        severity: note.severity,
        skillKey: note.skillKey,
        description: note.description,
        sourceRunIndices: [runIndices[index % runIndices.length]],
        sourceSpanIndices: [spanIndices[index % spanIndices.length]],
        rationale: note.rationale,
      }),
    );

    return { rawText: JSON.stringify({ notes }) };
  }
}
