/**
 * Topic drift scorer -- see
 * `docs/superpowers/specs/2026-08-30-topic-segment-consolidation-design.md`.
 *
 * Measures how far an incoming group prompt has moved from the conversation
 * accumulated so far, so the caller can decide whether the current topic
 * segment should close and consolidate.
 *
 * Pure: no store access, no I/O, no clock. Everything here is a function of its
 * arguments, which is what makes the threshold tunable against recorded
 * transcripts later.
 *
 * WHY JENSEN-SHANNON AND NOT RAW KL. JS is built FROM KL -- it is
 * `0.5*KL(P||M) + 0.5*KL(Q||M)` over the midpoint `M = (P+Q)/2`. Running KL
 * against the midpoint rather than against Q directly buys two things that
 * matter at chat-message scale:
 *
 *   1. No infinities, so no smoothing constant. `KL(P||Q)` is infinite for any
 *      term the new prompt has and the segment lacks -- which is most of them.
 *      Avoiding that needs an additive smoothing constant, and on texts this
 *      short the resulting score tracks that constant more than it tracks the
 *      topic. `M` has mass wherever either side does, so every term is finite
 *      by construction and no constant exists to dominate the result.
 *   2. Symmetry and a bound. Raw KL is order-dependent and unbounded; JS is
 *      neither, landing in [0, 1] with log base 2. That bound is the only
 *      reason a fixed threshold means anything.
 *
 * WHAT IS COMPARED, AND WHY IT IS NOT AGENT MESSAGES. In a role-based group
 * chat, vocabulary tracks the SPEAKER'S specialty far more strongly than the
 * subject. On the worked example in `middlewaredoc/GROUP-CHAT-DESIGN.md` the
 * Backend turn ("define POST /uploads and the storage flow") and the Security
 * turn ("review validation, auth, and secret boundaries") share zero content
 * words while discussing one topic -- so a scorer fed agent turns ranks that
 * same-topic handoff as MORE divergent than a real subject change. Feeding
 * `scoreDrift` human prompts only puts both sides of the comparison in one
 * speaker's voice, which removes the confound rather than tuning around it.
 * `topic-drift.test.ts` pins both halves of that claim.
 */

/**
 * Below this many distinct content terms, a pooled segment is too thin to judge
 * against: two short prompts share almost no vocabulary whatever their subject,
 * so scoring them yields noise. `scoreDrift` reports 0 (no drift) until the
 * segment carries at least this much evidence, letting it keep accumulating.
 */
export const MIN_EVIDENCE_TERMS = 8;

/**
 * Function words carry no topic signal but plenty of probability mass, so they
 * would dominate every distribution. Deliberately a small inline list rather
 * than a dependency -- this runs on prompts, not documents.
 */
const STOPWORDS = new Set([
  "about", "after", "again", "all", "also", "and", "any", "are", "back",
  "because", "been", "before", "being", "between", "both", "boy", "but",
  "can", "come", "could", "day", "did", "does", "done", "during", "each",
  "for", "from", "further", "get", "give", "had", "has", "have", "her",
  "here", "him", "his", "how", "into", "its", "just", "know", "let", "like",
  "look", "make", "man", "more", "most", "much", "must", "need", "new",
  "not", "now", "off", "old", "once", "one", "only", "other", "our", "out",
  "over", "own", "per", "put", "same", "see", "shall", "should", "since",
  "some", "still", "such", "take", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "time", "too", "two", "under",
  "use", "used", "using", "very", "via", "want", "was", "way", "were", "what",
  "when", "where", "which", "while", "who", "will", "with", "would", "yet",
  "you", "your",
]);

/**
 * Ordered longest-first so `uploading` reaches `upload` rather than stopping at
 * `uploadin`. Crude on purpose: the goal is only to fold obvious inflections of
 * one word together, so `upload`/`uploads`/`uploading` cannot be counted as
 * three unrelated terms and inflate the divergence.
 */
const SUFFIXES = ["ation", "tion", "ing", "ies", "es", "ed", "s", "e"];

/** Shortest acceptable stem. Prevents suffix stripping from gutting a word. */
const MIN_STEM_LENGTH = 3;

function stem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.length - suffix.length < MIN_STEM_LENGTH) continue;
    if (token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Lowercase, split on anything non-alphanumeric, drop noise, stem. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length >= MIN_STEM_LENGTH && !STOPWORDS.has(token))
    .map(stem);
}

/**
 * Term -> probability. An empty map means "no content terms", which callers
 * treat as no evidence rather than as a distribution.
 */
export function termDistribution(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return new Map();

  const distribution = new Map<string, number>();
  for (const [term, count] of counts) distribution.set(term, count / total);
  return distribution;
}

/** One side of the JS sum: KL(dist || mixture), with 0·log0 taken as 0. */
function klAgainstMixture(
  dist: Map<string, number>,
  other: Map<string, number>,
  vocabulary: Iterable<string>,
): number {
  let total = 0;
  for (const term of vocabulary) {
    const p = dist.get(term) ?? 0;
    if (p === 0) continue; // 0·log0 = 0; skipping also avoids log(0).
    const mixture = (p + (other.get(term) ?? 0)) / 2;
    total += p * Math.log2(p / mixture);
  }
  return total;
}

/**
 * Jensen-Shannon divergence, log base 2, over the union vocabulary.
 * 0 = identical, 1 = no shared terms. No smoothing: the mixture has support
 * wherever either input does.
 */
export function jsDivergence(
  p: Map<string, number>,
  q: Map<string, number>,
): number {
  if (p.size === 0 && q.size === 0) return 0;
  const vocabulary = new Set([...p.keys(), ...q.keys()]);
  const divergence =
    0.5 * klAgainstMixture(p, q, vocabulary) +
    0.5 * klAgainstMixture(q, p, vocabulary);
  // Clamp: floating-point error can push a disjoint pair a hair past 1.
  return Math.min(1, Math.max(0, divergence));
}

/**
 * How far `incoming` has drifted from the pooled `segmentPrompts`.
 *
 * Returns 0 -- never a boundary -- when either side lacks the evidence to
 * judge. Failing toward "same topic" keeps the segment accumulating, which is
 * recoverable; the alternative is splitting on noise, which is not.
 *
 * Pass HUMAN PROMPTS ONLY. See the module comment for why agent turns invert
 * the ranking this is supposed to produce.
 */
export function scoreDrift(
  segmentPrompts: readonly string[],
  incoming: string,
): number {
  const segment = termDistribution(segmentPrompts.join(" "));
  if (segment.size < MIN_EVIDENCE_TERMS) return 0;

  const candidate = termDistribution(incoming);
  if (candidate.size === 0) return 0;

  return jsDivergence(segment, candidate);
}
