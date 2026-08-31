import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { Agent, GroupTask } from "./types.js";

/**
 * Managed blocks -- `middlewaredoc/components/WORKSPACE-EXTENSIONS.md`.
 *
 * `AGENTS.md` is co-owned. The base identity section is regenerated from the
 * Agent's fields whenever it is edited, but two kinds of block must survive
 * that regeneration:
 *
 *   <!-- group-task:<groupTaskId> -->   the planner-written charter
 *   <!-- memory:<noteId> -->            governed memory (Person 3, LANDING)
 *
 * Without this, `updateAgent()` -> `writeInstructions()` silently wipes landed
 * memory and the demo shows memory vanishing for no visible reason. This is the
 * hard ordering constraint in `PLAN.md`: these helpers must exist before Person
 * 3 lands LANDING, and Person 3 imports them rather than reimplementing them.
 */
const MANAGED_BLOCK_PATTERN =
  /<!-- (group-task|memory):([A-Za-z0-9._-]+) -->[\s\S]*?<!-- \/\1:\2 -->/g;

/**
 * A managed block is addressed by its FULL marker id -- exactly the text that
 * appears between the comment delimiters, kind prefix included:
 *
 *   memory:<noteId>            governed memory      (Person 3, LANDING)
 *   group-task:<groupTaskId>   the planner charter  (Person 2)
 *
 * Rejecting anything else is deliberate. A bare id would write
 * `<!-- note-1 -->`, which `writeInstructions()` does not recognise and
 * therefore does not preserve -- silently losing landed memory on the next
 * Agent edit, which is the exact failure this module exists to prevent. Fail
 * loudly at the call site instead.
 */
const MARKER_ID_PATTERN = /^(?:memory|group-task):[A-Za-z0-9._-]+$/;

/** `memory:<noteId>` -- use this rather than building the string by hand. */
export function memoryMarkerId(noteId: string): string {
  return "memory:" + noteId;
}

/** `group-task:<groupTaskId>`. */
export function groupTaskMarkerId(groupTaskId: string): string {
  return "group-task:" + groupTaskId;
}

function markersFor(markerId: string): { start: string; end: string } {
  if (!MARKER_ID_PATTERN.test(markerId)) {
    throw new Error(
      'Invalid managed-block marker id "' +
        markerId +
        '". Expected "memory:<noteId>" or "group-task:<groupTaskId>" - use ' +
        "memoryMarkerId() or groupTaskMarkerId() rather than a bare id.",
    );
  }
  return {
    start: "<!-- " + markerId + " -->",
    end: "<!-- /" + markerId + " -->",
  };
}

function blockBounds(
  content: string,
  start: string,
  end: string,
): { from: number; to: number } | null {
  const from = content.indexOf(start);
  if (from === -1) return null;
  const endIndex = content.indexOf(end, from + start.length);
  if (endIndex === -1) return null;
  return { from, to: endIndex + end.length };
}

function tidy(content: string): string {
  const trimmed = content.replace(/\n{3,}/g, "\n\n").trimEnd();
  return trimmed.length > 0 ? trimmed + "\n" : "";
}

/**
 * Insert or replace one managed block.
 *
 * Idempotent by construction: landing the same note twice replaces the block
 * rather than appending a second copy, which is what makes revocation precise.
 */
export function replaceManagedBlock(
  existing: string,
  markerId: string,
  body: string,
): string {
  const { start, end } = markersFor(markerId);
  const block = start + "\n" + body.trim() + "\n" + end;
  const bounds = blockBounds(existing, start, end);
  if (!bounds) {
    const base = existing.trimEnd();
    return tidy((base.length > 0 ? base + "\n\n" : "") + block);
  }
  return tidy(
    existing.slice(0, bounds.from) + block + existing.slice(bounds.to),
  );
}

/** Remove one managed block. An absent block is a no-op, so revoke is retry-safe. */
export function removeManagedBlock(existing: string, markerId: string): string {
  const { start, end } = markersFor(markerId);
  const bounds = blockBounds(existing, start, end);
  if (!bounds) return existing;
  return tidy(existing.slice(0, bounds.from) + existing.slice(bounds.to));
}

/** Every managed block in the file, in order, markers included. */
export function extractManagedBlocks(content: string): string[] {
  return content.match(MANAGED_BLOCK_PATTERN) ?? [];
}

/**
 * Governed memory belongs to each Agent workspace, never to Codex's global
 * skills directory. Keep this assertion at startup so a bad landing path is
 * caught before the server accepts work.
 */
export async function assertNoGovernedMemoryInCodexHome(
  codexHome: string,
): Promise<void> {
  const skillsPath = path.join(codexHome, "skills");
  let entries: string[];
  try {
    entries = await readdir(skillsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const strayEntries = entries.filter((entry) => entry.startsWith("memory-"));
  if (strayEntries.length > 0) {
    throw new Error(
      "Governed memory must never be written under CODEX_HOME/skills: " +
        strayEntries.join(", "),
    );
  }
}

export class WorkspaceManager {
  /**
   * `runtimeProvider` decides how shared code is exposed as `./code` (A2). It
   * defaults to the same value `config.ts` and the committed `.env` default to,
   * so an omitted argument can never disagree with the system default.
   */
  constructor(
    private readonly root: string,
    private readonly runtimeProvider: AppConfig["runtimeProvider"] = "local-process",
  ) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  /**
   * `workspaces/shared-code/<groupId>` -- code only, never memory.
   *
   * Keyed by GROUP, not by task. A team's codebase has to outlive one prompt:
   * the transcript is per group and governed memory is per topic segment, so
   * per-task code meant an Agent could be told in the transcript that it built
   * something while `./code` was empty. Task two continues task one's work.
   */
  sharedCodePath(groupId: string): string {
    return path.join(this.root, "shared-code", groupId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  /**
   * Compose `AGENTS.md`: regenerated identity first, then every managed block
   * carried over verbatim. Only an explicit revoke removes a memory block.
   */
  async writeInstructions(agent: Agent): Promise<void> {
    const filePath = path.join(agent.workspacePath, "AGENTS.md");
    const preserved = extractManagedBlocks(await this.readIfPresent(filePath));
    const base = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "The section above is regenerated when the Agent configuration is updated.",
      "Managed blocks below it are preserved across regeneration and are removed",
      "only by an explicit revoke.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    const content = tidy([base, ...preserved].join("\n\n"));
    await writeFile(filePath, content, "utf8");
  }

  /**
   * Ensure the group's shared code directory exists.
   *
   * Idempotent by design: every task after the first reuses the tree its
   * predecessor left behind. `created` tells the caller whether THIS call made
   * it, which is what lets a failed setup roll back its own directory without
   * deleting a team's accumulated work.
   */
  async ensureSharedCodeDirectory(
    groupId: string,
  ): Promise<{ path: string; created: boolean }> {
    const target = this.sharedCodePath(groupId);
    await mkdir(path.dirname(target), { recursive: true });
    let created = true;
    try {
      await mkdir(target, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      created = false;
      return { path: target, created };
    }
    await writeFile(
      path.join(target, "README.md"),
      [
        "# Shared group code",
        "",
        "Every Agent in this team edits this one directory through `./code`",
        "inside its own private workspace. It persists across tasks: a later",
        "task continues the work an earlier one left here.",
        "",
        "Code only. Governed memory (AGENTS.md entries and .agents/skills) lives in",
        "each Agent's private workspace root and must never be written here --",
        "placing it here would make it readable by every member and void the",
        "placement-based security boundary.",
        "",
      ].join("\n"),
      "utf8",
    );
    return { path: target, created };
  }

  /**
   * Remove a shared code directory. Only ever called for a directory the
   * failing setup itself created -- never for one holding earlier work.
   */
  async removeSharedCodeDirectory(groupId: string): Promise<void> {
    const sharedRoot = path.resolve(this.root, "shared-code");
    const target = path.resolve(this.sharedCodePath(groupId));
    if (path.dirname(target) !== sharedRoot) {
      throw new Error("Invalid shared-code group id");
    }
    await rm(target, { recursive: true, force: true });
  }

  /**
   * Expose the shared code directory as `./code` in an Agent's private root.
   *
   * A2 -- this is the ONLY place the two runtimes differ:
   *
   *   container      the runner bind-mounts sharedCodePath onto <workspace>/code,
   *                  so we only need the mount point to exist. `./code` is then a
   *                  REAL directory inside the container, and because it sits
   *                  inside the cwd, `workspace-write` permits it with no
   *                  `--add-dir`. A symlink is BROKEN here: it resolves outside
   *                  the mounted workspace.
   *
   *   local-process  a link, plus `codex exec --add-dir` from the runner, because
   *                  the target resolves outside the cwd.
   *
   * Created as a junction rather than a plain symlink: on POSIX the type
   * argument is ignored, and on Windows a junction links directories without
   * requiring elevation.
   */
  async prepareSharedCode(agent: Agent, sharedCodePath: string): Promise<void> {
    const linkPath = path.join(agent.workspacePath, "code");

    if (this.runtimeProvider === "container") {
      await mkdir(linkPath, { recursive: true });
      return;
    }

    const existing = await this.readLinkIfPresent(linkPath);
    if (existing !== null) {
      const resolved = path.resolve(path.dirname(linkPath), existing);
      if (resolved === path.resolve(sharedCodePath)) {
        return; // already linked to this task's shared code
      }
      throw new HttpError(
        409,
        "This Agent workspace already has a ./code link pointing elsewhere",
      );
    }
    await mkdir(path.dirname(sharedCodePath), { recursive: true });
    await symlink(path.resolve(sharedCodePath), linkPath, "junction");
  }

  /** Drop the `./code` link once a group task is over. Never touches the target. */
  async releaseSharedCode(agent: Agent): Promise<void> {
    const codePath = path.join(agent.workspacePath, "code");
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(codePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    // A local-process task owns a symlink. A container task owns an empty
    // mount point after its container exits. Never recursively delete a real
    // directory: it may be user data rather than a platform-created mount.
    if (stat.isSymbolicLink()) {
      await rm(codePath, { force: true });
    } else if (this.runtimeProvider === "container" && stat.isDirectory()) {
      await rm(codePath, { force: true });
    }
  }

  /**
   * Write the planner's group-task charter into the Agent's PRIVATE `AGENTS.md`.
   *
   * Never into shared code: the link points from each private workspace to the
   * shared tree, never the reverse, or isolation breaks.
   */
  async writeGroupTaskSection(
    agent: Agent,
    task: GroupTask,
    section: string,
  ): Promise<void> {
    const filePath = path.join(agent.workspacePath, "AGENTS.md");
    const current = await this.readIfPresent(filePath);
    await writeFile(
      filePath,
      replaceManagedBlock(current, groupTaskMarkerId(task.id), section),
      "utf8",
    );
  }

  async clearGroupTaskSection(
    agent: Agent,
    groupTaskId: string,
  ): Promise<void> {
    const filePath = path.join(agent.workspacePath, "AGENTS.md");
    const current = await this.readIfPresent(filePath);
    if (current === "") return;
    await writeFile(
      filePath,
      removeManagedBlock(current, groupTaskMarkerId(groupTaskId)),
      "utf8",
    );
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    // Drop any ./code link first so archiving cannot follow it into shared code.
    await this.releaseSharedCode(agent).catch(() => undefined);
    await rename(agent.workspacePath, destination);
    return destination;
  }

  private async readIfPresent(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private async readLinkIfPresent(linkPath: string): Promise<string | null> {
    try {
      return await readlink(linkPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      // EINVAL/UNKNOWN: the path exists but is not a link.
      throw new HttpError(
        409,
        "This Agent workspace already has a ./code entry that is not a link",
      );
    }
  }
}
