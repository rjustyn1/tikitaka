# Project Structure — Build Map

> Where the design in [`ARCHITECTURE.md`](./ARCHITECTURE.md) plugs into the
> existing codebase, and the module layout to add. This is a **map, not a spec** —
> field lists, schemas, and endpoint bodies are deferred (see ARCHITECTURE §11).

---

## 1. What already exists (reuse, do not rebuild)

The `feature/tracing` branch already provides the capture layer:

| File | What it gives us | Our change |
|---|---|---|
| `apps/server/src/codex-runner.ts` | `parseCodexEventLine` — parses the Codex event stream into ordered, linked spans; buffers per run; flushes to store at run terminal | **none** — consume its output |
| `apps/server/src/workspace.ts` | `WorkspaceManager` — creates each agent's workspace dir and writes its `AGENTS.md` | **extend** — add skill/AGENTS-entry writing |
| `apps/server/src/store.ts` | single-JSON store, atomic whole-file writes, defensive array init | **extend** — add new arrays |
| `apps/server/src/types.ts` | `Agent`, `Run`, `TraceSpan`, runner interfaces | **extend** — add new types |
| `apps/server/src/agent-service.ts` | `executeRun`, `sendMessage` | **extend** — trigger consolidation at task terminal |
| `apps/server/src/app.ts` | Fastify routes | **extend** — add new routes |

---

## 2. New module layout

Group the new code under `apps/server/src/memory/` so it reads as one subsystem:

```
apps/server/src/
├── memory/
│   ├── group-runner.ts        # dispatch a shared task across agents (sequential now),
│   │                          #   pass chain context, collect run ids, detect task terminal
│   ├── consolidator.ts        # the 1 LLM extractor: task spans → N notes
│   │                          #   (content, severity, targetAgents, description, sourceSpanIds)
│   │                          #   routing folded in here — NO separate classifier
│   ├── extractor-client.ts    # Ark LLM client behind an interface (fake impl for tests)
│   ├── safety.ts              # redact() + quarantine heuristic (run BEFORE any write)
│   ├── landing.ts             # ROUTE + LAND: write AGENTS.md entries (severe) and
│   │                          #   SKILL.md files (normal) into target agents' workspaces
│   ├── review.ts              # HITL state: risk trigger, approve/edit/reject, revoke
│   ├── ledger.ts              # write-time grant ledger (granted / withheld+reason / HITL)
│   └── flush-trigger.ts       # pluggable: onTaskTerminal (sequential) | watermark (DAG, later)
├── workspace.ts               # + writeSkill(), appendAgentsEntry(), removeSkill(), regenerate
├── agent-service.ts           # + call group-runner; on task terminal → consolidate → land
├── store.ts                   # + default new arrays when absent
├── types.ts                   # + AgentGroup, GroupTask, MemoryNote, GrantRecord
└── app.ts                     # + routes (§4)
```

**Landing is the enforcement point.** `landing.ts` is the only module that writes
into an agent's workspace, so "security by placement" has exactly one choke point:
a note reaches an agent iff `landing.ts` wrote a file into that agent's workspace.

---

## 3. Data model additions (shapes deferred to SPEC)

New entities in `types.ts`, new arrays in the store:

| Entity | Purpose | Store array |
|---|---|---|
| `AgentGroup` | the audience boundary — membership + routing | `groups` |
| `GroupTask` | the unit consolidation runs over; holds its run ids + status | `groupTasks` |
| `MemoryNote` | the governed unit: content, severity, target agents, description, source spans, status | `notes` |
| `GrantRecord` | the write-time audit row: granted / withheld+reason / HITL decision / revoked | `grants` |

`status` on a `MemoryNote` mirrors the filesystem-as-state-machine:
`pending | active | quarantined | rejected | revoked`. A note is `active` iff its
file exists in the target workspace.

---

## 4. API surface (paths illustrative; bodies deferred)

| Method | Path | Purpose |
|---|---|---|
| `POST` / `GET` / `PATCH` | `/api/groups[/:id]` | group CRUD + membership |
| `POST` | `/api/groups/:id/tasks` | start a shared task |
| `GET` | `/api/groups/:id/tasks/:taskId` | task timeline + node statuses |
| `GET` | `/api/notes?agentId=&status=` | note list + review queue |
| `POST` | `/api/notes/:id/review` | approve / edit (content, severity, routing, description) / reject |
| `POST` | `/api/notes/:id/revoke` | delete the landed file, mark revoked |
| `GET` | `/api/agents/:id/memory` | what's currently landed in this agent's workspace |
| `GET` | `/api/tasks/:id/grants` | the grant ledger for a task |

---

## 5. Config keys (defaults deferred)

| Key | Purpose |
|---|---|
| `MEMORY_ENABLED` | master switch; `false` restores exact baseline behaviour |
| `MEMORY_EXTRACTOR` | `ark` \| `off` — extractor backend |
| `MEMORY_EXTRACT_TIMEOUT_MS` | consolidator call timeout |
| `REVIEW_ALL_SKILLS` | force every skill through HITL (high-security posture) |
| `SKILLS_DIR` | `.agents/skills` — pin once verified against the Codex version |

---

## 6. Build order (dependency order, not staffing)

1. **Contract first** — `types.ts` + store arrays + route stubs. Unblocks everything.
2. **`safety.ts`** — redaction + quarantine, with fixtures. Pure, testable, no network.
3. **`landing.ts`** — write/remove skills + `AGENTS.md` entries into a workspace.
   The enforcement choke point; test that a note reaches agent A and not agent B.
4. **`group-runner.ts`** — sequential task over `FakeRunner`; collect spans; detect
   task terminal via `flush-trigger.ts` (`onTaskTerminal`).
5. **`consolidator.ts` + `extractor-client.ts`** — the extractor behind an
   interface; fake impl feeds canned notes; validation + routing + severity.
6. **`review.ts` + `ledger.ts`** — HITL state machine + grant ledger.
7. **Wire into `agent-service.ts`** — on task terminal: consolidate → safety →
   risk gate → land → ledger.
8. **Web UI** — task timeline, review queue, per-agent landed-memory view, grant
   ledger. (`apps/web/src/App.tsx` is a single React file today.)

**Fail-safe invariants throughout:** capture and consolidation **fail open** (a
broken extractor writes zero notes; the task still completes). **Placement/security
never fails open** — a note reaches a workspace only through `landing.ts`, only
after the risk gate.

---

## 7. Testing seams

- **Extractor** behind an interface → `FakeExtractor` feeds canned notes; no
  network in `npm run check`.
- **`FakeRunner`** already exists for `group-runner` tests; emits canned spans.
- **`safety.ts`** is pure → fixture-driven (a fake key must never survive into a
  landed file; poisoning shapes must quarantine).
- **`landing.ts`** → assert file presence/absence per agent workspace (the
  security boundary, tested directly on the filesystem).
- **One optional live smoke test** against real Ark + real Codex, excluded from
  `npm run check`.
