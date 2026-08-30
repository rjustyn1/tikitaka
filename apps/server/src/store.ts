import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentGroup, AgentRun, Database, GroupRole } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  spans: [],
  groups: [],
  groupTasks: [],
  groupMessages: [],
  groupParticipants: [],
  groupPlanNodes: [],
  contextInjections: [],
  notes: [],
  grants: [],
  runtimeLocks: [],
  landedMemoryFiles: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      if (!Array.isArray(parsed.spans)) parsed.spans = [];
      // Backfill group + memory arrays so pre-group databases still load.
      if (!Array.isArray(parsed.groups)) parsed.groups = [];
      if (!Array.isArray(parsed.groupTasks)) parsed.groupTasks = [];
      if (!Array.isArray(parsed.groupMessages)) parsed.groupMessages = [];
      if (!Array.isArray(parsed.groupParticipants)) parsed.groupParticipants = [];
      if (!Array.isArray(parsed.groupPlanNodes)) parsed.groupPlanNodes = [];
      if (!Array.isArray(parsed.contextInjections)) parsed.contextInjections = [];
      if (!Array.isArray(parsed.notes)) parsed.notes = [];
      if (!Array.isArray(parsed.grants)) parsed.grants = [];
      if (!Array.isArray(parsed.runtimeLocks)) parsed.runtimeLocks = [];
      if (!Array.isArray(parsed.landedMemoryFiles)) parsed.landedMemoryFiles = [];
      for (const group of parsed.groups) {
        backfillGroupMembers(group);
      }
      for (const run of parsed.runs) {
        if (!("traceSummary" in run)) (run as AgentRun).traceSummary = null;
      }
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function backfillGroupMembers(group: AgentGroup): void {
  if (Array.isArray(group.members)) return;
  const legacy = group as AgentGroup & { memberAgentIds?: unknown };
  const legacyMemberAgentIds = Array.isArray(legacy.memberAgentIds)
    ? legacy.memberAgentIds.filter((value): value is string => typeof value === "string")
    : [];
  const roles: GroupRole[] = ["backend", "frontend", "security"];
  group.members = legacyMemberAgentIds.slice(0, roles.length).map((agentId, index) => ({
    agentId,
    role: roles[index]!,
  }));
}
