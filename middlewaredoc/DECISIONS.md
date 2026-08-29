# Decision Record

> **The one question this answers: what did we decide, and on what evidence.**
> Each entry is closed. Where a decision changed a contract, `SPEC.md` carries
> the contract and this file carries the reason. New decisions append here.

# Resolved Blockers (A1-A5)

Design review found five cross-cutting items that were unowned or unverified.
All five are now closed. A1 and A2 were settled empirically against the pinned
runtime (`@openai/codex@0.111.0` inside `volc-agent-launchpad:local`); A3-A5 are
decisions recorded here. Read this section before starting your workstream.

## A1 - Skill Placement: VERIFIED WORKING

Method: `codex app-server` + `skills/list` RPC across three prepared workspaces.
No model call required, so anyone can re-run this check.

Results:

```text
<cwd>/.agents/skills/<name>/SKILL.md   -> discovered, scope "repo"   USE THIS
<cwd>/.codex/skills/<name>/SKILL.md    -> discovered, scope "repo"   also valid
$CODEX_HOME/skills/<name>/SKILL.md     -> discovered, scope "user"   GLOBAL - NEVER USE
empty workspace                        -> zero repo skills           no leakage
non-git-repo cwd                       -> repo skills still found    no git needed
```

Consequences:

```text
Placement-based security works as designed. Keep .agents/skills.
The "empty workspace cannot leak" demo beat is real and reproducible.
```

Hard rule for Person 3 (LandingService):

```text
Governed memory is NEVER written under $CODEX_HOME.
This deployment shares one codex-home volume across every Agent, so a skill
landed there is visible to all Agents and silently voids the security claim.
Add a startup assertion that $CODEX_HOME/skills contains no governed memory.
```

Residual check, folded into the first end-to-end run: `skills/list` proves
discovery, not that `codex exec` *fires* the skill. Verify once a valid API key
exists. Use explicit `$skill-name` invocation for the demo.

## A2 - Shared Code Writability: RESOLVED

**Both runtimes matter.** `npm run poc` runs `scripts/start-local-poc.sh`, which
exports `RUNTIME_PROVIDER=container`, so `ContainerCodexRunner` is the runner for
local dev and the demo. The committed `.env` says `local-process`, which is the
ECS/Compose deployment path. Solve both; the container path is the one you will
actually use day to day.

### Container runtime - use a nested bind mount, no symlink

`buildContainerRunArgs()` currently mounts only the Agent workspace and
`codex-home`. A `code -> ../shared-code/<taskId>` symlink therefore **dangles
inside the container** - verified: `cannot create code/y.txt: Directory
nonexistent`. Add one mount, nested inside the workspace mount:

```ts
// container-codex-runner.ts, buildContainerRunArgs()
"--mount", "type=bind,src=" + request.workspacePath + ",dst=/workspace",
...(request.sharedCodePath
  ? ["--mount", "type=bind,src=" + request.sharedCodePath + ",dst=/workspace/code"]
  : []),
"--mount", "type=bind,src=" + config.codexHome + ",dst=/codex-home",
```

Verified behaviour of this layout:

```text
./code inside the container is a REAL directory, not a symlink
reads and writes both work; writes land on the host
nothing leaks into the private Agent workspace
Docker creates the mountpoint if <workspace>/code does not exist
two Agents mounting the same shared-code concurrently is fine
```

The decisive advantage: `/workspace/code` is **inside** the cwd, so Codex's
`workspace-write` sandbox permits it natively and **no `--add-dir` is needed in
container mode.** One contiguous writable tree, no path-resolution footguns.

### Local-process runtime - symlink plus `--add-dir`

Bind mounts need root, so this path keeps the symlink. Here `./code` resolves
outside the cwd, so it does need `--add-dir` (present in 0.111.0 and accepted by
`codex exec`):

```ts
// types.ts
interface RunnerRequest {
  // ...existing fields
  sharedCodePath?: string;   // container: extra mount; local-process: --add-dir
}

// codex-runner.ts buildCodexArgs() - after the -C flag
if (request.sharedCodePath) args.push("--add-dir", request.sharedCodePath);
```

`WorkspaceManager.prepareSharedCode(agent, sharedCodePath)` branches once on
`config.runtimeProvider`: create the symlink for `local-process`, create an empty
mountpoint directory for `container`. That is the only place the two runtimes
differ. Solo runs pass no `sharedCodePath` and are unaffected.

### Also fix in container mode

`containerName()` is keyed by `agentId`, and `docker run --name` fails on a
duplicate. This is a second instance of the A3 collision: a solo run and a group
node for the same Agent will collide on the container name, not just on
`CodexRunner.active`. The A3 lease fixes both; do not add a second mechanism.

### Sandbox posture

Codex's Linux Landlock sandbox is unavailable on Docker Desktop for Mac (the
linuxkit kernel exposes landlock syscalls as unimplemented weak symbols;
`codex sandbox linux` fails with `Sandbox(LandlockRestrict)` even when
privileged). `docs/LOCAL_POC.md` already documents the degradation: startup warns
and disables the inner Codex sandbox while the outer container limits remain.

```text
The outer container is the real boundary: cap_drop ALL, no-new-privileges,
cpu/memory/pids limits, and a per-turn disposable container.
Do not claim OS-enforced per-Agent sandboxing. See ARCHITECTURE.md 10.6.
```

Minor known quirk: files written by the container come back to the host with
gid 0 rather than the host gid (Docker Desktop virtiofs). The uid matches, so
they stay host-writable. Not blocking.

## A3 - Agent Concurrency Lease: RESOLVED

Problem: `CodexRunner.active` is keyed by `agentId` and throws
`"Agent already has an active Codex process"` on a second concurrent run.
`cancel(agentId)` is agent-keyed too. Nothing in the group design set
`agent.status = "busy"`, so a solo message sent during a group task bypassed the
existing 409 guard and surfaced as a raw 500, and `stopAgent()` would kill a
running group node.

Decision: one shared lease, owned by `AgentService`, used by both paths.

Person 1 adds the seam:

```ts
interface AgentLease {
  acquireAgent(agentId: string, holder: AgentLeaseHolder): Promise<Agent>;
  releaseAgent(agentId: string, holder: AgentLeaseHolder): Promise<void>;
}

type AgentLeaseHolder =
  | { kind: "solo"; runId: string }
  | { kind: "group"; groupTaskId: string; planNodeId: string };
```

Rules:

```text
acquireAgent sets status busy inside one store.mutate() and throws 409 if held.
The existing sendMessage() busy check becomes a call to acquireAgent.
releaseAgent runs in a finally block on both paths.
stopAgent on a group-held Agent returns 409 naming the group task.
Cancelling a group task releases every lease it holds.
initialize() clears stale leases on restart, alongside the existing run reset.
```

Person 2 calls `acquireAgent`/`releaseAgent` in `runPlanNode()`. Person 2 does
not touch `CodexRunner.active` directly.

## A4 - Sequential v1 With A Fixed 5-Node Chain: RESOLVED

First, a contradiction that had to be settled before anyone codes.

```text
ARCHITECTURE.md section 9 : "Today that's a hardcoded sequential chain
                             (backend -> frontend -> security); later it can
                             be a dependency-graph (DAG) planner."

GROUP-CHAT-DESIGN.md      : branch-and-join DAG as the FIRST demo
GROUP-RUNNER.md           : seven-node preseeded DAG, parallel-set validation
```

**Decision: ARCHITECTURE.md wins. v1 is a hardcoded sequential chain.**
Branch-and-join is stretch scope, built only if the sequential demo ships first.

### The v1 chain

A fixed five-node template. Backend and Frontend each take two turns, so the
demo still tells the plan-then-implement story:

```text
1  backend-contract   Backend    propose endpoint contract and storage flow
2  frontend-plan      Frontend   plan UI/API integration from that contract
3  security-review    Security   review auth, validation, secret boundaries
4  backend-impl       Backend    implement backend changes under code/apps/server
5  frontend-impl      Frontend   implement frontend changes under code/apps/web
```

Built as a degenerate DAG so the data model and the whole downstream pipeline
are unchanged:

```text
node[0].dependsOn = []
node[i].dependsOn = [node[i-1].id]
node[4] is the single sink
```

`decideFlush()` in `FLUSH-TRIGGER.md` already handles this and needs no edit.
TASK-BUFFER's topological sort over a chain is just the chain. Upgrading to a
real DAG later is a **planner** change, not a pipeline change - which is exactly
the claim ARCHITECTURE.md section 9 makes.

### Membership contract - role-bound

The template references **roles**, never Agent names or list order, so any three
Agents can play the demo:

```ts
type GroupRole = "backend" | "frontend" | "security";

interface GroupMemberInput {
  agentId: string;
  role: GroupRole;
}

interface CreateGroupInput {
  name: string;
  description?: string;
  members: GroupMemberInput[];   // replaces memberAgentIds: string[]
}
```

```ts
const createGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  members: z.array(z.object({
    agentId: z.string().uuid(),
    role: z.enum(["backend", "frontend", "security"]),
  })).length(3),
});
```

Rules:

```text
Exactly three members, one per role, each Agent used once.
Chain nodes bind to role, so node 1 and node 4 both resolve to the backend member.
role feeds GroupParticipantState.role and the per-turn identity prompt.
startGroupTask rejects a group missing a role with 409:
  "This plan needs one backend, one frontend, and one security member."
```

Person 4's group modal: Agent toggles plus a role selector per selected Agent,
submit blocked until all three roles are filled exactly once. Render the
resulting chain above the composer so the order is never a surprise.

### Interaction with A3

An Agent taking two turns is safe under the A3 lease **without re-entrancy**,
because the chain is sequential: node 1 acquires and releases the backend lease,
then node 4 acquires it again later. There is never an overlap. Do not build a
re-entrant lease.

### Scope split

```text
V1 - BUILD NOW
  the five-node chain above, executed by a plain for-loop
  GroupRuntimeLock ROWS written per node (see below)
  membershipEpoch / removedAt / fresh groupThreadId on re-add
  context injection records with injectedMessageIds / withheldMessageIds
  lastSeenSeq dedupe - it does real work here, since Backend runs twice

STRETCH - only after the sequential demo runs end to end
  branch and join nodes, join-owner selection rule
  parallel-set validation (no Agent twice in a phase, no write-path overlap)
  runtime-lock COLLISION VALIDATION
  Promise.all over runnable node sets
```

Two notes on what was kept:

```text
Runtime locks: keep writing GroupRuntimeLock rows per node. A node declaring it
held code/apps/server/** is legible evidence in the UI. Skip only the collision
validation, which cannot fire while one node runs at a time.

Context injections: keep the records and the lastSeenSeq logic. But in a chain,
"withheld" means ALREADY SEEN, not DENIED BY POLICY. Label it that way in the UI
and in the demo script. Calling dedupe "governance" would misrepresent the
system on stage.
```

> Demo narrative note: the "branch context does not leak sibling output" beat
> **does not exist in a sequential chain** - there are no siblings. Do not
> promise it. The v1 governance story is the memory grant/denial pair (A5),
> which is the actual contribution and does not depend on the DAG at all.

## A5 - The Proof Beat: RESOLVED

Problem: the demo's payoff is "memory landed, and a later run uses it", but a
resumed Codex thread may not re-read a changed `AGENTS.md` (see `GROUP-CHAT-DESIGN.md`
and ARCHITECTURE.md section 10.2). No workstream owned this, so the demo had no
verified closing beat.

Decision: the proof run is a **fresh-thread solo run** against the target Agent.

Person 1 adds one optional field to the existing solo message route:

```ts
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
  freshThread: z.boolean().default(false),
});
```

`AgentService.sendMessage()` passes `threadId: null` when `freshThread` is true,
so Codex starts a new thread and reads `AGENTS.md` plus `.agents/skills` from
disk. Nothing else changes; `Agent.codexThreadId` is still updated from the
result.

Person 4 builds the beat as two clicks from the landed-memory view:

```text
positive: fresh-thread run on the TARGET Agent
          prompt invokes the skill explicitly by $skill-name
          Agent answers using the landed memory

negative: same prompt, same moment, on a WITHHELD Agent
          that workspace has no such file
          Agent cannot answer, and the ledger says why it was withheld
```

Run both beats back to back. That pair is the whole contribution in fifteen
seconds: a grant, a denial, and a named reason.

---

## Corrections To Component TDs

```text
CONSOLIDATOR.md
  Do not ask the extractor to echo UUIDs. z.string().uuid() on sourceSpanIds
  will reject nearly every real response. Give the extractor short integer
  indices into TaskBuffer.entries and map back to run/span IDs server-side.

SAFETY.md
  generic_api_key /\b[A-Za-z0-9_-]{32,}\b/g matches every UUID, including the
  agent, run, and span IDs a note legitimately cites. env_assignment matches
  ordinary prose like "MAX_SIZE = 10MB". As written, redactionFired trips on
  almost every note and everything routes to review. Either narrow the patterns
  or make this behaviour a deliberate, documented demo choice.

SPEC.md (Part 2 - API Routes)
  Drop /timeline and /context-injections. GroupTaskResponse already carries
  messages and contextInjections; three polling endpoints is drift waiting to
  happen.

FRONTEND-UI.md
  api.ts request() takes a pre-stringified body. Every snippet in that TD passes
  a raw object, which would POST "[object Object]". Fix request() to stringify
  objects once, then the snippets are correct.

LEDGER.md / FRONTEND-UI.md
  Notes and grants carry only UUIDs. Resolve Agent and group names into the
  response DTOs, or the ledger view is an unreadable wall of hex on stage.
```

---
