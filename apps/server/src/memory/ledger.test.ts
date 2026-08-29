import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { LedgerService } from "./ledger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function freshStore(): Promise<JsonStore> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-ledger-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

describe("LedgerService", () => {
  it("records a grant for a target Agent with its file path", async () => {
    const store = await freshStore();
    const ledger = new LedgerService(store);

    const record = await ledger.recordGrant({
      groupTaskId: "task-1",
      noteId: "note-1",
      agentId: "agent-frontend",
      filePath: "/ws/agent-frontend/AGENTS.md",
    });

    expect(record.decision).toBe("granted");
    expect(record.filePath).toBe("/ws/agent-frontend/AGENTS.md");
    expect(store.snapshot().grants).toHaveLength(1);
  });

  it("records a withheld decision with a named reason", async () => {
    const store = await freshStore();
    const ledger = new LedgerService(store);

    const record = await ledger.recordWithheld({
      groupTaskId: "task-1",
      noteId: "note-1",
      agentId: "agent-security",
      reason: "not_targeted",
    });

    expect(record.decision).toBe("withheld");
    expect(record.reason).toBe("not_targeted");
    expect(record.filePath).toBeNull();
  });

  it("records one rejected row per candidate Agent", async () => {
    const store = await freshStore();
    const ledger = new LedgerService(store);

    const records = await ledger.recordRejected({
      groupTaskId: "task-1",
      noteId: "note-1",
      candidateAgentIds: ["agent-a", "agent-b"],
      reviewerName: "Lionel",
      reason: "off-scope leak",
    });

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.decision === "rejected")).toBe(true);
    expect(records.every((r) => r.reviewerName === "Lionel")).toBe(true);
  });

  it("records a revoke without deleting the original grant (append-only)", async () => {
    const store = await freshStore();
    const ledger = new LedgerService(store);

    await ledger.recordGrant({
      groupTaskId: "task-1",
      noteId: "note-1",
      agentId: "agent-frontend",
      filePath: "/ws/agent-frontend/AGENTS.md",
    });
    await ledger.recordRevoked({
      groupTaskId: "task-1",
      noteId: "note-1",
      grantedAgentIds: ["agent-frontend"],
      reviewerName: "Lionel",
      reason: "no longer applies",
    });

    const grants = store.snapshot().grants;
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.decision)).toEqual(["granted", "revoked"]);
  });

  it("lists grants scoped by task and by note", async () => {
    const store = await freshStore();
    const ledger = new LedgerService(store);

    await ledger.recordGrant({
      groupTaskId: "task-1",
      noteId: "note-1",
      agentId: "agent-a",
      filePath: "/ws/a/AGENTS.md",
    });
    await ledger.recordGrant({
      groupTaskId: "task-2",
      noteId: "note-2",
      agentId: "agent-b",
      filePath: "/ws/b/AGENTS.md",
    });

    expect(ledger.listTaskGrants("task-1")).toHaveLength(1);
    expect(ledger.listNoteGrants("note-2")).toHaveLength(1);
    expect(ledger.listNoteGrants("note-2")[0]?.agentId).toBe("agent-b");
  });
});
