import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("backfills group + memory arrays when loading a pre-group database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-backfill-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const legacy = {
      version: 1,
      agents: [
        {
          id: "agent-1",
          name: "Legacy",
          description: "",
          instructions: "",
          status: "ready",
          workspacePath: "/tmp/agent-1",
          codexThreadId: null,
          lastError: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      messages: [],
      runs: [],
      spans: [],
    };
    await writeFile(filePath, JSON.stringify(legacy), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();
    const snapshot = store.snapshot();

    // Existing data is preserved.
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["agent-1"]);
    // Every new array exists and is empty.
    for (const key of [
      "groups",
      "groupTasks",
      "groupMessages",
      "groupParticipants",
      "groupPlanNodes",
      "contextInjections",
      "notes",
      "grants",
      "runtimeLocks",
      "landedMemoryFiles",
    ] as const) {
      expect(Array.isArray(snapshot[key])).toBe(true);
      expect(snapshot[key]).toEqual([]);
    }
  });
});
