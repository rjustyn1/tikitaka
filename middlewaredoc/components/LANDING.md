# Landing Technical Design

## Component

`apps/server/src/memory/landing.ts`

## Purpose

Write approved memory notes into the right Agent workspace files.

Landing is the enforcement point. A memory reaches an Agent if and only if
landing writes it into that Agent's private workspace.

## Inputs

```ts
interface LandMemoryInput {
  note: MemoryNote;
  targetAgents: Agent[];
}
```

## Output

```ts
interface LandMemoryResult {
  noteId: string;
  grantedAgentIds: string[];
  fileWrites: LandedMemoryFile[];
}
```

## Code-Level Spec

Export:

```ts
export class LandingService {
  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
  ) {}

  landMemory(note: MemoryNote): Promise<LandMemoryResult>;
  revokeMemory(note: MemoryNote): Promise<void>;
  listAgentMemory(agentId: string): LandedMemoryFile[];
}
```

Implementation sketch:

```ts
async function landMemory(note: MemoryNote) {
  const db = store.snapshot();
  const agents = db.agents.filter((agent) => note.targetAgentIds.includes(agent.id));

  const fileWrites = [];
  for (const agent of agents) {
    const path = note.severity === "severe"
      ? await workspaces.appendAgentsMemory(agent, note)
      : await workspaces.writeSkill(agent, note);
    fileWrites.push({ noteId: note.id, agentId: agent.id, path });
  }

  await store.mutate((db) => {
    db.landedMemoryFiles.push(...toLandedMemoryFiles(fileWrites));
  });

  return { noteId: note.id, grantedAgentIds: agents.map((a) => a.id), fileWrites };
}
```

Slug generation:

```ts
function noteSlug(note: MemoryNote): string {
  const base = note.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${base || "memory"}-${note.id.slice(0, 8)}`;
}
```

Idempotency:

- severe notes replace the same `<!-- memory:<noteId> -->` block;
- normal notes write the same skill path for the same note;
- `landedMemoryFiles` should not duplicate active rows for the same
  `(noteId, agentId, kind)`.

## File Placement

```text
severe note:
  <agent.workspacePath>/AGENTS.md

normal note:
  <agent.workspacePath>/.agents/skills/<note-slug>/SKILL.md
```

Never write governed memory into:

```text
shared-code/<groupId>/
shared-code/<groupId>/AGENTS.md
shared-code/<groupId>/.agents/skills/
```

## Severe Entry Format

Append or regenerate a managed section in `AGENTS.md`:

```text
## Governed Memories

<!-- memory:<noteId> -->
- <content>
  Source task: <groupTaskId>
<!-- /memory:<noteId> -->
```

## Normal Skill Format

```md
---
name: memory-<slug>
description: <note description>
---

# Governed Memory

<content>

Source task: <groupTaskId>
```

## Revocation

- remove severe memory block from `AGENTS.md`;
- delete normal skill directory;
- do not delete ledger records;
- mark memory unavailable on next run.

## Tests

- lands severe note only in target Agent `AGENTS.md`;
- lands normal note only in target Agent skills dir;
- does not write into shared code;
- revoke removes files;
- repeated landing is idempotent.
