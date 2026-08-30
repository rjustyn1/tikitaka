/**
 * Path display, tested because it failed in a real browser.
 *
 * The server records whatever separator its own filesystem uses. On a Windows
 * host the member rail rendered the entire absolute path — unreadable, and it
 * put the operator's home directory on screen during a demo.
 */
import { describe, expect, it } from "vitest";
import { fileTail, roleClass,
  deriveRole,
} from "./format";

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

describe("roleClass", () => {
  it("keeps known accents and safely maps free-form labels", () => {
    expect(roleClass("backend")).toBe("backend");
    expect(roleClass("Product Owner")).toBe("member");
    expect(roleClass(null)).toBe("member");
  });
});

describe("deriveRole", () => {
  it("takes the label from the Agent's own name", () => {
    expect(deriveRole("Security Agent")).toBe("security");
    expect(deriveRole("Backend Agent")).toBe("backend");
    expect(deriveRole("Ops Agent")).toBe("ops");
  });

  it("slugs a multi-word name", () => {
    expect(deriveRole("Data Platform Agent")).toBe("data-platform");
  });

  it("falls back to member when nothing usable is left", () => {
    expect(deriveRole("Agent")).toBe("member");
    expect(deriveRole("   ")).toBe("member");
    expect(deriveRole("!!!")).toBe("member");
  });

  it("cannot produce a label that contradicts its Agent", () => {
    // The bug it replaces: a human typing "frontend" onto a Security Agent.
    expect(deriveRole("Security Agent")).not.toBe("frontend");
  });
});
