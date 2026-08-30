/**
 * Path display, tested because it failed in a real browser.
 *
 * The server records whatever separator its own filesystem uses. On a Windows
 * host the member rail rendered the entire absolute path — unreadable, and it
 * put the operator's home directory on screen during a demo.
 */
import { describe, expect, it } from "vitest";
import { fileTail } from "./format";

describe("fileTail", () => {
  it("keeps the last two segments of a POSIX path", () => {
    expect(fileTail("/w/a2/.agents/skills/upload-contract/SKILL.md")).toBe(
      "upload-contract/SKILL.md",
    );
  });

  it("handles a Windows path, which is what the server actually stores here", () => {
    expect(
      fileTail("C:\\Users\\Rog\\workspaces\\a2\\.agents\\skills\\upload\\SKILL.md"),
    ).toBe("upload/SKILL.md");
  });

  it("takes as many segments as asked for", () => {
    expect(fileTail("/w/a2/.agents/skills/upload/SKILL.md", 3)).toBe(
      "skills/upload/SKILL.md",
    );
  });

  it("returns a short path unchanged rather than padding it", () => {
    expect(fileTail("AGENTS.md")).toBe("AGENTS.md");
  });
});
