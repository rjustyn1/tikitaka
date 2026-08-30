/**
 * HTTP boundary tests owned by Person 4 (`app.test.ts` belongs to Person 1).
 *
 * These run the app in PRODUCTION mode. Every other suite builds it with
 * NODE_ENV=test, which skips the static-file plugin — and that is precisely why
 * a production-only regression in the error handler went unnoticed until the
 * frontend surfaced it.
 */
import { describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const groupService = {
  listGroups: () => [],
  listNotes: () => [],
} as unknown as AgentService;

/**
 * Production config. HOST must be loopback: `loadConfig` refuses a
 * non-loopback production server without a long APP_AUTH_TOKEN.
 */
const productionConfig = () =>
  loadConfig({ NODE_ENV: "production", HOST: "127.0.0.1" });

describe("HTTP boundary in production", () => {
  it("returns 400 with a readable message for an invalid body", async () => {
    // Regression: the custom error handler was registered AFTER
    // `await app.register(fastifyStatic)`, which only happens in production. It
    // therefore never took effect there, and every validation error came back
    // as a 500 carrying the raw ZodError JSON dump as its message. In the
    // deployed app that meant "Internal Server Error" for every bad input.
    const app = await createApp(productionConfig(), groupService);
    const response = await app.inject({
      method: "POST",
      url: "/api/groups",
      payload: { name: "", members: [] },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details?: unknown[] };
    expect(body.error).toBe(
      "name: Too small: expected string to have >=1 characters",
    );
    // The raw dump must not be the human-facing message.
    expect(body.error).not.toContain("{");
    // Structured issues stay available for anything reading the API.
    expect(Array.isArray(body.details)).toBe(true);
    expect((body.details ?? []).length).toBeGreaterThan(0);
    await app.close();
  });

  it("still serves the SPA and keeps /api 404s as JSON", async () => {
    const app = await createApp(productionConfig(), groupService);

    const spa = await app.inject({ method: "GET", url: "/" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<div id="root">');

    const missing = await app.inject({ method: "GET", url: "/api/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "API route not found" });
    await app.close();
  });

  it("reports the failing field, not just the first message", async () => {
    const app = await createApp(productionConfig(), groupService);
    const response = await app.inject({
      method: "POST",
      url: "/api/groups",
      payload: {
        name: "Team",
        members: [
          { agentId: "11111111-1111-4111-8111-111111111111", role: "backend" },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string };
    expect(body.error).toContain("members");
    await app.close();
  });
});
