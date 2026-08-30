#!/usr/bin/env node
/**
 * Re-run memory consolidation for an ALREADY-FINISHED group task, using the real
 * Ark extractor, over the trace already captured in the store. No agent work is
 * re-run — the task buffer reads runs/spans/outputs back from the store.
 *
 * Use it when a task was consolidated with MEMORY_EXTRACTOR=fake and you now
 * want real, task-derived notes without re-running the chain.
 *
 *   npm run build
 *   MEMORY_EXTRACTOR=ark node scripts/reconsolidate.mjs <groupTaskId>
 *
 * It targets the same store the server uses. On macOS the local poc keeps state
 * in ~/.volc-agent-launchpad; this script defaults to the same place, and honors
 * APP_DATA_DIR / AGENT_WORKSPACE_ROOT / LOCAL_POC_DATA_ROOT if you set them.
 *
 * What it does, in order:
 *   1. resetAutoNotes(taskId) — remove the earlier auto notes (+ files + grants)
 *      for this task. Human-approved notes are kept.
 *   2. runMemoryPipeline(taskId, sinks) — consolidate again with Ark and land.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const taskId = process.argv[2];
if (!taskId) {
  console.error("Usage: node scripts/reconsolidate.mjs <groupTaskId>");
  process.exit(2);
}

// Default to Ark — the whole point of this script — unless overridden.
process.env.MEMORY_EXTRACTOR ||= "ark";

// Mirror start-local-poc.sh so we hit the same store the poc uses. NOTE: .env
// sets APP_DATA_DIR=/app/data (the CONTAINER path), which is wrong on the host —
// the poc script overrides it. So we override any missing or /app/* value with
// the host state root, while still honoring a genuine host override.
const stateRoot =
  process.env.LOCAL_POC_DATA_ROOT ||
  (process.platform === "darwin"
    ? path.join(os.homedir(), ".volc-agent-launchpad")
    : path.join(process.cwd(), ".local"));
const looksContainerPath = (value) => !value || value.startsWith("/app");
if (looksContainerPath(process.env.APP_DATA_DIR))
  process.env.APP_DATA_DIR = path.join(stateRoot, "data");
if (looksContainerPath(process.env.AGENT_WORKSPACE_ROOT))
  process.env.AGENT_WORKSPACE_ROOT = path.join(stateRoot, "workspaces");
if (looksContainerPath(process.env.CODEX_HOME))
  process.env.CODEX_HOME = path.join(stateRoot, "codex-home");

const dist = path.join(process.cwd(), "apps/server/dist");
if (!existsSync(dist)) {
  console.error("Build first:  npm run build");
  process.exit(1);
}

const { loadConfig, isArkConfigured } = await import(path.join(dist, "config.js"));
const { JsonStore } = await import(path.join(dist, "store.js"));
const { createMemoryPipeline } = await import(
  path.join(dist, "memory/pipeline.js")
);

const config = loadConfig();
const storePath = path.join(config.dataDirectory, "launchpad.json");
console.log("store          : " + storePath);
console.log("extractor      : " + config.memoryExtractor);

if (config.memoryExtractor === "ark" && !isArkConfigured(config)) {
  console.error(
    "\nARK is selected but not configured (missing/placeholder ARK_API_KEY or " +
      "ARK_MODEL).\nExport a working key/model first, e.g.:\n" +
      "  set -a && source .env && set +a\n",
  );
  process.exit(1);
}

const store = new JsonStore(storePath);
await store.initialize();

const before = store.snapshot();
const task = before.groupTasks.find((item) => item.id === taskId);
if (!task) {
  console.error(`\nNo group task with id ${taskId} in this store.`);
  console.error("Known tasks:");
  for (const item of before.groupTasks) {
    console.error(`  ${item.id}  [${item.status}]  ${item.groupId}`);
  }
  process.exit(1);
}

const nodes = before.groupPlanNodes.filter((n) => n.groupTaskId === taskId);
const dependedOn = new Set(nodes.flatMap((n) => n.dependsOn));
const sinkNodeIds = nodes
  .filter((n) => !dependedOn.has(n.id))
  .map((n) => n.id);
const completedNodes = nodes.filter((n) => n.status === "completed").length;

console.log(`task           : ${taskId} [${task.status}]`);
console.log(`nodes          : ${nodes.length} (${completedNodes} completed)`);
console.log(
  `notes before   : ${before.notes.filter((n) => n.groupTaskId === taskId).length}`,
);

if (completedNodes === 0) {
  console.error(
    "\nThis task has no completed nodes — nothing to consolidate from.",
  );
  process.exit(1);
}

const pipeline = createMemoryPipeline(store, config, {
  reviewAllSkills: config.reviewAllSkills,
});

console.log("\nresetting fake/auto notes for this task…");
await pipeline.resetAutoNotes(taskId);

console.log("consolidating with " + config.memoryExtractor + "…");
await pipeline.runMemoryPipeline(taskId, sinkNodeIds);

const after = store.snapshot();
const notes = after.notes.filter((n) => n.groupTaskId === taskId);
const landed = after.landedMemoryFiles.filter(
  (f) => notes.some((n) => n.id === f.noteId) && f.removedAt === null,
);
const grants = after.grants.filter((g) => g.groupTaskId === taskId);

console.log(`\nnotes after    : ${notes.length}`);
for (const note of notes) {
  console.log(
    `  - [${note.severity}/${note.status}] ${note.description}\n    ${note.content}`,
  );
}
console.log(`landed files   : ${landed.length}`);
console.log(
  `grants         : ${grants.length} ` +
    `(${grants.filter((g) => g.decision === "granted").length} granted, ` +
    `${grants.filter((g) => g.decision === "withheld").length} withheld)`,
);
console.log(
  "\nDone. Severe/redacted/broad notes land as 'pending' for review; clean " +
    "narrow normal notes auto-landed. Refresh the Review tab to see them.",
);
