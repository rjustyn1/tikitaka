import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
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
    const created = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        // A4 - role-bound membership: exactly three members, one per role.
        name: "Upload Feature Team",
        members: [
          { agentId: randomUUID(), role: "backend" },
          { agentId: randomUUID(), role: "frontend" },
          { agentId: randomUUID(), role: "security" },
        ],
      }),
    });
    // Zod accepted the body; the stub service reports not-implemented.
    expect(created.statusCode).toBe(501);
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
});
