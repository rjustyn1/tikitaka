import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "./errors.js";
import type { Agent, GroupTask } from "./types.js";
import {
  WorkspaceManager,
  assertNoGovernedMemoryInCodexHome,
  extractManagedBlocks,
  groupTaskMarkerId,
  memoryMarkerId,
  removeManagedBlock,
  replaceManagedBlock,
} from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-ws-"));
  temporaryDirectories.push(root);
  return path.join(root, "workspaces");
}

function makeAgent(root: string, id = "agent-1", name = "Backend"): Agent {
  return {
    id,
    name,
    description: "Owns the backend",
    instructions: "Design APIs.",
    status: "ready",
    workspacePath: path.join(root, id),
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTask(id = "task-1", sharedCodePath = "/tmp/shared"): GroupTask {
  return {
    id,
    groupId: "group-1",
    prompt: "Plan an upload feature.",
    sharedCodePath,
    status: "running",
    currentNodeId: null,
    nodeRunIds: [],
    flushedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

describe("managed block helpers", () => {
  const marker = memoryMarkerId("note-1");
  const start = "<!-- " + marker + " -->";
  const end = "<!-- /" + marker + " -->";

  it("appends a block when the file has none", () => {
    const result = replaceManagedBlock("# Base\n", marker, "Do not leak keys.");
    expect(result).toContain(start);
    expect(result).toContain("Do not leak keys.");
    expect(result).toContain(end);
    expect(result.startsWith("# Base")).toBe(true);
  });

  it("replaces in place rather than appending a second copy", () => {
    const once = replaceManagedBlock("# Base\n", marker, "first");
    const twice = replaceManagedBlock(once, marker, "second");
    expect(twice.split(start)).toHaveLength(2);
    expect(twice).toContain("second");
    expect(twice).not.toContain("first");
  });

  it("removes a block and is a no-op when it is already gone", () => {
    const withBlock = replaceManagedBlock("# Base\n", marker, "content");
    const removed = removeManagedBlock(withBlock, marker);
    expect(removed).not.toContain(start);
    expect(removed).toContain("# Base");
    expect(removeManagedBlock(removed, marker)).toBe(removed);
  });

  it("leaves an unrelated block untouched when removing one", () => {
    let content = replaceManagedBlock("# Base\n", marker, "first");
    content = replaceManagedBlock(content, memoryMarkerId("note-2"), "second");
    const removed = removeManagedBlock(content, marker);
    expect(removed).not.toContain("first");
    expect(removed).toContain("second");
  });

  it("extracts both group-task and memory blocks", () => {
    let content = replaceManagedBlock(
      "# Base\n",
      groupTaskMarkerId("task-1"),
      "charter",
    );
    content = replaceManagedBlock(content, marker, "memory");
    expect(extractManagedBlocks(content)).toHaveLength(2);
  });

  it("rejects a bare id loudly instead of writing an unpreservable block", () => {
    // A bare noteId would produce <!-- note-1 -->, which writeInstructions()
    // does not recognise and therefore silently drops on the next Agent edit.
    expect(() => replaceManagedBlock("# Base\n", "note-1", "x")).toThrow(
      /Invalid managed-block marker id/,
    );
    expect(() => removeManagedBlock("# Base\n", "note-1")).toThrow(
      /Invalid managed-block marker id/,
    );
    expect(() =>
      replaceManagedBlock("# Base\n", "memory:note-1", "x"),
    ).not.toThrow();
  });
});

describe("writeInstructions", () => {
  it("preserves governed memory when the Agent is edited", async () => {
    // The exact hazard PLAN.md calls out: updateAgent() regenerates AGENTS.md,
    // which used to wipe landed memory with no visible cause.
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();
    const agent = makeAgent(root);
    await workspaces.create(agent);

    const filePath = path.join(agent.workspacePath, "AGENTS.md");
    const memory = memoryMarkerId("note-1");
    await writeFile(
      filePath,
      replaceManagedBlock(
        await readFile(filePath, "utf8"),
        memory,
        "Frontend never receives storage credentials.",
      ),
      "utf8",
    );
    await workspaces.writeGroupTaskSection(agent, makeTask(), "Group charter.");

    // Now edit the Agent, exactly as AgentService.updateAgent() does.
    await workspaces.writeInstructions({ ...agent, name: "Backend v2" });

    const after = await readFile(filePath, "utf8");
    expect(after).toContain("Backend v2");
    expect(after).toContain("Frontend never receives storage credentials.");
    expect(after).toContain("<!-- " + memory + " -->");
    expect(after).toContain("Group charter.");
    expect(extractManagedBlocks(after)).toHaveLength(2);
  });

  it("does not duplicate preserved blocks across repeated regenerations", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();
    const agent = makeAgent(root);
    await workspaces.create(agent);
    await workspaces.writeGroupTaskSection(agent, makeTask(), "Group charter.");

    await workspaces.writeInstructions(agent);
    await workspaces.writeInstructions(agent);
    await workspaces.writeInstructions(agent);

    const after = await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8");
    expect(extractManagedBlocks(after)).toHaveLength(1);
  });

  it("clears a group-task section without touching memory", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();
    const agent = makeAgent(root);
    await workspaces.create(agent);

    const filePath = path.join(agent.workspacePath, "AGENTS.md");
    await workspaces.writeGroupTaskSection(agent, makeTask(), "Group charter.");
    await writeFile(
      filePath,
      replaceManagedBlock(
        await readFile(filePath, "utf8"),
        memoryMarkerId("note-1"),
        "Keep this.",
      ),
      "utf8",
    );

    await workspaces.clearGroupTaskSection(agent, "task-1");
    const after = await readFile(filePath, "utf8");
    expect(after).not.toContain("Group charter.");
    expect(after).toContain("Keep this.");
  });
});

describe("shared code", () => {
  it("creates one directory per task and rejects a duplicate", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();

    const first = await workspaces.ensureSharedCodeDirectory("group-1");
    expect(first.path).toBe(workspaces.sharedCodePath("group-1"));
    expect(first.created).toBe(true);
    expect((await lstat(first.path)).isDirectory()).toBe(true);

    // A team's second task REUSES the tree rather than failing: the codebase
    // has to outlive one prompt. `created` distinguishes the two so a failed
    // setup only ever rolls back a directory it made itself.
    await writeFile(path.join(first.path, "kept.ts"), "// task one's work\n");
    const second = await workspaces.ensureSharedCodeDirectory("group-1");
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
    expect(await readFile(path.join(first.path, "kept.ts"), "utf8")).toContain(
      "task one's work",
    );
  });

  it("never places governed memory in shared code", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();
    const shared = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    const agent = makeAgent(root);
    await workspaces.create(agent);
    await workspaces.prepareSharedCode(agent, shared);
    await workspaces.writeGroupTaskSection(agent, makeTask("task-1", shared), "Charter.");

    await expect(readFile(path.join(shared, "AGENTS.md"), "utf8")).rejects.toThrow();
    await expect(
      lstat(path.join(shared, ".agents")),
    ).rejects.toThrow();
    expect(await readFile(path.join(shared, "README.md"), "utf8")).toContain(
      "Code only",
    );
    expect(
      await readFile(path.join(agent.workspacePath, "AGENTS.md"), "utf8"),
    ).toContain("Charter.");
  });

  it("container runtime gets a real mount-point directory, not a link", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root, "container");
    await workspaces.initialize();
    const shared = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    const agent = makeAgent(root);
    await workspaces.create(agent);

    await workspaces.prepareSharedCode(agent, shared);
    const stat = await lstat(path.join(agent.workspacePath, "code"));
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("local-process runtime links ./code to the shared directory, idempotently", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root, "local-process");
    await workspaces.initialize();
    const shared = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    const agent = makeAgent(root);
    await workspaces.create(agent);

    await workspaces.prepareSharedCode(agent, shared);
    await workspaces.prepareSharedCode(agent, shared); // idempotent

    const linkPath = path.join(agent.workspacePath, "code");
    expect((await lstat(linkPath)).isDirectory() || (await lstat(linkPath)).isSymbolicLink())
      .toBe(true);
    // The link must resolve to the shared tree: a file written through ./code
    // lands in shared-code, which is the whole point of A2.
    await writeFile(path.join(linkPath, "probe.txt"), "written through ./code", "utf8");
    expect(await readFile(path.join(shared, "probe.txt"), "utf8")).toBe(
      "written through ./code",
    );
  });

  it("refuses to repoint an existing ./code link at a different team", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root, "local-process");
    await workspaces.initialize();
    const first = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    const second = (await workspaces.ensureSharedCodeDirectory("group-2")).path;
    const agent = makeAgent(root);
    await workspaces.create(agent);

    await workspaces.prepareSharedCode(agent, first);
    await expect(workspaces.prepareSharedCode(agent, second)).rejects.toThrow(
      HttpError,
    );
  });

  it("releases the link without deleting the shared tree", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root, "local-process");
    await workspaces.initialize();
    const shared = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    const agent = makeAgent(root);
    await workspaces.create(agent);
    await workspaces.prepareSharedCode(agent, shared);
    await writeFile(path.join(shared, "keep.txt"), "keep", "utf8");

    await workspaces.releaseSharedCode(agent);

    await expect(lstat(path.join(agent.workspacePath, "code"))).rejects.toThrow();
    expect(await readFile(path.join(shared, "keep.txt"), "utf8")).toBe("keep");
  });

  it("keeps a team's code across tasks, and keeps teams apart", async () => {
    // The bug this pins: shared code used to be keyed by groupTaskId, so every
    // prompt started an empty tree. The transcript still said "I built the
    // upload endpoint" while ./code was empty, and the Agent was asked to
    // extend a file that was not there.
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root, "local-process");
    await workspaces.initialize();
    const agent = makeAgent(root);
    await workspaces.create(agent);

    // Task one writes through ./code, then its link is released as tasks end.
    const taskOne = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    await workspaces.prepareSharedCode(agent, taskOne);
    await writeFile(
      path.join(agent.workspacePath, "code", "uploads.ts"),
      "export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;\n",
    );
    await workspaces.releaseSharedCode(agent);

    // Task two, same team: it must see task one's file.
    const taskTwo = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    expect(taskTwo).toBe(taskOne);
    await workspaces.prepareSharedCode(agent, taskTwo);
    expect(
      await readFile(path.join(agent.workspacePath, "code", "uploads.ts"), "utf8"),
    ).toContain("MAX_UPLOAD_BYTES");

    // A different team still gets its own tree -- persistence is per group,
    // not global.
    const other = (await workspaces.ensureSharedCodeDirectory("group-2")).path;
    expect(other).not.toBe(taskOne);
    expect(await readdir(other)).not.toContain("uploads.ts");
  });

  it("removes only the requested team's shared directory", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root);
    await workspaces.initialize();
    const first = (await workspaces.ensureSharedCodeDirectory("group-1")).path;
    (await workspaces.ensureSharedCodeDirectory("group-2")).path;

    await workspaces.removeSharedCodeDirectory("group-1");

    await expect(lstat(first)).rejects.toThrow();
    expect(await readdir(path.join(root, "shared-code"))).toEqual(["group-2"]);
  });

  it("does not recursively delete a real local code directory", async () => {
    const root = await makeRoot();
    const workspaces = new WorkspaceManager(root, "local-process");
    await workspaces.initialize();
    const agent = makeAgent(root);
    await workspaces.create(agent);
    const codePath = path.join(agent.workspacePath, "code");
    await mkdir(codePath, { recursive: true });
    await writeFile(path.join(codePath, "keep.txt"), "keep", "utf8");

    await workspaces.releaseSharedCode(agent);

    expect(await readFile(path.join(codePath, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("startup workspace assertions", () => {
  it("rejects governed memory under global Codex skills", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "skills", "memory-storage"), { recursive: true });

    await expect(assertNoGovernedMemoryInCodexHome(root)).rejects.toThrow(
      /CODEX_HOME\/skills/,
    );
  });

  it("allows an absent or ordinary global skills directory", async () => {
    const root = await makeRoot();
    await expect(assertNoGovernedMemoryInCodexHome(root)).resolves.toBeUndefined();
    await mkdir(path.join(root, "skills", "ordinary-tool"), { recursive: true });
    await expect(assertNoGovernedMemoryInCodexHome(root)).resolves.toBeUndefined();
  });
});
