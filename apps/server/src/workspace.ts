import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export function replaceManagedBlock(
  existing: string,
  markerId: string,
  body: string,
): string {
  const start = "<!-- " + markerId + " -->";
  const end = "<!-- /" + markerId + " -->";
  const block = start + "\n" + body.trimEnd() + "\n" + end;
  const startIndex = existing.indexOf(start);
  if (startIndex < 0) {
    return existing.trimEnd() + "\n\n" + block + "\n";
  }
  const endIndex = existing.indexOf(end, startIndex);
  if (endIndex < 0) {
    throw new Error("Managed block is missing end marker: " + end);
  }
  return (
    existing.slice(0, startIndex).trimEnd() +
    "\n\n" +
    block +
    "\n" +
    existing.slice(endIndex + end.length).replace(/^\s*\n?/, "")
  );
}

export function removeManagedBlock(existing: string, markerId: string): string {
  const start = "<!-- " + markerId + " -->";
  const end = "<!-- /" + markerId + " -->";
  const startIndex = existing.indexOf(start);
  if (startIndex < 0) return existing;
  const endIndex = existing.indexOf(end, startIndex);
  if (endIndex < 0) {
    throw new Error("Managed block is missing end marker: " + end);
  }
  return (
    existing.slice(0, startIndex).trimEnd() +
    "\n" +
    existing.slice(endIndex + end.length).replace(/^\s*\n?/, "")
  );
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
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

  async writeInstructions(agent: Agent): Promise<void> {
    const existing = await readTextIfExists(path.join(agent.workspacePath, "AGENTS.md"));
    const preservedMemoryBlocks = extractManagedBlocks(existing, "memory");
    const content = [
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
      "This file is regenerated when the Agent configuration is updated.",
      "",
      ...preservedMemoryBlocks,
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function extractManagedBlocks(existing: string, prefix: string): string[] {
  const blocks: string[] = [];
  const regex = new RegExp(
    "<!-- " + escapeRegExp(prefix) + ":[^>]+ -->[\\s\\S]*?<!-- /" +
      escapeRegExp(prefix) +
      ":[^>]+ -->",
    "g",
  );
  for (const match of existing.matchAll(regex)) {
    blocks.push(match[0]);
  }
  return blocks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
