/**
 * A line diff for the review dialog's side-by-side panes.
 *
 * Small on purpose: the inputs are one `AGENTS.md` or one `SKILL.md`, so a
 * plain LCS is both fast enough and easy to reason about. Rows come out
 * already aligned -- an unchanged line occupies one row on both sides, an
 * insertion leaves the left side blank, a deletion leaves the right side
 * blank -- so the renderer never has to do its own pairing.
 *
 * Kept free of React so the alignment is tested on its own.
 */

export interface DiffCell {
  /** 1-based line number in that file, or null for the blank half of a row. */
  n: number | null;
  text: string | null;
}

export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
  kind: "same" | "added" | "removed";
}

function splitLines(text: string): string[] {
  // An absent file is zero lines. Without this, "".split("\n") yields one
  // empty line and a created file renders a phantom deleted row.
  if (text === "") return [];
  // A trailing newline is a terminator, not an empty final line.
  return text.replace(/\n$/, "").split("\n");
}

/**
 * Longest common subsequence table over lines. O(n*m); the files here are
 * hundreds of lines at most, and a governed block is a contiguous insert,
 * which is the case LCS handles best.
 */
function lcsLengths(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] =
        a[i] === b[j]
          ? (table[i + 1]![j + 1] ?? 0) + 1
          : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }
  return table;
}

/** Aligned rows for a before/after pair. */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const table = lcsLengths(a, b);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({
        left: { n: i + 1, text: a[i] ?? "" },
        right: { n: j + 1, text: b[j] ?? "" },
        kind: "same",
      });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      rows.push({
        left: { n: i + 1, text: a[i] ?? "" },
        right: { n: null, text: null },
        kind: "removed",
      });
      i += 1;
    } else {
      rows.push({
        left: { n: null, text: null },
        right: { n: j + 1, text: b[j] ?? "" },
        kind: "added",
      });
      j += 1;
    }
  }
  while (i < a.length) {
    rows.push({
      left: { n: i + 1, text: a[i] ?? "" },
      right: { n: null, text: null },
      kind: "removed",
    });
    i += 1;
  }
  while (j < b.length) {
    rows.push({
      left: { n: null, text: null },
      right: { n: j + 1, text: b[j] ?? "" },
      kind: "added",
    });
    j += 1;
  }
  return rows;
}

/** How many lines the change touches, for the dialog's summary. */
export function diffStat(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((row) => row.kind === "added").length,
    removed: rows.filter((row) => row.kind === "removed").length,
  };
}
