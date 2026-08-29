import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { RunTraceSummary, TraceSpan } from "./types.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  freshThread: z.boolean().default(false),
});

// Group + governed-memory route schemas (see middlewaredoc/SPEC.md).
const groupIdParams = z.object({ id: z.string().uuid() });
const groupTaskParams = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
});
const noteIdParams = z.object({ id: z.string().uuid() });
const taskIdParams = z.object({ id: z.string().uuid() });

const groupMemberBody = z.object({
  agentId: z.string().uuid(),
  role: z.enum(["backend", "frontend", "security"]),
});

const groupMembersBody = z
  .array(groupMemberBody)
  .length(3)
  .superRefine((members, ctx) => {
    const agentIds = new Set(members.map((member) => member.agentId));
    if (agentIds.size !== members.length) {
      ctx.addIssue({
        code: "custom",
        message: "Each Agent can appear only once in a group",
      });
    }
    const roles = new Set(members.map((member) => member.role));
    for (const role of ["backend", "frontend", "security"] as const) {
      if (!roles.has(role)) {
        ctx.addIssue({
          code: "custom",
          message: "Group must include one " + role + " member",
        });
      }
    }
  });

const createGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  // A4 - exactly three members, one per role. Replaces memberAgentIds.
  members: groupMembersBody,
});

const updateGroupBody = createGroupBody
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const startGroupTaskBody = z.object({
  prompt: z.string().trim().min(1).max(50_000),
});

const reviewNoteBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), reviewerName: z.string().trim().min(1) }),
  z.object({
    type: z.literal("edit"),
    reviewerName: z.string().trim().min(1),
    content: z.string().trim().min(1).max(2000).optional(),
    severity: z.enum(["normal", "severe"]).optional(),
    targetAgentIds: z.array(z.string().uuid()).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    approveAfterEdit: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("reject"),
    reviewerName: z.string().trim().min(1),
    reason: z.string().trim().min(1).max(500),
  }),
]);

const revokeNoteBody = z.object({
  reviewerName: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500),
});

const notesQuery = z.object({
  agentId: z.string().uuid().optional(),
  status: z
    .enum(["candidate", "pending", "quarantined", "active", "rejected", "revoked"])
    .optional(),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/runs/:id/trace", async (request) => {
    const { id } = runIdParams.parse(request.params);
    const query = request.query as Record<string, string | undefined>;
    const { run, spans } = service.getSpans(id);
    const typeFilter = query.type?.split(",").filter(Boolean);
    const statusFilter = query.status?.split(",").filter(Boolean);
    const filteredSpans: TraceSpan[] = spans.filter((s) => {
      if (typeFilter?.length && !typeFilter.includes(s.type)) return false;
      if (statusFilter?.length && !statusFilter.includes(s.status)) return false;
      return true;
    });
    const summary: RunTraceSummary = run.traceSummary ?? {
      spanCount: spans.length,
      failedSpanCount: spans.filter((s) => s.status === "failed").length,
      reasoningCount: spans.filter((s) => s.type === "reasoning").length,
      actionCount: spans.filter(
        (s) => s.type !== "reasoning" && s.type !== "error",
      ).length,
    };
    return { run, summary, spans: filteredSpans };
  });

  // --- Groups ---------------------------------------------------------------

  app.get("/api/groups", async () => ({ groups: service.listGroups() }));

  app.post("/api/groups", async (request, reply) => {
    const body = createGroupBody.parse(request.body);
    const group = await service.createGroup(body);
    return reply.code(201).send({ group });
  });

  app.get("/api/groups/:id", async (request) => {
    const { id } = groupIdParams.parse(request.params);
    return { group: service.getGroup(id) };
  });

  app.patch("/api/groups/:id", async (request) => {
    const { id } = groupIdParams.parse(request.params);
    const body = updateGroupBody.parse(request.body);
    return { group: await service.updateGroup(id, body) };
  });

  // --- Group tasks ------------------------------------------------------------

  app.post("/api/groups/:id/tasks", async (request, reply) => {
    const { id } = groupIdParams.parse(request.params);
    const body = startGroupTaskBody.parse(request.body);
    const task = await service.startGroupTask(id, body.prompt);
    return reply.code(202).send({ task });
  });

  app.get("/api/groups/:id/tasks/:taskId", async (request) => {
    const { taskId } = groupTaskParams.parse(request.params);
    return service.getGroupTask(taskId);
  });

  app.post("/api/groups/:id/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = groupTaskParams.parse(request.params);
    const task = await service.cancelGroupTask(taskId);
    return reply.code(202).send({ task });
  });

  app.get("/api/groups/:id/tasks/:taskId/timeline", async (request) => {
    const { taskId } = groupTaskParams.parse(request.params);
    return { messages: service.getGroupTask(taskId).messages };
  });

  app.get("/api/groups/:id/tasks/:taskId/context-injections", async (request) => {
    const { taskId } = groupTaskParams.parse(request.params);
    return { contextInjections: service.getGroupTask(taskId).contextInjections };
  });

  // --- Governed memory notes --------------------------------------------------

  app.get("/api/notes", async (request) => {
    const query = notesQuery.parse(request.query);
    return { notes: service.listNotes(query) };
  });

  app.post("/api/notes/:id/review", async (request) => {
    const { id } = noteIdParams.parse(request.params);
    const body = reviewNoteBody.parse(request.body);
    return { note: await service.reviewNote(id, body) };
  });

  app.post("/api/notes/:id/revoke", async (request) => {
    const { id } = noteIdParams.parse(request.params);
    const body = revokeNoteBody.parse(request.body);
    return { note: await service.revokeNote(id, body) };
  });

  // --- Audit views ------------------------------------------------------------

  app.get("/api/agents/:id/memory", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { files: service.listAgentMemory(id) };
  });

  app.get("/api/tasks/:id/grants", async (request) => {
    const { id } = taskIdParams.parse(request.params);
    return { grants: service.listTaskGrants(id) };
  });

  /**
   * A ZodError's `message` is the JSON dump of every issue. Sent as-is it
   * reaches the UI as a wall of braces, so summarise it for humans and keep the
   * structured issues in `details` for anything reading the API.
   */
  const describeValidation = (error: z.ZodError): string => {
    const issue = error.issues[0];
    if (!issue) return "Invalid request";
    const field = issue.path.join(".");
    return field ? field + ": " + issue.message : issue.message;
  };

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: validationError ? describeValidation(error) : appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }


  return app;
}
