/**
 * Turning a flat list of file paths into a directory tree.
 *
 * The explorer receives paths like `apps/web/src/UploadWidget.tsx`. Listed
 * flat, every file sat at one level and the shape of the codebase was
 * invisible. This rebuilds the folders and emits rows already carrying their
 * `├──` / `└──` / `│` connectors, so the panel renders a real tree:
 *
 *   ├── src/
 *   │   ├── app.js
 *   │   ├── config/database.js
 *   │   └── models/
 *   │       ├── Todo.js
 *   │       └── User.js
 *   └── package.json
 *
 * A directory with exactly one child is folded into it (`config/database.js`
 * rather than `config/` then `database.js`), the way a file browser does --
 * the intermediate row carries no information of its own.
 *
 * Kept free of React so the tree building and the connector maths are tested
 * on their own.
 */

export interface TreeRow {
  /** Full path for a file; the folder path for a directory. */
  path: string;
  /** Trailing segment(s), with a trailing slash for directories. */
  label: string;
  /** The `│   ├── ` run that precedes the label. */
  prefix: string;
  depth: number;
  isDir: boolean;
  /** Byte size, files only. */
  size?: number;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  children: Map<string, TreeNode>;
}

function node(name: string, path: string, isDir: boolean): TreeNode {
  return { name, path, isDir, children: new Map() };
}

/**
 * Directories first, then files, each alphabetically -- the order a file
 * browser uses, and stable regardless of the order the API listed them in.
 */
function sortedChildren(parent: TreeNode): TreeNode[] {
  return [...parent.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function buildTree(files: Array<{ path: string; size: number }>): TreeNode {
  const root = node("", "", true);
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    let current = root;
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      let next = current.children.get(segment);
      if (!next) {
        next = node(segment, path, !last);
        current.children.set(segment, next);
      }
      if (last) {
        next.isDir = false;
        next.size = file.size;
      }
      current = next;
    });
  }
  return root;
}

/**
 * Fold a single-child directory chain into one label. Done on the tree rather
 * than on the flattened rows, because the connectors of everything below
 * depend on the depth the fold produces.
 */
function fold(child: TreeNode): { label: string; target: TreeNode } {
  let label = child.name + (child.isDir ? "/" : "");
  let target = child;
  while (target.isDir && target.children.size === 1) {
    const only = [...target.children.values()][0];
    if (!only) break;
    label += only.name + (only.isDir ? "/" : "");
    target = only;
  }
  return { label, target };
}

/** Flatten the tree to rows, each carrying its own connector prefix. */
export function buildTreeRows(
  files: Array<{ path: string; size: number }>,
  options: { compact?: boolean } = {},
): TreeRow[] {
  const compact = options.compact ?? true;
  const rows: TreeRow[] = [];

  const walk = (parent: TreeNode, depth: number, ancestorHasNext: boolean[]) => {
    const children = sortedChildren(parent);
    children.forEach((child, index) => {
      const isLast = index === children.length - 1;
      // Each ancestor contributes a continuing "│" only while it still has
      // siblings below it; otherwise that column is blank.
      const prefix =
        ancestorHasNext.map((hasNext) => (hasNext ? "│   " : "    ")).join("") +
        (isLast ? "└── " : "├── ");

      const { label, target } = compact
        ? fold(child)
        : { label: child.name + (child.isDir ? "/" : ""), target: child };

      rows.push({
        path: target.path,
        label,
        prefix,
        depth,
        isDir: target.isDir,
        ...(target.size !== undefined ? { size: target.size } : {}),
      });
      if (target.isDir) walk(target, depth + 1, [...ancestorHasNext, !isLast]);
    });
  };

  walk(buildTree(files), 0, []);
  return rows;
}
