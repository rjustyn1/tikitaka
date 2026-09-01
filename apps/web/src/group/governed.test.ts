import { describe, expect, it } from "vitest";
import { buildGovernedDiff, governedNoteIds, hasGovernedContent } from "./governed";

const AGENTS_MD = [
  "# Platform-managed Agent instructions",
  "",
  "You are the Frontend Agent.",
  "",
  "<!-- memory:note-1 -->",
  "## Governed memory",
  "Uploaded object keys are namespaced by tenant.",
  "<!-- /memory:note-1 -->",
  "",
].join("\n");

describe("governed memory parsing", () => {
  it("marks only the managed block as added in AGENTS.md", () => {
    const diff = buildGovernedDiff(AGENTS_MD, "instructions");
    const added = diff.filter((line) => line.kind === "added").map((line) => line.text);
    expect(added).toEqual([
      "<!-- memory:note-1 -->",
      "## Governed memory",
      "Uploaded object keys are namespaced by tenant.",
      "<!-- /memory:note-1 -->",
    ]);
    // The Agent's own identity text is context, not something approval wrote.
    expect(diff[0]).toMatchObject({ text: "# Platform-managed Agent instructions", kind: "context" });
    expect(diff[2]).toMatchObject({ text: "You are the Frontend Agent.", kind: "context" });
  });

  it("flags the delimiters so they can be dimmed as plumbing", () => {
    const markers = buildGovernedDiff(AGENTS_MD, "instructions")
      .filter((line) => line.marker)
      .map((line) => line.text);
    expect(markers).toEqual(["<!-- memory:note-1 -->", "<!-- /memory:note-1 -->"]);
  });

  it("treats a whole SKILL.md as added, since approval created the file", () => {
    const skill = "---\nname: memory-storage-key-layout\n---\n\n# Governed Memory\n";
    const diff = buildGovernedDiff(skill, "skill");
    expect(diff.every((line) => line.kind === "added")).toBe(true);
    expect(diff).toHaveLength(5);
  });

  it("does not count the planner charter as governed memory", () => {
    // group-task blocks are per-task scaffolding, not an approved grant.
    const charter = [
      "# Platform-managed Agent instructions",
      "<!-- group-task:task-9 -->",
      "This Agent is participating in a group task.",
      "<!-- /group-task:task-9 -->",
    ].join("\n");
    expect(hasGovernedContent(charter, "instructions")).toBe(false);
    expect(buildGovernedDiff(charter, "instructions").every((l) => l.kind === "context")).toBe(true);
  });

  it("reports an AGENTS.md with no approved memory as ungoverned", () => {
    expect(hasGovernedContent("# Just the identity header\n", "instructions")).toBe(false);
    expect(hasGovernedContent(AGENTS_MD, "instructions")).toBe(true);
  });

  it("separates several granted notes in one file", () => {
    const two = AGENTS_MD + "<!-- memory:note-2 -->\nSecond fact.\n<!-- /memory:note-2 -->\n";
    expect(governedNoteIds(two)).toEqual(["note-1", "note-2"]);
    const added = buildGovernedDiff(two, "instructions").filter((l) => l.kind === "added");
    expect(added).toHaveLength(7);
  });

  it("keeps a blank line between blocks as context", () => {
    const diff = buildGovernedDiff(AGENTS_MD, "instructions");
    expect(diff[1]).toMatchObject({ text: "", kind: "context" });
  });
});
