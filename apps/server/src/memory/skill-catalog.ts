import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Agent } from "../types.js";
import type { SkillProfile } from "./recognizer.js";

const SKILLS_DIR = ".agents/skills";

/** Read only the public skill metadata for one Agent's private workspace. */
export async function loadAgentSkillProfiles(agent: Agent): Promise<SkillProfile[]> {
  const root = path.join(agent.workspacePath, SKILLS_DIR);
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const profiles: SkillProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSkillKey(entry.name)) continue;
    try {
      const source = await readFile(path.join(root, entry.name, "SKILL.md"), "utf8");
      const metadata = readFrontmatter(source);
      if (!metadata) continue;
      profiles.push({
        skillKey: entry.name,
        name: metadata.name,
        description: metadata.description,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return profiles.sort((left, right) => left.skillKey.localeCompare(right.skillKey));
}

export function isValidSkillKey(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value);
}

function readFrontmatter(source: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, ""),
    );
  }
  const name = fields.get("name")?.trim();
  const description = fields.get("description")?.trim();
  return name && description ? { name, description } : null;
}
