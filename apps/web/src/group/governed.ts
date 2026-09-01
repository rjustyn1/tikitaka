/**
 * Reading governed memory out of a member's durable files, for the explorer.
 *
 * The server writes memory as an addressable managed block --
 * `<!-- memory:<noteId> -->` ... `<!-- /memory:<noteId> -->` -- inside
 * `AGENTS.md`, and writes a whole `SKILL.md` per note under `.agents/skills/`.
 * Both markers are also how revoke finds the text again, so surfacing them is
 * the honest way to show that a grant is a real, reversible file change.
 *
 * Kept free of React so the parsing is tested on its own.
 */

/** Mirrors MANAGED_BLOCK_PATTERN in apps/server/src/workspace.ts. */
const MANAGED_BLOCK = /<!-- (group-task|memory):([A-Za-z0-9._-]+) -->[\s\S]*?<!-- \/\1:\2 -->/g;

const MARKER_LINE = /^\s*<!-- \/?(?:group-task|memory):[A-Za-z0-9._-]+ -->\s*$/;

export type GovernedFileKind = "instructions" | "skill";

export interface DiffLine {
  text: string;
  /**
   * `added` is what approval put there and what revoke takes away; `context`
   * is the file as it stood before. Nothing is ever reported as removed:
   * landing only ever inserts or replaces its own block.
   */
  kind: "context" | "added";
  /** A managed-block delimiter, dimmed so it reads as plumbing, not content. */
  marker: boolean;
}

/** Character ranges of every governed-memory block, markers included. */
function memoryRanges(content: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  // `matchAll` needs the /g flag and its own lastIndex, so rebuild per call.
  for (const match of content.matchAll(new RegExp(MANAGED_BLOCK.source, "g"))) {
    if (match[1] !== "memory" || match.index === undefined) continue;
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

/** Note ids of the governed blocks present in an `AGENTS.md`. */
export function governedNoteIds(content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(new RegExp(MANAGED_BLOCK.source, "g"))) {
    if (match[1] === "memory" && match[2]) ids.push(match[2]);
  }
  return ids;
}

/**
 * The file as a before/after diff.
 *
 * `AGENTS.md` is a live file an Agent also edits, so only its governed blocks
 * are additions and the rest is context. A `SKILL.md` exists *because* a note
 * was approved -- before that there was no file -- so every line is an
 * addition. Both are literally what revoke would undo.
 */
export function buildGovernedDiff(
  content: string,
  fileKind: GovernedFileKind,
): DiffLine[] {
  const lines = content.replace(/\n$/, "").split("\n");
  if (fileKind === "skill") {
    return lines.map((text) => ({
      text,
      kind: "added" as const,
      marker: false,
    }));
  }

  const ranges = memoryRanges(content);
  const out: DiffLine[] = [];
  let offset = 0;
  for (const text of lines) {
    // A line belongs to a block when any of its characters fall inside one,
    // which keeps a block that opens mid-line correctly attributed.
    const start = offset;
    const end = offset + text.length;
    const inBlock = ranges.some((range) => start < range.to && end > range.from);
    out.push({
      text,
      kind: inBlock ? "added" : "context",
      marker: MARKER_LINE.test(text),
    });
    offset = end + 1;
  }
  return out;
}

/** Whether approval has actually written anything into this file yet. */
export function hasGovernedContent(
  content: string,
  fileKind: GovernedFileKind,
): boolean {
  if (fileKind === "skill") return content.trim().length > 0;
  return memoryRanges(content).length > 0;
}
