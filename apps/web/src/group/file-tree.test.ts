import { describe, expect, it } from "vitest";
import { buildTreeRows } from "./file-tree";

const files = (...paths: string[]) => paths.map((path) => ({ path, size: 10 }));

/** Render rows the way the panel does, so the connectors are asserted as seen. */
const render = (rows: ReturnType<typeof buildTreeRows>) =>
  rows.map((row) => row.prefix + row.label);

describe("buildTreeRows", () => {
  it("rebuilds folders from flat paths", () => {
    const rows = buildTreeRows(
      files("src/app.js", "src/models/User.js", "package.json"),
      { compact: false },
    );
    expect(render(rows)).toEqual([
      "├── src/",
      "│   ├── models/",
      "│   │   └── User.js",
      "│   └── app.js",
      "└── package.json",
    ]);
  });

  it("keeps the trunk line running past a folder that still has siblings", () => {
    // The "│" under src/ is the whole point: it shows README belongs to the
    // root, not to src/.
    const rows = buildTreeRows(files("src/a.js", "README.md"), { compact: false });
    expect(render(rows)).toEqual(["├── src/", "│   └── a.js", "└── README.md"]);
  });

  it("blanks the column under the last folder", () => {
    // Directories sort first, so a folder is last only when nothing follows it.
    const rows = buildTreeRows(files("src/a.js", "src/b.js"), { compact: false });
    expect(render(rows)).toEqual(["└── src/", "    ├── a.js", "    └── b.js"]);
  });

  it("folds a single-child chain into one row", () => {
    const rows = buildTreeRows(files("src/config/database.js", "src/app.js"));
    expect(render(rows)).toEqual([
      "└── src/",
      "    ├── config/database.js",
      "    └── app.js",
    ]);
  });

  it("does not fold a folder with more than one child", () => {
    const rows = buildTreeRows(
      files("src/models/User.js", "src/models/Todo.js"),
    );
    expect(render(rows)).toEqual([
      "└── src/models/",
      "    ├── Todo.js",
      "    └── User.js",
    ]);
  });

  it("points a folded row at the file, so it still opens", () => {
    const rows = buildTreeRows(files("a/b/c/deep.ts"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "a/b/c/deep.ts",
      path: "a/b/c/deep.ts",
      isDir: false,
      size: 10,
    });
  });

  it("sorts directories before files, each alphabetically", () => {
    const rows = buildTreeRows(
      files("zeta.md", "alpha.md", "b/one.js", "b/two.js", "a/one.js", "a/two.js"),
    );
    expect(render(rows)).toEqual([
      "├── a/",
      "│   ├── one.js",
      "│   └── two.js",
      "├── b/",
      "│   ├── one.js",
      "│   └── two.js",
      "├── alpha.md",
      "└── zeta.md",
    ]);
  });

  it("is stable however the API ordered the listing", () => {
    const forward = buildTreeRows(files("src/a.js", "src/b.js", "z.md"));
    const reversed = buildTreeRows(files("z.md", "src/b.js", "src/a.js"));
    expect(render(reversed)).toEqual(render(forward));
  });

  it("carries the size onto file rows only", () => {
    const rows = buildTreeRows(
      [{ path: "src/a.js", size: 42 }, { path: "src/b/c.js", size: 7 }],
      { compact: false },
    );
    const bySize = Object.fromEntries(rows.map((row) => [row.label, row.size]));
    expect(bySize).toEqual({ "src/": undefined, "b/": undefined, "c.js": 7, "a.js": 42 });
  });

  it("renders the deep skill path the Agent view actually receives", () => {
    const rows = buildTreeRows(
      files("AGENTS.md", ".agents/skills/storage-key-layout/SKILL.md"),
    );
    expect(render(rows)).toEqual([
      "├── .agents/skills/storage-key-layout/SKILL.md",
      "└── AGENTS.md",
    ]);
  });

  it("returns nothing for an empty listing", () => {
    expect(buildTreeRows([])).toEqual([]);
  });
});
