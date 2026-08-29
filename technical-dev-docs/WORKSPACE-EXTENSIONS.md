# Workspace Extensions Technical Design

## Component

`apps/server/src/workspace.ts`

## Purpose

Extend `WorkspaceManager` so group tasks can share code while preserving
per-Agent memory roots.

## New Responsibilities

- create shared code directories;
- link or mount shared code as `./code` in selected Agent workspaces;
- write group-task sections into private `AGENTS.md`;
- write normal memory skills;
- append severe memory entries;
- remove landed memory files on revoke.

## Shared Code Layout

```text
workspaces/
  shared-code/<groupTaskId>/
  <agentId>/
    AGENTS.md
    .agents/skills/
    code -> ../shared-code/<groupTaskId>
```

## Methods

```ts
createSharedCodeDirectory(groupTaskId: string): Promise<string>
linkSharedCode(agent: Agent, sharedCodePath: string): Promise<void>
writeGroupTaskSection(agent: Agent, section: string): Promise<void>
appendAgentsMemory(agent: Agent, note: MemoryNote): Promise<void>
writeSkill(agent: Agent, note: MemoryNote): Promise<string>
removeLandedMemory(agent: Agent, note: MemoryNote): Promise<void>
```

## Code-Level Spec

Add methods to `WorkspaceManager`:

```ts
sharedCodePath(groupTaskId: string): string {
  return path.join(this.root, "shared-code", groupTaskId);
}

async createSharedCodeDirectory(groupTaskId: string): Promise<string>;
async linkSharedCode(agent: Agent, sharedCodePath: string): Promise<void>;
async writeGroupTaskSection(agent: Agent, task: GroupTask, section: string): Promise<void>;
async clearGroupTaskSection(agent: Agent, groupTaskId: string): Promise<void>;
async appendAgentsMemory(agent: Agent, note: MemoryNote): Promise<string>;
async writeSkill(agent: Agent, note: MemoryNote): Promise<string>;
async removeLandedMemory(file: LandedMemoryFile): Promise<void>;
```

Implementation details:

```ts
createSharedCodeDirectory:
  mkdir(workspaces/shared-code/<groupTaskId>, { recursive: false })
  write README.md explaining this directory is code-only
  write .gitignore for generated files if needed

linkSharedCode:
  create symlink <agent.workspacePath>/code -> sharedCodePath
  if code already exists and points to same target, do nothing
  if code exists and points elsewhere, throw 409-style error

writeGroupTaskSection:
  replace block between markers in private AGENTS.md
  preserve stable identity block
  preserve governed memory blocks

appendAgentsMemory:
  add or replace <!-- memory:<noteId> --> block
  return AGENTS.md path

writeSkill:
  mkdir <agent.workspacePath>/.agents/skills/<slug>
  write SKILL.md with frontmatter
  return file path

removeLandedMemory:
  if kind=agents_md, remove memory block
  if kind=skill, delete skill directory
```

Use helper functions:

```ts
function replaceManagedBlock(
  content: string,
  start: string,
  end: string,
  replacement: string,
): string;

function removeManagedBlock(content: string, start: string, end: string): string;
```

Do not implement memory landing by appending unbounded text. Always use managed
markers so landing is idempotent and revocation is precise.

## AGENTS.md Sections

`writeInstructions()` currently regenerates `AGENTS.md`. Extensions should keep
managed blocks separate:

```text
<!-- group-task:<groupTaskId> -->
Group task charter, selected members, shared ./code path, DAG role map, and
file ownership hints.
<!-- /group-task:<groupTaskId> -->

<!-- memory:<noteId> -->
Governed memory content, severity, source task id, and note id.
<!-- /memory:<noteId> -->
```

Regeneration must preserve governed memory blocks unless explicitly revoked.

`writeInstructions()` currently regenerates the whole file. Update it to compose
the base identity section, then append any existing managed group-task and
memory blocks.

## Container Runtime Note

Local-process runtime can use symlinks. Container runtime needs shared code to
be visible inside the mounted workspace. Either mount the shared code path
explicitly or place shared code under a mounted parent.

## Tests

- creates shared code directory;
- links `./code` for selected Agents;
- does not place memory in shared code;
- preserves memory blocks when Agent instructions regenerate;
- removes memory blocks on revoke.
