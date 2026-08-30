# Person 4 — Teams Surface Implementation Plan

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking.
> After every task run the web gate:
> `npm run typecheck -w @launchpad/web && npm run test -w @launchpad/web && npm run build -w @launchpad/web`

**Goal:** Make the Teams surface read as one shared conversation with real Agent
identity — a persistent team sidebar, a promoted chat feed, a member profile rail
carrying live status and governed memory, and plan nodes that show the mini-plan
each Agent was actually given.

**Architecture:** Additive only. Every base-UI rule stays byte-identical; new
surfaces get new classes appended in their own CSS section. Group state lifts
from `GroupWorkspace` into `App` so the existing sidebar can host a team list the
same way it hosts `.agent-list`. The Teams content area becomes a two-column
shell — conversation (primary) plus a persistent member rail — with Plan /
Context / Review / Ledger / Workspaces / Proof demoted to a secondary strip.

**Tech Stack:** React 19, TypeScript (strict), Vite 7, vitest + jsdom +
@testing-library/react. No new runtime dependencies.

**Spec:** `TODO_Instructions/Person_4.md` (work items 1–5), `TODO.md` §UI / UX,
`middlewaredoc/MIDDLEWARE.md` (the governance claim the member rail must make
visible), `middlewaredoc/MILESTONE_PERSON_4.md` (what already exists).

---

## Global Constraints

- **The base UI does not change.** Base UI is the web app at commit `8d0bd4f`:
  the auth screen, `.app-shell`, `.sidebar`, `.brand`, `.create-button`,
  `.agent-list` / `.agent-card`, `.runtime-card`, `.main`, `.agent-header`,
  `.playground`, `.messages`, `.composer`, `.modal`, `.button*`, `.status*`, and
  both existing `@media` blocks. Do not edit, reorder, or re-specify any of them.
  Additions are new classes, new files, and new conditional branches only.
  Verified in Task 8 by `git diff 8d0bd4f -- apps/web/src/styles.css | grep '^-'`
  returning nothing.
- **Ownership:** edit `apps/web/**` only. Do not touch `apps/server/**`,
  `README.md`, root `package.json`, `.env.example`, `TODO.md`,
  `TODO_Instructions/**`, and do not add a second server endpoint.
- **Design tokens:** reuse the declared custom properties only — `--ink`,
  `--muted`, `--line`, `--paper`, `--purple`, `--purple-dark`, `--purple-soft`,
  `--green`, `--red`, `--shadow`. New properties may be added; no existing value
  changes.
- **Role accents already in the sheet** (styles.css:1159-1161): backend
  `var(--purple)`, frontend `#2f8fbf`, security `#c07a2b`. Every new identity
  surface derives its colour from these three and nothing else.
- **No new fonts.** Hierarchy comes from weight, size, and letter-spacing.
- **Data honesty:** render only what the server persisted. Never infer a status,
  a grant, or an instruction the backend did not record.
- **Bounded async:** no new polling loop. Every new fetch has a loading state, a
  terminal error state, and stops.
- **Quality floor:** visible focus rings, clean collapse at 1180px / 900px /
  680px, and every new animation behind
  `@media (prefers-reduced-motion: reduce)`.

---

## Design direction

**Subject.** The product's one claim is *what did this Agent know, what was it
denied knowing, and why*. Identity is therefore the design problem: a reader must
follow one Agent across the conversation, the plan, and the memory ledger without
re-reading names.

**Signature — the role thread.** One Agent, one colour, on every surface: the
avatar in the member rail, the avatar on that Agent's chat turns, the dot on its
team card in the sidebar, the dot on its plan node. The three existing role
accents carry it, so nothing new is invented. That is the one place boldness is
spent; everything else stays hairline `--line` borders, 14px radii and `--paper`
cards, matching base.

**Type scale (new surfaces only).** Team name 25/700 `-0.015em`; member name
13/600; role and section labels 10–11/700 uppercase `letter-spacing: .09em` (the
existing `.eyebrow` idiom); body 13/1.7; monospace only for paths.

**Layout.**

```
app-shell (base, untouched)
├── sidebar (base)                  main (base)
│   brand                           ┌─ .team-shell   1fr / 300px ─────────────┐
│   view-switch                     │ .team-head    name · status · actions   │
│   create button                   ├──────────────────────┬──────────────────┤
│   YOUR TEAMS  ← NEW, Teams view   │ .team-views          │ .member-rail     │
│    ▸ Upload Feature Team          │  [Conversation] │ Plan Context Review…  │
│        3 members  ● ● ●           ├──────────────────────┤  ┌────────────┐  │
│   YOUR AGENTS ← base, Agents view │ .chat  (feed)        │  │ ◉ Backend  │  │
│   runtime-card (base)             │   ▌ Backend Agent    │  │ backend    │  │
│                                   │   ▌ Frontend Agent   │  │ Running …  │  │
│                                   │ .chat-composer       │  │ holds 2    │  │
│                                   └──────────────────────┴──────────────────┘
```

**Motion.** Exactly one new behaviour: a running member card's dot and a live
team card breathe using the sheet's existing `@keyframes pulse`. Nothing else
moves.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `apps/web/src/types.ts` | modify | add `instruction?: string` to `GroupPlanNode` |
| `apps/web/src/group/liveStatus.ts` | create | pure: plan nodes → per-Agent live status |
| `apps/web/src/group/liveStatus.test.ts` | create | tests for the above |
| `apps/web/src/group/useGroups.ts` | create | group list + selection, lifted for the sidebar |
| `apps/web/src/group/useAgentMemory.ts` | create | bounded per-Agent landed-memory fetch |
| `apps/web/src/group/TeamSidebar.tsx` | create | persistent team list inside the base sidebar |
| `apps/web/src/group/TeamSidebar.test.tsx` | create | tests for the above |
| `apps/web/src/group/MemberRail.tsx` | create | Agent profile panel |
| `apps/web/src/group/MemberRail.test.tsx` | create | tests for the above |
| `apps/web/src/group/ConversationPanel.tsx` | create | promoted chat feed + goal composer |
| `apps/web/src/group/ConversationPanel.test.tsx` | create | tests for the above |
| `apps/web/src/group/panels.tsx` | modify | `ChainPanel` renders instruction + expected output |
| `apps/web/src/group/panels.test.tsx` | modify | add `ChainPanel` tests |
| `apps/web/src/group/GroupWorkspace.tsx` | modify | two-column shell, Conversation primary, lifted props |
| `apps/web/src/App.tsx` | modify | own group state; render `TeamSidebar` on the Teams view |
| `apps/web/src/styles.css` | modify | **append** one new section; nothing above it moves |

---

### Task 1: Read the persisted plan-node instruction

The server already writes `GroupPlanNode.instruction`
(`apps/server/src/types.ts:192`). The browser type lacks it, and seeded rows
predate the field, so it is optional on the read side.

**Files:**
- Modify: `apps/web/src/types.ts:157-177`

**Interfaces:**
- Produces: `GroupPlanNode.instruction?: string` — consumed by Task 6.

- [ ] **Step 1: Add the field**

In `interface GroupPlanNode`, immediately above `expectedOutput`:

```ts
  /**
   * What this Agent was told to do on this node — planner output, persisted per
   * row by the server.
   *
   * Optional on the read side ONLY because task rows seeded before the planner
   * landed carry no such field. Never reconstruct it in the browser: a missing
   * instruction is a fact about the row, not a gap to paper over.
   */
  instruction?: string;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @launchpad/web`
Expected: clean, no output.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/types.ts
git commit -m "feat(web): read the persisted plan-node instruction"
```

---

### Task 2: Derive per-Agent live status from the plan

The member rail needs "what is this Agent doing right now". That is a pure
function of persisted plan nodes plus the task status — no new endpoint, no
inference beyond what the server recorded.

**Files:**
- Create: `apps/web/src/group/liveStatus.ts`
- Test: `apps/web/src/group/liveStatus.test.ts`

**Interfaces:**
- Consumes: `GroupPlanNode` (Task 1), `GroupTaskStatus`, `isTerminal` from `./format`.
- Produces:
  ```ts
  export type LiveState = "idle" | "waiting" | "running" | "done" | "failed" | "stopped";
  export interface AgentLiveStatus {
    state: LiveState;
    label: string;
    nodeRole: string | null;
    completed: number;
    total: number;
  }
  export function liveStatusFor(
    agentId: string,
    nodes: GroupPlanNode[],
    taskStatus: GroupTaskStatus | null,
  ): AgentLiveStatus;
  ```
  Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/group/liveStatus.test.ts`:

```ts
/**
 * The member rail claims an Agent is running. That claim must come from a
 * persisted node status and nothing else, so the derivation is tested on its own
 * rather than through a rendered component.
 */
import { describe, expect, it } from "vitest";
import type { GroupPlanNode } from "../types";
import { liveStatusFor } from "./liveStatus";

function node(
  over: Partial<GroupPlanNode> & { id: string; agentId: string },
): GroupPlanNode {
  return {
    groupTaskId: "t1",
    kind: "work",
    nodeRole: "backend-contract",
    dependsOn: [],
    contextSnapshotSeq: 0,
    allowedPlanNodeIds: [],
    status: "queued",
    runId: null,
    output: null,
    error: null,
    readOnly: false,
    fileOwnershipHints: [],
    runtimeLocks: [],
    expectedOutput: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

describe("liveStatusFor", () => {
  it("reports idle when the Agent owns no node in this task", () => {
    const status = liveStatusFor("a9", [node({ id: "n1", agentId: "a1" })], "running");
    expect(status.state).toBe("idle");
    expect(status.label).toBe("No step in this task");
  });

  it("reports the running node, and names it", () => {
    const status = liveStatusFor(
      "a1",
      [node({ id: "n1", agentId: "a1", status: "running", nodeRole: "security-review" })],
      "running",
    );
    expect(status.state).toBe("running");
    expect(status.nodeRole).toBe("security-review");
    expect(status.label).toBe("Running security-review");
  });

  it("prefers a running node over a queued one", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({ id: "n1", agentId: "a1", status: "completed" }),
        node({ id: "n2", agentId: "a1", status: "running", nodeRole: "backend-impl" }),
        node({ id: "n3", agentId: "a1", status: "queued" }),
      ],
      "running",
    );
    expect(status.state).toBe("running");
    expect(status.nodeRole).toBe("backend-impl");
  });

  it("reports waiting while the task is live and the node has not started", () => {
    const status = liveStatusFor(
      "a1",
      [node({ id: "n1", agentId: "a1", status: "queued", nodeRole: "frontend-plan" })],
      "running",
    );
    expect(status.state).toBe("waiting");
    expect(status.label).toBe("Waiting for frontend-plan");
  });

  it("reports a failure over a completed sibling", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({ id: "n1", agentId: "a1", status: "completed" }),
        node({ id: "n2", agentId: "a1", status: "failed", nodeRole: "backend-impl" }),
      ],
      "partial",
    );
    expect(status.state).toBe("failed");
    expect(status.label).toBe("Failed on backend-impl");
  });

  it("counts finished steps when everything completed", () => {
    const status = liveStatusFor(
      "a1",
      [
        node({ id: "n1", agentId: "a1", status: "completed" }),
        node({ id: "n2", agentId: "a1", status: "completed" }),
      ],
      "completed",
    );
    expect(status.state).toBe("done");
    expect(status.completed).toBe(2);
    expect(status.total).toBe(2);
    expect(status.label).toBe("Finished 2 steps");
  });

  it("says stopped, not waiting, once a cancelled task leaves a node unstarted", () => {
    const status = liveStatusFor(
      "a1",
      [node({ id: "n1", agentId: "a1", status: "queued", nodeRole: "frontend-impl" })],
      "cancelled",
    );
    expect(status.state).toBe("stopped");
    expect(status.label).toBe("Stopped before frontend-impl");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @launchpad/web -- liveStatus`
Expected: FAIL — `Failed to resolve import "./liveStatus"`.

- [ ] **Step 3: Implement**

Create `apps/web/src/group/liveStatus.ts`:

```ts
/**
 * What one Agent is doing on the current task, derived from persisted plan
 * nodes.
 *
 * This exists because the member rail makes a live claim about someone's Agent,
 * and that claim has to be traceable to a row the server wrote. Nothing here
 * reads the clock or guesses: `running` means a node row says `running`.
 *
 * Precedence is deliberate — failed beats running beats unstarted beats done —
 * so a rail that says "Running" can never be hiding a failure underneath.
 */
import type { GroupPlanNode, GroupTaskStatus } from "../types";
import { isTerminal } from "./format";

export type LiveState =
  | "idle"
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "stopped";

export interface AgentLiveStatus {
  state: LiveState;
  /** A sentence for the rail. Present tense while live, past tense when not. */
  label: string;
  /** The node the label is about, when there is one. */
  nodeRole: string | null;
  completed: number;
  total: number;
}

export function liveStatusFor(
  agentId: string,
  nodes: GroupPlanNode[],
  taskStatus: GroupTaskStatus | null,
): AgentLiveStatus {
  const mine = nodes.filter((node) => node.agentId === agentId);
  const total = mine.length;
  const completed = mine.filter((node) => node.status === "completed").length;
  const base = { nodeRole: null, completed, total };

  if (total === 0) {
    return { ...base, state: "idle", label: "No step in this task" };
  }

  const failed = mine.find((node) => node.status === "failed");
  if (failed) {
    return {
      ...base,
      state: "failed",
      nodeRole: failed.nodeRole,
      label: "Failed on " + failed.nodeRole,
    };
  }

  const running = mine.find((node) => node.status === "running");
  if (running) {
    return {
      ...base,
      state: "running",
      nodeRole: running.nodeRole,
      label: "Running " + running.nodeRole,
    };
  }

  const unstarted = mine.find(
    (node) => node.status === "queued" || node.status === "cancelled",
  );
  if (unstarted) {
    // A terminal task will never start this node. Saying "waiting" there would
    // promise something that is not coming.
    const stopped = taskStatus !== null && isTerminal(taskStatus);
    return {
      ...base,
      state: stopped ? "stopped" : "waiting",
      nodeRole: unstarted.nodeRole,
      label: (stopped ? "Stopped before " : "Waiting for ") + unstarted.nodeRole,
    };
  }

  return {
    ...base,
    state: "done",
    label: "Finished " + completed + (completed === 1 ? " step" : " steps"),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run test -w @launchpad/web -- liveStatus`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/group/liveStatus.ts apps/web/src/group/liveStatus.test.ts
git commit -m "feat(web): derive per-Agent live status from persisted plan nodes"
```

---

### Task 3: Lift group state and add the persistent team sidebar

Teams get what Agents already have: a one-click list in the sidebar, present even
with a single team. The list has to live in `App`'s sidebar, so group data and
selection move out of `GroupWorkspace` into a hook both can read.

**Files:**
- Create: `apps/web/src/group/useGroups.ts`
- Create: `apps/web/src/group/TeamSidebar.tsx`
- Test: `apps/web/src/group/TeamSidebar.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/group/GroupWorkspace.tsx`
- Modify: `apps/web/src/styles.css` (append only)

**Interfaces:**
- Produces:
  ```ts
  export interface GroupsState {
    groups: AgentGroup[];
    selectedId: string | null;
    select: (id: string) => void;
    refresh: () => Promise<void>;
    error: string | null;
  }
  export function useGroups(enabled: boolean): GroupsState;
  ```
  `GroupWorkspace` gains props
  `{ groups, selectedGroupId, onSelectGroup, onRefreshGroups, createRequested, onCreateHandled }`
  and stops owning `groups` / `selectedId`. Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/group/TeamSidebar.test.tsx`:

```tsx
/**
 * The sidebar is the fix for "Teams have no selector when there is one team", so
 * the single-team case is the case that matters most here.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentGroup } from "../types";
import { TeamSidebar } from "./TeamSidebar";

const agents: Agent[] = ["a1", "a2", "a3"].map((id, index) => ({
  id,
  name: ["Backend Agent", "Frontend Agent", "Security Agent"][index] as string,
  description: "",
  instructions: "",
  status: "ready" as const,
  workspacePath: "/w/" + id,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

const team: AgentGroup = {
  id: "g1",
  name: "Upload Feature Team",
  description: "Ship the file upload endpoint end to end.",
  members: [
    { agentId: "a1", role: "backend" },
    { agentId: "a2", role: "frontend" },
    { agentId: "a3", role: "security" },
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("TeamSidebar", () => {
  it("lists a single team, so there is always a selector", () => {
    render(
      <TeamSidebar
        groups={[team]}
        agents={agents}
        selectedId="g1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Upload Feature Team/ })).toBeInTheDocument();
    expect(screen.getByText("3 members")).toBeInTheDocument();
  });

  it("names every member so the roster is readable without opening the team", () => {
    render(
      <TeamSidebar
        groups={[team]}
        agents={agents}
        selectedId="g1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Upload Feature Team/ })).toHaveAttribute(
      "title",
      "Backend Agent · Frontend Agent · Security Agent",
    );
  });

  it("selects a team on click", async () => {
    const onSelect = vi.fn();
    const second = { ...team, id: "g2", name: "Payments Team" };
    render(
      <TeamSidebar
        groups={[team, second]}
        agents={agents}
        selectedId="g1"
        onSelect={onSelect}
        onCreate={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Payments Team/ }));
    expect(onSelect).toHaveBeenCalledWith("g2");
  });

  it("invites the first team when there are none", async () => {
    const onCreate = vi.fn();
    render(
      <TeamSidebar
        groups={[]}
        agents={agents}
        selectedId={null}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create a team" }));
    expect(onCreate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @launchpad/web -- TeamSidebar`
Expected: FAIL — `Failed to resolve import "./TeamSidebar"`.

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/group/useGroups.ts`:

```ts
/**
 * The team list, owned above `GroupWorkspace`.
 *
 * It lives here because two surfaces need it: the persistent sidebar list in
 * `App`, and the workspace itself. Keeping it inside the workspace is what
 * forced the old `<select>` buried in the content header.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { AgentGroup } from "../types";

export interface GroupsState {
  groups: AgentGroup[];
  selectedId: string | null;
  select: (id: string) => void;
  refresh: () => Promise<void>;
  error: string | null;
}

export function useGroups(enabled: boolean): GroupsState {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { groups: next } = await api.groups();
    setGroups(next);
    // Keep the current selection while it still exists; otherwise fall to the
    // first team so the surface never lands on nothing.
    setSelectedId((current) =>
      current && next.some((item) => item.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [enabled, refresh]);

  return { groups, selectedId, select: setSelectedId, refresh, error };
}
```

- [ ] **Step 4: Implement the sidebar**

Create `apps/web/src/group/TeamSidebar.tsx`:

```tsx
/**
 * The team list inside the app's existing sidebar.
 *
 * Deliberately the same shape as `.agent-list`: a card per team, always visible,
 * one click to switch. It replaces a `<select>` that only appeared once a second
 * team existed — so with one team there was no selector at all.
 */
import type { Agent, AgentGroup } from "../types";
import { agentName } from "./format";

export function TeamSidebar({
  groups,
  agents,
  selectedId,
  onSelect,
  onCreate,
}: {
  groups: AgentGroup[];
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <>
      <div className="sidebar-label">
        <span>Your Teams</span>
        <span>{groups.length}</span>
      </div>
      <nav className="team-list">
        {groups.map((group) => (
          <button
            key={group.id}
            className={"team-card " + (group.id === selectedId ? "selected" : "")}
            onClick={() => onSelect(group.id)}
            title={group.members
              .map((member) => agentName(agents, member.agentId))
              .join(" · ")}
          >
            <div className="team-card-copy">
              <strong>{group.name}</strong>
              <span>
                {group.members.length} member
                {group.members.length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="team-roster-dots" aria-hidden="true">
              {group.members.map((member) => (
                <span key={member.agentId} className={"role-dot role-" + member.role} />
              ))}
            </span>
            {group.activeTaskId && <span className="team-live" aria-label="Task running" />}
          </button>
        ))}
        {groups.length === 0 && (
          <div className="empty-sidebar">
            <span>◇</span>
            Put your Agents on one task.
            <button className="team-empty-action" onClick={onCreate}>
              Create a team
            </button>
          </div>
        )}
      </nav>
    </>
  );
}
```

- [ ] **Step 5: Append the sidebar styles**

Append to the **end** of `apps/web/src/styles.css`:

```css
/* ===========================================================================
   Teams — conversation shell (Person 4)
   Additive. Every rule below is a NEW class; no base selector is redefined.
   Identity colour comes from the three role accents already declared above.
   =========================================================================== */

/* --- sidebar: the team list, shaped like .agent-list --- */
.team-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  flex: 1;
  margin-bottom: 16px;
}
.team-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 11px 12px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #f5f3ed;
  text-align: left;
  cursor: pointer;
}
.team-card:hover { background: rgba(255, 255, 255, 0.05); }
.team-card.selected {
  background: rgba(255, 255, 255, 0.09);
  border-color: rgba(255, 255, 255, 0.14);
}
.team-card-copy { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.team-card-copy strong {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-card-copy span { font-size: 11px; color: #a5a49c; margin-top: 2px; }
.team-roster-dots { display: inline-flex; gap: 3px; flex: none; }
.team-live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #54b98e;
  box-shadow: 0 0 0 3px rgba(84, 185, 142, 0.16);
  flex: none;
  animation: pulse 1.6s ease-in-out infinite;
}
.team-empty-action {
  margin-top: 10px;
  background: none;
  border: 0;
  padding: 0;
  color: #b9b0ff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: underline;
}
@media (prefers-reduced-motion: reduce) {
  .team-live { animation: none; }
}
```

- [ ] **Step 6: Wire `App.tsx`**

1. Add imports beside the existing `GroupWorkspace` import:

```tsx
import { TeamSidebar } from "./group/TeamSidebar";
import { useGroups } from "./group/useGroups";
```

2. Beside the other hooks:

```tsx
  // Owned here, not in GroupWorkspace, so the sidebar can list teams the same
  // way it lists Agents.
  const teams = useGroups(view === "teams");
  const [createTeam, setCreateTeam] = useState(false);
```

3. Wrap the existing `Your Agents` label + `.agent-list` nav in a branch. The
   Agents branch keeps its markup character-for-character; only the wrapper is
   new:

```tsx
        {view === "teams" ? (
          <TeamSidebar
            groups={teams.groups}
            agents={agents}
            selectedId={teams.selectedId}
            onSelect={teams.select}
            onCreate={() => setCreateTeam(true)}
          />
        ) : (
          <>
            {/* unchanged: sidebar-label + .agent-list nav exactly as before */}
          </>
        )}
```

4. Pass the lifted state down:

```tsx
          <GroupWorkspace
            agents={agents}
            onOpenTrace={setTraceRunId}
            groups={teams.groups}
            selectedGroupId={teams.selectedId}
            onSelectGroup={teams.select}
            onRefreshGroups={teams.refresh}
            createRequested={createTeam}
            onCreateHandled={() => setCreateTeam(false)}
          />
```

- [ ] **Step 7: Accept the lifted state in `GroupWorkspace`**

- Extend the props:
  ```tsx
  export function GroupWorkspace({
    agents,
    onOpenTrace,
    groups,
    selectedGroupId,
    onSelectGroup,
    onRefreshGroups,
    createRequested,
    onCreateHandled,
  }: {
    agents: Agent[];
    onOpenTrace: (runId: string) => void;
    groups: AgentGroup[];
    selectedGroupId: string | null;
    onSelectGroup: (id: string) => void;
    onRefreshGroups: () => Promise<void>;
    createRequested: boolean;
    onCreateHandled: () => void;
  }) {
  ```
- Delete the local `groups` / `selectedId` state, the `refreshGroups` callback,
  and the effect that calls it.
- Replace every `selectedId` read with `selectedGroupId`, every `setSelectedId`
  with `onSelectGroup`, and every `refreshGroups()` with `onRefreshGroups()`.
- Delete the `groups.length > 1 && <select className="team-select">…</select>`
  block from the header — the sidebar replaces it.
- Open the editor when the sidebar asks:
  ```tsx
    useEffect(() => {
      if (createRequested) {
        setEditing("new");
        onCreateHandled();
      }
    }, [createRequested, onCreateHandled]);
  ```

- [ ] **Step 8: Run the gate**

Run: `npm run typecheck -w @launchpad/web && npm run test -w @launchpad/web && npm run build -w @launchpad/web`
Expected: clean typecheck, the 4 new `TeamSidebar` tests plus the existing 22 pass, build succeeds.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/group/TeamSidebar.tsx \
        apps/web/src/group/TeamSidebar.test.tsx apps/web/src/group/useGroups.ts \
        apps/web/src/group/GroupWorkspace.tsx apps/web/src/styles.css
git commit -m "feat(web): give Teams a persistent sidebar like Agents"
```

---

### Task 4: The Agent profile rail

Avatar, name, role, live task status, and the governed memory that Agent
currently holds — next to the person it describes, instead of buried in a
`Workspaces` tab.

**Files:**
- Create: `apps/web/src/group/useAgentMemory.ts`
- Create: `apps/web/src/group/MemberRail.tsx`
- Test: `apps/web/src/group/MemberRail.test.tsx`
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Consumes: `liveStatusFor` (Task 2), `GroupPlanNode` (Task 1).
- Produces:
  ```ts
  export function useAgentMemory(
    agentIds: string[],
    revision: number,
  ): { memory: Record<string, LandedMemoryFile[]>; loading: boolean; failed: boolean };

  export function MemberRail(props: {
    group: AgentGroup;
    agents: Agent[];
    nodes: GroupPlanNode[];
    taskStatus: GroupTaskStatus | null;
    memory: Record<string, LandedMemoryFile[]>;
    memoryLoading: boolean;
    memoryFailed: boolean;
    onOpenTrace: (runId: string) => void;
  }): React.JSX.Element;
  ```
  Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/group/MemberRail.test.tsx`:

```tsx
/**
 * The rail is where the product's claim becomes a person-shaped thing: this
 * Agent, this role, this step, exactly this memory. Each of those is pinned here,
 * including the two ways an empty rail can lie.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentGroup, GroupPlanNode, LandedMemoryFile } from "../types";
import { MemberRail } from "./MemberRail";

const agents: Agent[] = ["a1", "a2", "a3"].map((id, index) => ({
  id,
  name: ["Backend Agent", "Frontend Agent", "Security Agent"][index] as string,
  description: "",
  instructions: "",
  status: "ready" as const,
  workspacePath: "/w/" + id,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

const group: AgentGroup = {
  id: "g1",
  name: "Upload Feature Team",
  description: "",
  members: [
    { agentId: "a1", role: "backend" },
    { agentId: "a2", role: "frontend" },
    { agentId: "a3", role: "security" },
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const runningNode: GroupPlanNode = {
  id: "n1",
  groupTaskId: "t1",
  agentId: "a1",
  kind: "work",
  nodeRole: "backend-contract",
  dependsOn: [],
  contextSnapshotSeq: 0,
  allowedPlanNodeIds: [],
  status: "running",
  runId: "r1",
  output: null,
  error: null,
  readOnly: false,
  fileOwnershipHints: [],
  runtimeLocks: [],
  expectedOutput: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
};

const file: LandedMemoryFile = {
  id: "f1",
  noteId: "note1",
  agentId: "a2",
  kind: "skill",
  path: "/w/a2/.agents/skills/upload-contract/SKILL.md",
  createdAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
};

function renderRail(over: Partial<React.ComponentProps<typeof MemberRail>> = {}) {
  return render(
    <MemberRail
      group={group}
      agents={agents}
      nodes={[runningNode]}
      taskStatus="running"
      memory={{ a2: [file] }}
      memoryLoading={false}
      memoryFailed={false}
      onOpenTrace={vi.fn()}
      {...over}
    />,
  );
}

describe("MemberRail", () => {
  it("shows every member with name and role", () => {
    renderRail();
    expect(screen.getByText("Backend Agent")).toBeInTheDocument();
    expect(screen.getByText("Frontend Agent")).toBeInTheDocument();
    expect(screen.getByText("Security Agent")).toBeInTheDocument();
    expect(screen.getByText("backend")).toBeInTheDocument();
  });

  it("reports the live step for the Agent that is running", () => {
    renderRail();
    expect(screen.getByText("Running backend-contract")).toBeInTheDocument();
  });

  it("names the memory an Agent holds, and says plainly when it holds none", () => {
    renderRail();
    expect(screen.getByText("upload-contract/SKILL.md")).toBeInTheDocument();
    expect(screen.getAllByText("Holds no governed memory")).toHaveLength(2);
  });

  it("does not count a revoked file as held", () => {
    renderRail({ memory: { a2: [{ ...file, removedAt: "2026-01-02T00:00:00.000Z" }] } });
    expect(screen.getAllByText("Holds no governed memory")).toHaveLength(3);
  });

  it("says the memory state is unavailable rather than implying an empty workspace", () => {
    renderRail({ memory: {}, memoryFailed: true });
    expect(screen.getAllByText("Memory state unavailable")).toHaveLength(3);
    expect(screen.queryByText("Holds no governed memory")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @launchpad/web -- MemberRail`
Expected: FAIL — `Failed to resolve import "./MemberRail"`.

- [ ] **Step 3: Implement the memory hook**

Create `apps/web/src/group/useAgentMemory.ts`:

```ts
/**
 * What each member's workspace holds right now.
 *
 * File presence IS the enforcement state, so this reads the filesystem through
 * the API rather than inferring anything from note status. It fetches once per
 * `revision` bump and never polls: a workspace only changes when a task flushes
 * or a human reviews something, and both bump the revision.
 */
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LandedMemoryFile } from "../types";

export function useAgentMemory(agentIds: string[], revision: number) {
  const [memory, setMemory] = useState<Record<string, LandedMemoryFile[]>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = agentIds.join(",");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setMemory({});
      setFailed(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    Promise.all(
      ids.map((id) => api.agentMemory(id).then((result) => ({ id, files: result.files }))),
    )
      .then((entries) => {
        if (!mounted.current) return;
        const next: Record<string, LandedMemoryFile[]> = {};
        for (const entry of entries) next[entry.id] = entry.files;
        setMemory(next);
      })
      .catch(() => {
        // Never silently show an empty workspace: an empty rail and a failed
        // fetch look identical, and one of them is a false governance claim.
        if (mounted.current) setFailed(true);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [key, revision]);

  return { memory, loading, failed };
}
```

- [ ] **Step 4: Implement the rail**

Create `apps/web/src/group/MemberRail.tsx`:

```tsx
/**
 * The Agent profile panel — who is on this team, what each one is doing, and what
 * each one currently knows.
 *
 * That last part is the whole product: a member card says "holds no governed
 * memory" as confidently as it says "holds two files", because a withheld memory
 * is a result, not a gap.
 */
import type {
  Agent,
  AgentGroup,
  GroupPlanNode,
  GroupTaskStatus,
  LandedMemoryFile,
} from "../types";
import { agentName } from "./format";
import { liveStatusFor } from "./liveStatus";

/** `upload-contract/SKILL.md` — enough to recognise, short enough to fit. */
function fileLabel(file: LandedMemoryFile): string {
  return file.path.split("/").slice(-2).join("/");
}

export function MemberRail({
  group,
  agents,
  nodes,
  taskStatus,
  memory,
  memoryLoading,
  memoryFailed,
  onOpenTrace,
}: {
  group: AgentGroup;
  agents: Agent[];
  nodes: GroupPlanNode[];
  taskStatus: GroupTaskStatus | null;
  memory: Record<string, LandedMemoryFile[]>;
  memoryLoading: boolean;
  memoryFailed: boolean;
  onOpenTrace: (runId: string) => void;
}) {
  return (
    <aside className="member-rail" aria-label="Team members">
      <div className="member-rail-head">
        <span className="eyebrow">Members</span>
        <span className="member-rail-count">{group.members.length}</span>
      </div>
      {group.members.map((member) => {
        const agent = agents.find((item) => item.id === member.agentId);
        const name = agentName(agents, member.agentId);
        const status = liveStatusFor(member.agentId, nodes, taskStatus);
        const held = (memory[member.agentId] ?? []).filter(
          (file) => file.removedAt === null,
        );
        const liveNode = nodes.find(
          (node) => node.agentId === member.agentId && node.status === "running",
        );
        return (
          <article key={member.agentId} className={"member-card member-" + status.state}>
            <div className="member-identity">
              <span className={"member-avatar role-bg-" + member.role}>
                {name.slice(0, 1).toUpperCase()}
              </span>
              <div className="member-name">
                <strong>{name}</strong>
                <span className={"member-role role-text-" + member.role}>{member.role}</span>
              </div>
            </div>

            {agent?.description && <p className="member-description">{agent.description}</p>}

            <div className="member-status">
              <span className={"member-state-dot state-" + status.state} />
              <span>{status.label}</span>
              {liveNode?.runId && (
                <button
                  className="member-trace"
                  onClick={() => onOpenTrace(liveNode.runId as string)}
                >
                  Trace
                </button>
              )}
            </div>

            <div className="member-memory">
              <span className="eyebrow">Governed memory</span>
              {memoryFailed ? (
                <p className="member-memory-empty">Memory state unavailable</p>
              ) : memoryLoading && held.length === 0 ? (
                <p className="member-memory-empty">Reading the workspace…</p>
              ) : held.length === 0 ? (
                <p className="member-memory-empty">Holds no governed memory</p>
              ) : (
                <ul className="member-memory-files">
                  {held.map((file) => (
                    <li key={file.id}>
                      <span
                        className={
                          "member-memory-kind " +
                          (file.kind === "agents_md" ? "is-severe" : "is-skill")
                        }
                      >
                        {file.kind === "agents_md" ? "always on" : "on match"}
                      </span>
                      <code title={file.path}>{fileLabel(file)}</code>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 5: Append the rail styles**

```css
/* --- the Agent profile rail --- */
.member-rail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 0;
  align-self: start;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding-bottom: 24px;
}
.member-rail-head { display: flex; align-items: baseline; justify-content: space-between; }
.member-rail-count { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.member-card {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--paper);
  padding: 13px 14px;
}
.member-card.member-running { border-color: var(--purple); box-shadow: 0 0 0 3px var(--purple-soft); }
.member-card.member-failed { border-color: var(--red); }
.member-identity { display: flex; align-items: center; gap: 10px; }
.member-avatar {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  flex: none;
}
.role-bg-backend { background: var(--purple); }
.role-bg-frontend { background: #2f8fbf; }
.role-bg-security { background: #c07a2b; }
.member-name { display: flex; flex-direction: column; min-width: 0; }
.member-name strong { font-size: 13px; font-weight: 600; }
.member-role {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  margin-top: 2px;
}
.role-text-backend { color: var(--purple-dark); }
.role-text-frontend { color: #23708f; }
.role-text-security { color: #96601f; }
.member-description { margin: 9px 0 0; font-size: 12px; color: var(--muted); line-height: 1.55; }
.member-status {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 11px;
  font-size: 12px;
  color: var(--ink);
}
.member-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.member-state-dot.state-running { background: var(--purple); animation: pulse 1.5s ease-in-out infinite; }
.member-state-dot.state-done { background: var(--green); }
.member-state-dot.state-failed { background: var(--red); }
.member-state-dot.state-waiting { background: #d3a349; }
.member-trace {
  margin-left: auto;
  background: none;
  border: 0;
  padding: 0;
  color: var(--purple-dark);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.member-memory { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.member-memory-empty { margin: 6px 0 0; font-size: 12px; color: var(--muted); }
.member-memory-files {
  list-style: none;
  margin: 7px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.member-memory-files li { display: flex; align-items: center; gap: 7px; min-width: 0; }
.member-memory-files code {
  font-size: 11px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-memory-kind {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 5px;
  flex: none;
}
.member-memory-kind.is-severe { background: #f8dede; color: #973939; }
.member-memory-kind.is-skill { background: #dff0e7; color: #1f6b4f; }
@media (prefers-reduced-motion: reduce) {
  .member-state-dot.state-running { animation: none; }
}
```

- [ ] **Step 6: Run the tests**

Run: `npm run test -w @launchpad/web -- MemberRail`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/group/MemberRail.tsx apps/web/src/group/MemberRail.test.tsx \
        apps/web/src/group/useAgentMemory.ts apps/web/src/styles.css
git commit -m "feat(web): add the Agent profile rail with live status and held memory"
```

---

### Task 5: Promote the transcript to a conversation

The transcript already renders chat-style. What it lacks is primacy, an avatar
gutter, and the goal composer inline — the three things that make it read as one
shared conversation rather than the seventh tab.

**Files:**
- Create: `apps/web/src/group/ConversationPanel.tsx`
- Test: `apps/web/src/group/ConversationPanel.test.tsx`
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Produces:
  ```tsx
  export function ConversationPanel(props: {
    messages: GroupMessage[];
    agents: Agent[];
    group: AgentGroup;
    prompt: string;
    onPromptChange: (value: string) => void;
    onSubmit: (event: React.FormEvent) => void;
    running: boolean;
    busy: boolean;
  }): React.JSX.Element;
  ```
  Consumed by Task 7.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/group/ConversationPanel.test.tsx`:

```tsx
/**
 * "One shared conversation to the user" is the feature's own one-line summary.
 * These tests pin the parts of that sentence a reader can actually see.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentGroup, GroupMessage } from "../types";
import { ConversationPanel } from "./ConversationPanel";

const agents: Agent[] = ["a1", "a2"].map((id, index) => ({
  id,
  name: ["Backend Agent", "Frontend Agent"][index] as string,
  description: "",
  instructions: "",
  status: "ready" as const,
  workspacePath: "/w/" + id,
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

const group: AgentGroup = {
  id: "g1",
  name: "Upload Feature Team",
  description: "",
  members: [
    { agentId: "a1", role: "backend" },
    { agentId: "a2", role: "frontend" },
  ],
  activeTaskId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function message(over: Partial<GroupMessage> & { id: string; seq: number }): GroupMessage {
  return {
    groupId: "g1",
    speakerType: "agent",
    speakerAgentId: "a1",
    groupTaskId: "t1",
    planNodeId: null,
    content: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderPanel(over: Partial<React.ComponentProps<typeof ConversationPanel>> = {}) {
  return render(
    <ConversationPanel
      messages={[
        message({ id: "m2", seq: 2, content: "Contract agreed." }),
        message({
          id: "m1",
          seq: 1,
          speakerType: "human",
          speakerAgentId: null,
          content: "Ship uploads.",
        }),
      ]}
      agents={agents}
      group={group}
      prompt=""
      onPromptChange={vi.fn()}
      onSubmit={vi.fn()}
      running={false}
      busy={false}
      {...over}
    />,
  );
}

describe("ConversationPanel", () => {
  it("orders turns by seq, not by arrival", () => {
    renderPanel();
    const turns = screen.getAllByRole("article");
    expect(turns[0]).toHaveTextContent("Ship uploads.");
    expect(turns[1]).toHaveTextContent("Contract agreed.");
  });

  it("names the speaker on an Agent turn and calls the human turn You", () => {
    renderPanel();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Backend Agent")).toBeInTheDocument();
  });

  it("invites a goal when nothing has been said", () => {
    renderPanel({ messages: [] });
    expect(screen.getByText("No conversation yet")).toBeInTheDocument();
  });

  it("submits the goal from the conversation composer", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    renderPanel({ prompt: "Ship uploads", onSubmit });
    await userEvent.click(screen.getByRole("button", { name: "Start task" }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("locks the composer while a task is running and says why", () => {
    renderPanel({ running: true });
    expect(
      screen.getByPlaceholderText("A task is already running for this team…"),
    ).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @launchpad/web -- ConversationPanel`
Expected: FAIL — `Failed to resolve import "./ConversationPanel"`.

- [ ] **Step 3: Implement**

Create `apps/web/src/group/ConversationPanel.tsx`:

```tsx
/**
 * The team's shared conversation, promoted to the primary surface.
 *
 * The turns come from the app-owned group transcript, in `seq` order — the same
 * rows the old Transcript tab rendered. What is new is the shape: an avatar
 * gutter so a reader can follow one Agent down the page, and the goal composer
 * sitting under the feed where a chat input belongs.
 */
import type { Agent, AgentGroup, GroupMessage } from "../types";
import { agentName, formatTime, roleOf } from "./format";
import { EmptyState } from "./panels";

export function ConversationPanel({
  messages,
  agents,
  group,
  prompt,
  onPromptChange,
  onSubmit,
  running,
  busy,
}: {
  messages: GroupMessage[];
  agents: Agent[];
  group: AgentGroup;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
  running: boolean;
  busy: boolean;
}) {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq);
  return (
    <section className="chat">
      <div className="chat-feed">
        {ordered.length === 0 ? (
          <EmptyState
            icon="◎"
            title="No conversation yet"
            body="Give the team a goal below. Each Agent takes its turn on one shared codebase, and every turn lands here."
          />
        ) : (
          ordered.map((message) => {
            const human = message.speakerType === "human";
            const role = message.speakerAgentId
              ? roleOf(group.members, message.speakerAgentId)
              : null;
            const name = human ? "You" : agentName(agents, message.speakerAgentId);
            return (
              <article
                key={message.id}
                className={"chat-turn " + (human ? "chat-human" : "chat-agent")}
              >
                <span
                  className={
                    "chat-avatar " + (role ? "role-bg-" + role : "chat-avatar-human")
                  }
                  aria-hidden="true"
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <div className="chat-body">
                  <div className="chat-meta">
                    <strong>{name}</strong>
                    {role && <span className={"chat-role role-text-" + role}>{role}</span>}
                    <span className="chat-time">{formatTime(message.createdAt)}</span>
                  </div>
                  <p>{message.content}</p>
                </div>
              </article>
            );
          })
        )}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <input
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={
            running
              ? "A task is already running for this team…"
              : "Give the team one goal — e.g. Plan and implement an upload feature."
          }
          disabled={running || busy}
          maxLength={50_000}
          aria-label="Team goal"
        />
        <button
          className="button button-primary"
          disabled={running || busy || !prompt.trim()}
        >
          Start task
        </button>
      </form>
    </section>
  );
}
```

- [ ] **Step 4: Append the conversation styles**

```css
/* --- the shared conversation --- */
.chat { display: flex; flex-direction: column; gap: 14px; }
.chat-feed { display: flex; flex-direction: column; gap: 4px; }
.chat-turn {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 11px;
  padding: 11px 13px 11px 11px;
  border-radius: 14px;
  border: 1px solid transparent;
}
.chat-turn.chat-agent:hover { background: rgba(255, 255, 255, 0.62); }
.chat-turn.chat-human { background: var(--purple-soft); }
.chat-avatar {
  width: 30px;
  height: 30px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  flex: none;
}
.chat-avatar-human { background: #4a4a44; }
.chat-body { min-width: 0; }
.chat-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 3px; }
.chat-meta strong { font-size: 13px; font-weight: 600; }
.chat-role { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.chat-time { margin-left: auto; font-size: 11px; color: var(--muted); }
.chat-body p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-composer {
  display: flex;
  gap: 9px;
  position: sticky;
  bottom: 0;
  padding: 12px 0 18px;
  background: linear-gradient(to top, #f2f1ed 68%, rgba(242, 241, 237, 0));
}
.chat-composer input {
  flex: 1;
  min-height: 46px;
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0 15px;
  background: var(--paper);
  font-size: 14px;
}
.chat-composer input:focus { outline: 2px solid var(--purple-soft); border-color: var(--purple); }
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @launchpad/web -- ConversationPanel`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/group/ConversationPanel.tsx \
        apps/web/src/group/ConversationPanel.test.tsx apps/web/src/styles.css
git commit -m "feat(web): promote the team transcript to a shared conversation"
```

---

### Task 6: Show each plan node's mini-plan

`ChainPanel` renders `node.nodeRole` and, once finished, the raw output. It never
shows what the Agent was told to do, and never shows `expectedOutput`, which is
already persisted. Sitting under a tab labelled "Plan" with no instruction text
is what made the security-review step read as planning.

**Files:**
- Modify: `apps/web/src/group/panels.tsx` (`ChainPanel`)
- Test: `apps/web/src/group/panels.test.tsx`
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Consumes: `GroupPlanNode.instruction?: string` (Task 1). `ChainPanel`'s
  signature is unchanged.

- [ ] **Step 1: Write the failing test**

Add `ChainPanel` and `userEvent` to the imports at the top of
`apps/web/src/group/panels.test.tsx`:

```tsx
import userEvent from "@testing-library/user-event";
import { ChainPanel, ContextPanel, LandedMemoryPanel, LedgerPanel } from "./panels";
```

Then append:

```tsx
describe("ChainPanel", () => {
  function planNode(over: Partial<GroupPlanNode> & { id: string }): GroupPlanNode {
    return {
      groupTaskId: "t1",
      agentId: "a1",
      kind: "work",
      nodeRole: "security-review",
      dependsOn: [],
      contextSnapshotSeq: 0,
      allowedPlanNodeIds: [],
      status: "completed",
      runId: "r1",
      output: null,
      error: null,
      readOnly: true,
      fileOwnershipHints: [],
      runtimeLocks: [],
      expectedOutput: "A written verdict on the upload contract",
      createdAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      ...over,
    };
  }

  it("renders the instruction the planner persisted, not the role name alone", () => {
    render(
      <ChainPanel
        nodes={[
          planNode({
            id: "n1",
            instruction: "Review the upload contract for credential leakage.",
          }),
        ]}
        agents={agents}
        group={group}
        onOpenTrace={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Review the upload contract for credential leakage."),
    ).toBeInTheDocument();
  });

  it("renders the expected output alongside it", () => {
    render(
      <ChainPanel
        nodes={[planNode({ id: "n1", instruction: "Review the contract." })]}
        agents={agents}
        group={group}
        onOpenTrace={vi.fn()}
      />,
    );
    expect(screen.getByText("A written verdict on the upload contract")).toBeInTheDocument();
  });

  it("says the instruction was not recorded rather than inventing one", () => {
    render(
      <ChainPanel
        nodes={[planNode({ id: "n1" })]}
        agents={agents}
        group={group}
        onOpenTrace={vi.fn()}
      />,
    );
    expect(
      screen.getByText("No instruction was recorded for this step."),
    ).toBeInTheDocument();
  });

  it("opens the trace for the node's run", async () => {
    const onOpenTrace = vi.fn();
    render(
      <ChainPanel
        nodes={[planNode({ id: "n1", instruction: "Review." })]}
        agents={agents}
        group={group}
        onOpenTrace={onOpenTrace}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Trace" }));
    expect(onOpenTrace).toHaveBeenCalledWith("r1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test -w @launchpad/web -- panels`
Expected: FAIL — instruction, expected output, and the fallback line are all absent.

- [ ] **Step 3: Implement**

In `ChainPanel`'s `.chain-body`, replace the `{node.output && …}` line with:

```tsx
            {/*
              The mini-plan. This is planner output the server persisted per row —
              read here, never reconstructed, and a row that predates the planner
              says so rather than showing a template.
            */}
            <div className="chain-plan">
              <span className="eyebrow">Told to</span>
              {node.instruction?.trim() ? (
                <p>{node.instruction}</p>
              ) : (
                <p className="chain-plan-missing">
                  No instruction was recorded for this step.
                </p>
              )}
            </div>

            {node.expectedOutput.trim() && (
              <div className="chain-plan">
                <span className="eyebrow">Expected output</span>
                <p>{node.expectedOutput}</p>
              </div>
            )}

            {node.output && (
              <div className="chain-plan">
                <span className="eyebrow">Result</span>
                <p className="chain-output">{node.output}</p>
              </div>
            )}
```

- [ ] **Step 4: Append the plan styles**

```css
/* --- the plan node's mini-plan --- */
.chain-plan { margin-top: 10px; }
.chain-plan .eyebrow { display: block; margin-bottom: 4px; }
.chain-plan p {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chain-plan .chain-plan-missing { color: var(--muted); font-style: italic; }
.chain-plan .chain-output { margin-top: 0; }
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @launchpad/web -- panels`
Expected: PASS — the 4 new tests plus the existing panel tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/group/panels.tsx apps/web/src/group/panels.test.tsx apps/web/src/styles.css
git commit -m "feat(web): show each plan node's instruction and expected output"
```

---

### Task 7: Assemble the two-column Teams shell

Conversation becomes the primary view; Plan, Context, Review, Ledger, Workspaces
and Proof become a secondary strip; the member rail is persistent across all of
them so the layout never reflows when the view changes.

**Files:**
- Modify: `apps/web/src/group/GroupWorkspace.tsx`
- Modify: `apps/web/src/styles.css` (append)

**Interfaces:**
- Consumes: `ConversationPanel` (Task 5), `MemberRail` + `useAgentMemory`
  (Task 4), the lifted props (Task 3).

- [ ] **Step 1: Rework the view model**

```tsx
type View = "chat" | "chain" | "context" | "review" | "ledger" | "memory" | "proof";

/** Conversation is the surface; everything else inspects what it produced. */
const SECONDARY_VIEWS: { id: View; label: string }[] = [
  { id: "chain", label: "Plan" },
  { id: "context", label: "Context" },
  { id: "review", label: "Review" },
  { id: "ledger", label: "Ledger" },
  { id: "memory", label: "Workspaces" },
  { id: "proof", label: "Proof" },
];
```

Rename the `tab` state to `view`, default it to `"chat"`, and change every
`setTab("chain")` after starting/opening/resuming a task to `setView("chat")` —
a new task lands on the conversation, not the plan.

- [ ] **Step 2: Add the rail's data source**

```tsx
  // The rail reads the filesystem through the API. Bump the revision — never
  // poll — whenever something could have changed a workspace: a different team,
  // a flush, or a human review decision.
  const [memoryRevision, setMemoryRevision] = useState(0);
  const memberIds = useMemo(
    () => group?.members.map((member) => member.agentId) ?? [],
    [group],
  );
  const railMemory = useAgentMemory(memberIds, memoryRevision);

  useEffect(() => {
    setMemoryRevision((current) => current + 1);
  }, [selectedGroupId, state.memoryReady]);
```

In `reviewNote` and `revokeNote`, after `state.refreshMemory(taskId)`, add
`setMemoryRevision((current) => current + 1);`.

- [ ] **Step 3: Replace the header, composer and tabs with the shell**

Wrap the whole surface in `.team-shell` with `.team-main` and `MemberRail` as its
two columns:

```tsx
      <div className="team-shell">
        <div className="team-main">
          <header className="team-head">
            <div className="team-head-copy">
              <div className="team-head-title">
                <h1>{group?.name ?? "Teams"}</h1>
                {task && <Pill tone={statusTone(task.status)}>{task.status}</Pill>}
                {running && <span className="pulse" />}
              </div>
              <p>
                {group?.description ||
                  "A team of Agents working one shared plan on one shared codebase."}
              </p>
            </div>
            <div className="header-actions">
              {/* Edit team / New team / Cancel task / Resume task — unchanged */}
            </div>
          </header>

          <nav className="team-views">
            <button
              className={"team-view-primary " + (view === "chat" ? "selected" : "")}
              onClick={() => setView("chat")}
            >
              Conversation
            </button>
            <span className="team-views-rule" aria-hidden="true" />
            {SECONDARY_VIEWS.map((item) => {
              const count =
                item.id === "review"
                  ? state.notes.length
                  : item.id === "ledger"
                    ? state.grants.length
                    : 0;
              return (
                <button
                  key={item.id}
                  className={"team-view " + (view === item.id ? "selected" : "")}
                  onClick={() => setView(item.id)}
                  disabled={!task}
                  title={task ? undefined : "Start a task to inspect it"}
                >
                  {item.label}
                  {count > 0 && <span className="tab-count">{count}</span>}
                </button>
              );
            })}
          </nav>

          {/* the three existing .panel-note lines, unchanged */}

          <section className="group-panel">
            {view === "chat" && group && (
              <ConversationPanel
                messages={state.task?.messages ?? []}
                agents={agents}
                group={group}
                prompt={prompt}
                onPromptChange={setPrompt}
                onSubmit={startTask}
                running={running}
                busy={busy}
              />
            )}
            {/* chain / context / review / ledger / memory / proof — unchanged bodies */}
          </section>

          {/* the existing .task-history section, unchanged */}
        </div>

        {group && (
          <MemberRail
            group={group}
            agents={agents}
            nodes={state.task?.nodes ?? []}
            taskStatus={task?.status ?? null}
            memory={railMemory.memory}
            memoryLoading={railMemory.loading}
            memoryFailed={railMemory.failed}
            onOpenTrace={onOpenTrace}
          />
        )}
      </div>
```

Remove the now-dead `.task-composer` form (the conversation composer replaces
it), the `roster-inline` chip strip (the rail replaces it), and the
`TimelinePanel` import if nothing else uses it. Add:

```tsx
import { ConversationPanel } from "./ConversationPanel";
import { MemberRail } from "./MemberRail";
import { useAgentMemory } from "./useAgentMemory";
```

Task history moves below the panel so the conversation sits directly under the
view switch — history is a lookup, not the thing you came for.

- [ ] **Step 4: Append the shell styles**

```css
/* --- the two-column Teams shell --- */
.team-shell {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 22px;
  align-items: start;
}
.team-main { min-width: 0; }
.team-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 6px 0 14px;
}
.team-head-copy { min-width: 0; }
.team-head-title { display: flex; align-items: center; gap: 10px; }
.team-head h1 { margin: 0; font-size: 25px; font-weight: 700; letter-spacing: -0.015em; }
.team-head p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }

.team-views {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--line);
  padding-bottom: 9px;
  margin-bottom: 16px;
}
.team-view-primary {
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--paper);
  padding: 7px 15px;
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
}
.team-view-primary.selected { background: var(--purple); border-color: var(--purple); color: #fff; }
.team-views-rule { width: 1px; height: 18px; background: var(--line); margin: 0 7px; }
.team-view {
  border: 0;
  background: none;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.team-view:hover:not(:disabled) { color: var(--ink); background: rgba(0, 0, 0, 0.035); }
.team-view:disabled { opacity: 0.4; cursor: not-allowed; }
.team-view.selected { color: var(--purple-dark); font-weight: 600; background: var(--purple-soft); }

@media (max-width: 1180px) {
  .team-shell { grid-template-columns: minmax(0, 1fr); }
  .member-rail {
    position: static;
    max-height: none;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(258px, 1fr));
    gap: 11px;
  }
  .member-rail-head { grid-column: 1 / -1; }
}
@media (max-width: 680px) {
  .team-head { flex-direction: column; }
  .team-head .header-actions { width: 100%; }
}
```

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck -w @launchpad/web && npm run test -w @launchpad/web && npm run build -w @launchpad/web`
Expected: clean typecheck, all tests pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/group/GroupWorkspace.tsx apps/web/src/styles.css
git commit -m "feat(web): make the shared conversation the primary Teams surface"
```

---

### Task 8: Rehearse against the seeded demo in a real browser

`MILESTONE_PERSON_4.md` records "Layout is not asserted by any test" and
"1. Look at the UI in a browser. Nobody has." This closes that.

**Files:** none — verification only.

- [ ] **Step 1: Confirm the base UI is untouched**

```bash
git diff 8d0bd4f -- apps/web/src/styles.css | grep '^-' | grep -v '^---'
```
Expected: **no output**. Any removed line is a base rule being changed — revert it.

- [ ] **Step 2: Seed and serve**

```bash
export APP_DATA_DIR="$PWD/.data" AGENT_WORKSPACE_ROOT="$PWD/workspaces" CODEX_HOME="$PWD/codex-home"
npm run seed
npm run dev
```

- [ ] **Step 3: Walk the acceptance list**

At 1512×950, then 1180×900, then 680×900, confirm:

- Teams shows a persistent sidebar team list with the single seeded team.
- Selecting a team from the sidebar switches the workspace.
- Conversation is the landing view; every turn shows avatar, name, role, time.
- The member rail lists all three members with role, live status, and held memory.
- Plan shows role, Agent, status, instruction (or the "not recorded" line on the
  seeded rows), expected output, and a working Trace button.
- Review, Ledger, Workspaces and Proof still render their seeded data.
- Start a task: queued → running → terminal all stay readable, the composer locks
  with its reason, and the rail's status dot tracks the node.
- Cancel a running task: the rail reads "Stopped before …", not "Waiting for …".

- [ ] **Step 4: Confirm the console is clean**

No React key warnings, no unhandled rejections, no 4xx/5xx beyond an
intentionally cancelled task.

- [ ] **Step 5: Run the full repo gate**

```bash
npm run check
```
Expected: typecheck, server + web tests, and both builds pass.

---

## Self-review

**Spec coverage.**

| Requirement | Task |
|---|---|
| Person_4 #1 — repair the web build | already green on this branch; re-verified in Task 8 Step 5 |
| Person_4 #2 — persistent Teams sidebar with roster/status | Task 3 |
| Person_4 #3 — plan node instruction, role, Agent, status, expected output, trace; graceful when absent | Tasks 1, 6 |
| Person_4 #4 — Teams as a shared conversation, Agent profile panel, others secondary | Tasks 4, 5, 7 |
| Person_4 #5 — live execution data, bounded loading/error, no second endpoint | Tasks 2, 4, 7 |
| TODO §UI — no selector with one team | Task 3 |
| TODO §UI — "Plan" reads as planning because no instruction shows | Task 6 |
| TODO §UI — no member/profile panel at all | Task 4 |
| Acceptance — usable across queued/running/completed/partial/cancelled/failed | Task 2's precedence rules; verified in Task 8 Step 3 |
| Acceptance — targeted web tests pass | Tasks 2–7 each end on a green run |

**Type consistency.** `liveStatusFor(agentId, nodes, taskStatus)` and
`AgentLiveStatus.{state,label,nodeRole,completed,total}` are used with those exact
names in Tasks 2 and 4. `useAgentMemory(agentIds, revision)` returns
`{ memory, loading, failed }`, destructured as `railMemory.*` in Task 7.
`GroupPlanNode.instruction` is optional in Task 1 and read as
`node.instruction?.trim()` in Task 6. `useGroups(enabled)` returns
`{ groups, selectedId, select, refresh, error }`, read as `teams.*` in Task 3.

**Risks.**
- Tasks 3 and 7 both edit `GroupWorkspace.tsx`. Finish Task 3 and get the suite
  green before starting Task 7.
- `panels.test.tsx` currently imports three panels; Task 6 must add `ChainPanel`
  and `userEvent` to that import or the new tests will not resolve.
- `GroupEditor.test.tsx` mounts `GroupEditor` directly, so Task 3's prop change
  should not reach it. Confirm before editing.

---

## Continuation QA plan — 2026-08-30

The planned Teams work is present in the working tree. Before handoff, finish
the implementation through this short, additive QA pass:

- [x] Preserve selection correctness: clear a prior team's task when the user
  selects another team, then cover the regression in a frontend test.
- [x] Make group-list loading and failure states explicit so a failed request
  cannot impersonate an empty Teams workspace.
- [x] Make member-memory reads race-safe when a user switches teams quickly.
- [ ] Re-run web typecheck, tests, production build, the baseline-CSS guard,
  and a bounded desktop/mobile browser rehearsal. Report the known server-side
  stale-workspace conflict without masking or changing it here.
