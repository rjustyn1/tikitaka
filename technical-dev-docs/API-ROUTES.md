# API Routes Technical Design

## Component

`apps/server/src/app.ts`

## Purpose

Expose group task execution, memory review, and audit data to the frontend.

## Routes

```text
GET    /api/groups
POST   /api/groups
GET    /api/groups/:id
PATCH  /api/groups/:id

POST   /api/groups/:id/tasks
GET    /api/groups/:id/tasks/:taskId
GET    /api/groups/:id/tasks/:taskId/timeline
GET    /api/groups/:id/tasks/:taskId/context-injections

GET    /api/notes?agentId=&status=
POST   /api/notes/:id/review
POST   /api/notes/:id/revoke

GET    /api/agents/:id/memory
GET    /api/tasks/:id/grants
```

## Code-Level Spec

Add Zod schemas near the existing route schemas:

```ts
const groupIdParams = z.object({ id: z.string().uuid() });
const groupTaskParams = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
});
const noteIdParams = z.object({ id: z.string().uuid() });
const taskIdParams = z.object({ id: z.string().uuid() });

const createGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  memberAgentIds: z.array(z.string().uuid()).min(1),
});

const updateGroupBody = createGroupBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

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
```

Route handlers:

```ts
app.get("/api/groups", async () => ({ groups: service.listGroups() }));

app.post("/api/groups", async (request, reply) => {
  const body = createGroupBody.parse(request.body);
  return reply.code(201).send({ group: await service.createGroup(body) });
});

app.post("/api/groups/:id/tasks", async (request, reply) => {
  const { id } = groupIdParams.parse(request.params);
  const body = startGroupTaskBody.parse(request.body);
  return reply.code(202).send({ task: await service.startGroupTask(id, body.prompt) });
});

app.get("/api/groups/:id/tasks/:taskId", async (request) => {
  const { taskId } = groupTaskParams.parse(request.params);
  return service.getGroupTask(taskId);
});
```

Prefer adding methods to `AgentService` that delegate to `GroupRunner` and
memory services. Keep Fastify routes thin.

## Route Ownership

Routes should stay thin:

- validate request body with `zod`;
- call `AgentService` or memory service methods;
- return DTOs;
- never perform workspace writes directly.

## Important Errors

```text
400 invalid request body
404 group/task/note not found
409 group task already running
409 membership cannot change during running task
409 agent already busy
503 Ark/Codex unavailable when required
```

## Polling Shape

Task endpoint returns:

```ts
interface GroupTaskResponse {
  task: GroupTask;
  nodes: GroupPlanNode[];
  messages: GroupMessage[];
  contextInjections: GroupContextInjection[];
}
```

## Tests

- create group with selected Agent IDs;
- reject membership updates while task running;
- start group task;
- return timeline and node statuses;
- review note;
- revoke note;
- auth hook still protects new API routes.
