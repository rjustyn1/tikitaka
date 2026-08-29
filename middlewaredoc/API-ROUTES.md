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
  // A4: exactly three members, one per role. Replaces memberAgentIds.
  members: z.array(z.object({
    agentId: z.string().uuid(),
    role: z.enum(["backend", "frontend", "security"]),
  })).length(3),
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

---

## Additions From The A1-A5 Review

### A5 - freshThread on the existing solo message route

The proof beat reuses `POST /api/agents/:id/messages`. One optional field:

```ts
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  // A5: start a NEW Codex thread so AGENTS.md and .agents/skills are re-read.
  freshThread: z.boolean().default(false),
});
```

No new route. `AgentService.sendMessage()` passes `threadId: null` when set.

### A4 - membership validation

```text
POST /api/groups          400 unless exactly three members, one per role
PATCH /api/groups/:id     409 while group.activeTaskId is set
POST /api/groups/:id/tasks 409 if a role is missing:
  "This plan needs one backend, one frontend, and one security member."
```

### A3 - lease-aware error codes

```text
409 agent already busy       solo run attempted while a group node holds the lease
409 agent held by group task include the groupTaskId in the message
```

Routes must surface these as 409, never as a 500. Today a solo message sent
during a group run reaches `CodexRunner` and throws
`"Agent already has an active Codex process"` as an unhandled error.

### Alias routes - must not drift

`/timeline` and `/context-injections` return data already present in
`GroupTaskResponse`. Keep them, but implement both as **thin projections of the
same service call**, never as independent queries:

```ts
const full = service.getGroupTask(taskId);

app.get("/api/groups/:id/tasks/:taskId/timeline", async (request) =>
  ({ messages: full.messages }));

app.get("/api/groups/:id/tasks/:taskId/context-injections", async (request) =>
  ({ contextInjections: full.contextInjections }));
```

Person 4 should poll `GET /api/groups/:id/tasks/:taskId` only. The aliases exist
for debugging and for narrating the demo, not for the polling loop.

### Route list correction

`GET /api/groups/:id` is specified in this document but was missing from
Person 1's build scope in `IMPLEMENTATION_DIRECTION.md`. It is in scope.

### Cancel a running group task

Not previously specified anywhere, and needed: `CODEX_TIMEOUT_MS` defaults to
600s and the v1 chain has five nodes.

```text
POST /api/groups/:id/tasks/:taskId/cancel   -> 202
  marks the task cancelled
  cancels the in-flight node run
  releases the Agent lease and any runtime lock rows
  remaining nodes are marked cancelled, never started
```
