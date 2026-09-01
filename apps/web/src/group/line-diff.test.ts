import { describe, expect, it } from "vitest";
import { diffLines, diffStat } from "./line-diff";

/** Compact rendering so alignment is asserted as the panes show it. */
const shape = (before: string, after: string) =>
  diffLines(before, after).map(
    (row) =>
      (row.left.text ?? "·") + " | " + (row.right.text ?? "·") + " " + row.kind,
  );

describe("diffLines", () => {
  it("pairs unchanged lines on one row", () => {
    expect(shape("a\nb\n", "a\nb\n")).toEqual(["a | a same", "b | b same"]);
  });

  it("leaves the left blank for an insertion", () => {
    expect(shape("a\nc\n", "a\nb\nc\n")).toEqual([
      "a | a same",
      "· | b added",
      "c | c same",
    ]);
  });

  it("leaves the right blank for a deletion", () => {
    expect(shape("a\nb\nc\n", "a\nc\n")).toEqual([
      "a | a same",
      "b | · removed",
      "c | c same",
    ]);
  });

  /** The real case: landing appends a governed block to an existing file. */
  it("keeps the original file as context when a block is appended", () => {
    const before = "# Instructions\n\nYou are the Backend Agent.\n";
    const after =
      "# Instructions\n\nYou are the Backend Agent.\n## Governed Memories\n<!-- memory:n1 -->\n- Keys are namespaced.\n<!-- /memory:n1 -->\n";
    const rows = diffLines(before, after);
    expect(rows.filter((row) => row.kind === "same")).toHaveLength(3);
    expect(diffStat(rows)).toEqual({ added: 4, removed: 0 });
  });

  it("numbers each side independently", () => {
    const rows = diffLines("a\nb\n", "x\na\nb\n");
    expect(rows.map((row) => [row.left.n, row.right.n])).toEqual([
      [null, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("treats a create as all additions", () => {
    const rows = diffLines("", "one\ntwo\n");
    expect(rows.every((row) => row.kind === "added")).toBe(true);
    expect(diffStat(rows)).toEqual({ added: 2, removed: 0 });
  });

  it("does not invent a trailing empty line", () => {
    expect(diffLines("a\n", "a\n")).toHaveLength(1);
  });

  it("reports a replaced line as one removal and one addition", () => {
    expect(diffStat(diffLines("a\nold\nc\n", "a\nnew\nc\n"))).toEqual({
      added: 1,
      removed: 1,
    });
  });
});
