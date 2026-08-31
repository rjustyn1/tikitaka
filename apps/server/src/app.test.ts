import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  sendMessage: async (_id: string, body: unknown) => ({ body }),
  systemInfo: async () => ({}),
} as unknown as AgentService;

const groupService = {
  listGroups: () => [],
  listNotes: () => [],
  createGroup: async () => {
    throw new HttpError(501, "Group creation is not implemented yet");
  },
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

describe("group + memory routes", () => {
  it("lists groups and notes as empty arrays", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), groupService);
    const groups = await app.inject({ method: "GET", url: "/api/groups" });
    expect(groups.statusCode).toBe(200);
    expect(groups.json()).toEqual({ groups: [] });

    const notes = await app.inject({ method: "GET", url: "/api/notes" });
    expect(notes.statusCode).toBe(200);
    expect(notes.json()).toEqual({ notes: [] });
    await app.close();
  });

  it("rejects an invalid create-group body with 400", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), groupService);
    const missingMembers = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "No members" }),
    });
    expect(missingMembers.statusCode).toBe(400);
    await app.close();
  });

  it("passes a valid create-group body through to the (stubbed) service", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), groupService);
    const [backendId, frontendId, securityId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const created = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        name: "Upload Feature Team",
        members: [
          { agentId: backendId, role: "backend" },
          { agentId: frontendId, role: "frontend" },
          { agentId: securityId, role: "security" },
        ],
      }),
    });
    // Zod accepted the body; the stub service reports not-implemented.
    expect(created.statusCode).toBe(501);
    await app.close();
  });

  it("accepts 2-8 members, with optional free-form role labels", async () => {
    // A4's exactly-three-one-per-role rule is gone: the planner assigns work
    // from each Agent's description, so `role` is just a label with a default.
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), groupService);
    for (const members of [
      [{ agentId: randomUUID(), role: "data" }, { agentId: randomUUID() }],
      [
        { agentId: randomUUID(), role: "backend" },
        { agentId: randomUUID(), role: "backend" },
      ],
      Array.from({ length: 8 }, () => ({ agentId: randomUUID() })),
    ]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/groups",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ name: "Any Shape", members }),
      });
      // Zod accepted the body; the stub service reports not-implemented.
      expect(created.statusCode).toBe(501);
    }
    await app.close();
  });

  it("rejects out-of-range membership and duplicate Agents with 400", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), groupService);
    const duplicated = randomUUID();
    for (const members of [
      [],
      [{ agentId: randomUUID() }],
      Array.from({ length: 9 }, () => ({ agentId: randomUUID() })),
      [
        { agentId: duplicated, role: "backend" },
        { agentId: duplicated, role: "frontend" },
      ],
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/groups",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ name: "Bad Members", members }),
      });
      expect(rejected.statusCode).toBe(400);
    }
    await app.close();
  });

  it("accepts freshThread on the solo message route", async () => {
    let received: unknown;
    const messageService = {
      ...service,
      sendMessage: async (_id: string, body: unknown) => {
        received = body;
        return { ok: true };
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), messageService);
    const response = await app.inject({
      method: "POST",
      url: "/api/agents/" + randomUUID() + "/messages",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ content: "prove memory", freshThread: true }),
    });
    expect(response.statusCode).toBe(202);
    expect(received).toEqual({ content: "prove memory", freshThread: true });
    await app.close();
  });

  it("rejects an invalid review-note body with 400", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), groupService);
    const badReview = await app.inject({
      method: "POST",
      url: "/api/notes/" + randomUUID() + "/review",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "approve" }),
    });
    expect(badReview.statusCode).toBe(400);
    await app.close();
  });

  it("keeps the auth hook protecting new group routes", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      groupService,
    );
    const denied = await app.inject({ method: "GET", url: "/api/groups" });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("serves the group-shared codebase through its read-only routes", async () => {
    const groupId = randomUUID();
    const agentId = randomUUID();
    const codebaseService = {
      ...groupService,
      listGroupCodeFiles: async (id: string) => {
        expect(id).toBe(groupId);
        return [{ path: "src/api.ts", size: 24 }];
      },
      readGroupCodeFile: async (id: string, filePath: string) => {
        expect(id).toBe(groupId);
        expect(filePath).toBe("src/api.ts");
        return "export const ok = true;\n";
      },
      listGroupAgentWorkspaceFiles: async (id: string, memberId: string) => {
        expect(id).toBe(groupId);
        expect(memberId).toBe(agentId);
        return [{ path: "AGENTS.md", size: 32, kind: "instructions" }];
      },
      readGroupAgentWorkspaceFile: async (id: string, memberId: string, filePath: string) => {
        expect(id).toBe(groupId);
        expect(memberId).toBe(agentId);
        expect(filePath).toBe("AGENTS.md");
        return "# Platform-managed Agent instructions\n";
      },
    } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), codebaseService);

    const files = await app.inject({
      method: "GET",
      url: "/api/groups/" + groupId + "/codebase",
    });
    expect(files.statusCode).toBe(200);
    expect(files.json()).toEqual({ files: [{ path: "src/api.ts", size: 24 }] });

    const file = await app.inject({
      method: "GET",
      url: "/api/groups/" + groupId + "/codebase/file?path=src%2Fapi.ts",
    });
    expect(file.statusCode).toBe(200);
    expect(file.json()).toEqual({ path: "src/api.ts", content: "export const ok = true;\n" });

    const agentFiles = await app.inject({
      method: "GET",
      url: "/api/groups/" + groupId + "/agents/" + agentId + "/workspace",
    });
    expect(agentFiles.statusCode).toBe(200);
    expect(agentFiles.json()).toEqual({
      files: [{ path: "AGENTS.md", size: 32, kind: "instructions" }],
    });

    const agentFile = await app.inject({
      method: "GET",
      url: "/api/groups/" + groupId + "/agents/" + agentId + "/workspace/file?path=AGENTS.md",
    });
    expect(agentFile.statusCode).toBe(200);
    expect(agentFile.json()).toEqual({
      path: "AGENTS.md",
      content: "# Platform-managed Agent instructions\n",
    });
    await app.close();
  });
});
