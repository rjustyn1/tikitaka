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

## Shared Code Per Runtime (A2 - VERIFIED)

The two runtimes need different mechanisms. This is the ONLY place they differ.
Replace `linkSharedCode` with one runtime-aware method:

```ts
async prepareSharedCode(agent: Agent, sharedCodePath: string): Promise<void> {
  if (config.runtimeProvider === "container") {
    // Just ensure the mount point exists. ContainerCodexRunner bind-mounts
    // sharedCodePath onto <workspace>/code, so ./code is a REAL directory
    // inside the container. No symlink.
    await mkdir(path.join(agent.workspacePath, "code"), { recursive: true });
    return;
  }
  // local-process: symlink, and the runner passes --add-dir sharedCodePath
  // because ./code resolves outside the cwd.
  await symlink(sharedCodePath, path.join(agent.workspacePath, "code"));
}
```

Verified behaviour of the container nested-mount layout:

```text
./code is a real directory, reads and writes both work
writes land on the host in shared-code/<taskId>
nothing leaks into the private Agent workspace
Docker creates the mount point if it does not exist
two Agents mounting the same shared dir concurrently is fine
/workspace/code is INSIDE the cwd, so workspace-write permits it natively
  -> no --add-dir needed in container mode
```

A symlink pointing outside the mounted Agent root is BROKEN in container mode -
verified: `cannot create code/y.txt: Directory nonexistent`. Do not use one.

## Tests

- creates shared code directory;
- links `./code` for selected Agents;
- does not place memory in shared code;
- preserves memory blocks when Agent instructions regenerate;
- removes memory blocks on revoke.

---

## Ordering Dependency - Person 2 Blocks Person 3

**This is a hard sequencing constraint that was previously unstated.**

`writeInstructions()` currently regenerates `AGENTS.md` from scratch
(`workspace.ts:38`) and `AgentService.updateAgent()` calls it on every Agent edit
(`agent-service.ts:129`).

```text
Consequence today: editing an Agent AFTER governed memory has landed silently
WIPES the <!-- memory:<noteId> --> block. The demo would show memory vanishing
for no visible reason.
```

Therefore:

```text
Person 2 MUST land managed-block-preserving writeInstructions() BEFORE
Person 3 lands any governed memory.
```

The composed form:

```text
1. base identity section        (regenerated from Agent fields)
2. <!-- group-task:<id> -->     (preserved, or rewritten by the planner)
3. <!-- memory:<noteId> -->     (PRESERVED ALWAYS - only revoke removes these)
```

Person 2 lands `replaceManagedBlock()` / `removeManagedBlock()` first. Person 3
imports those helpers rather than reimplementing them.

## File Ownership (corrected)

```text
Person 2 OWNS apps/server/src/workspace.ts
  shared code setup, group-task AGENTS.md sections, the managed-block helpers

Person 3 OWNS apps/server/src/memory/workspace-memory.ts
  appendAgentsMemory, writeSkill, removeLandedMemory
  imports Person 2's helpers, does NOT edit workspace.ts
```

The original split listed `workspace.ts` under both people. It is Person 2's.

## Skill Path (A1 - VERIFIED)

```text
<agent.workspacePath>/.agents/skills/<slug>/SKILL.md    scope "repo"  CORRECT
$CODEX_HOME/skills/<slug>/SKILL.md                      scope "user"  NEVER
```

Verified on `@openai/codex@0.111.0`: repo-scoped skills are discovered per
workspace, discovery does **not** walk up to parent directories, and a workspace
with no skill files sees none. A git repo is not required.

`$CODEX_HOME` is mounted into **every** Agent container, so anything written
there reaches all Agents. Add a startup assertion that `$CODEX_HOME/skills`
contains no governed memory.
