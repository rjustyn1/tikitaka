#!/usr/bin/env node
/**
 * Diagnose a real group task.
 *
 * Three of the four things a live run is supposed to prove fail SILENTLY:
 * a node can report `completed` while the Agent never managed to write to
 * shared code, and an empty Review tab looks identical whether the consolidator
 * rejected every note or never received a span in the first place. This script
 * says which.
 *
 *   npm run build && node scripts/verify-live.mjs
 *
 * Point it at the same store the server used:
 *   LOCAL_POC_DATA_ROOT=$HOME/.volc-agent-launchpad node scripts/verify-live.mjs
 *
 * Reads only. It never writes to the store or to a workspace.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const dist = path.join(process.cwd(), "apps/server/dist");
if (!existsSync(dist)) {
  console.error("Build first:  npm run build");
  process.exit(1);
}

const { loadConfig } = await import(path.join(dist, "config.js"));
const { JsonStore } = await import(path.join(dist, "store.js"));
const { shouldIncludeSpan } = await import(path.join(dist, "memory/task-buffer.js"));

const PASS = "[32m✓[0m";
const FAIL = "[31m✗[0m";
const WARN = "[33m![0m";
const INFO = "[36m?[0m";

let failures = 0;
const line = (mark, label, detail) =>
  console.log("  " + mark + " " + label.padEnd(16) + detail);
const note = (text) => console.log("                     → " + text);

/** poc keeps state outside the repo; mirror the script's own resolution. */
function resolveDataDir() {
  if (process.env.APP_DATA_DIR) return path.resolve(process.env.APP_DATA_DIR);
  const root =
    process.env.LOCAL_POC_DATA_ROOT ??
    path.join(process.env.HOME ?? "", ".volc-agent-launchpad");
  if (existsSync(path.join(root, "data", "launchpad.json"))) {
    return path.join(root, "data");
  }
  return loadConfig(process.env).dataDirectory;
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    // Ignore the marker files the workspace manager drops in itself.
    if (entry === "README.md" || entry === ".gitignore") continue;
    total += statSync(full).isDirectory() ? countFiles(full) : 1;
  }
  return total;
}

const dataDirectory = resolveDataDir();
const storePath = path.join(dataDirectory, "launchpad.json");
if (!existsSync(storePath)) {
  console.error("No store at " + storePath);
  console.error("Set APP_DATA_DIR or LOCAL_POC_DATA_ROOT to the one the server used.");
  process.exit(1);
}

const store = new JsonStore(storePath);
await store.initialize();
const db = store.snapshot();

const task = [...db.groupTasks].sort((a, b) =>
  (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt),
)[0];
if (!task) {
  console.error("No group task in " + storePath + ". Run one first.");
  process.exit(1);
}

const nodes = db.groupPlanNodes.filter((n) => n.groupTaskId === task.id);
const nodeIds = new Set(nodes.map((n) => n.id));
const runIds = new Set(nodes.map((n) => n.runId).filter(Boolean));
const spans = db.spans.filter((s) => runIds.has(s.runId));
const notes = db.notes.filter((n) => n.groupTaskId === task.id);
const grants = db.grants.filter((g) => g.groupTaskId === task.id);
const agentName = (id) =>
  db.agents.find((a) => a.id === id)?.name ?? String(id).slice(0, 8);

console.log("");
console.log("  store   " + storePath);
console.log("  task    " + task.id);
console.log("  status  " + task.status + "   flushedAt " + (task.flushedAt ?? "null"));
console.log("");

// --- 1. the chain -----------------------------------------------------------
const completed = nodes.filter((n) => n.status === "completed");
if (nodes.length > 0 && completed.length === nodes.length) {
  line(PASS, "chain", completed.length + "/" + nodes.length + " nodes completed");
} else {
  failures += 1;
  line(FAIL, "chain", completed.length + "/" + nodes.length + " nodes completed");
  for (const n of nodes.filter((x) => x.status !== "completed")) {
    note(n.nodeRole + " (" + agentName(n.agentId) + "): " + n.status +
      (n.error ? " — " + n.error.slice(0, 90) : ""));
  }
}

// --- 2. shared code ---------------------------------------------------------
// A node can report `completed` while the Agent reports in prose that it could
// not write anything. The only honest check is the directory.
const sharedFiles = countFiles(task.sharedCodePath);
if (sharedFiles > 0) {
  line(PASS, "shared code", sharedFiles + " file(s) under " + path.basename(task.sharedCodePath));
} else {
  failures += 1;
  line(FAIL, "shared code", "nothing written to " + task.sharedCodePath);
  note("A2 is unproven: the Agents never wrote through ./code.");
  note("Check a node's trace for a sandbox or permission error.");
  const member = db.groupParticipants.find((p) => p.groupId === task.groupId);
  if (member) {
    const link = path.join(member.agentWorkspacePath, "code");
    note("./code in a workspace: " + (existsSync(link) ? "present" : "MISSING — prepareSharedCode did not run"));
  }
}

// --- 3. spans -> notes ------------------------------------------------------
// The silent one. Run the REAL filter so this can never drift from the pipeline.
const kept = spans.filter(shouldIncludeSpan);
if (notes.length > 0) {
  line(PASS, "spans → notes", notes.length + " note(s) from " + kept.length + "/" + spans.length + " usable spans");
  const byStatus = {};
  for (const n of notes) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
  note(Object.entries(byStatus).map(([k, v]) => v + " " + k).join(", "));
} else {
  failures += 1;
  line(FAIL, "spans → notes", "0 notes produced");
  if (spans.length === 0) {
    note("No spans captured at all for this task's runs.");
    note("The runner never called onSpan — nothing downstream can work.");
  } else if (kept.length === 0) {
    note(spans.length + " spans captured, but shouldIncludeSpan kept NONE.");
    const byType = {};
    for (const s of spans) byType[s.type] = (byType[s.type] ?? 0) + 1;
    note("types seen: " + Object.entries(byType).map(([k, v]) => k + "×" + v).join(", "));
    const reasoning = spans.filter((s) => s.type === "reasoning");
    if (reasoning.length > 0) {
      const terminal = reasoning.filter((s) => s.payload?.terminal === true).length;
      note("reasoning spans with terminal:true — " + terminal + "/" + reasoning.length);
      if (terminal === 0) {
        note("THIS IS THE CAUSE: the filter keeps reasoning only when terminal===true.");
        note("Fix in apps/server/src/memory/task-buffer.ts → shouldIncludeSpan.");
      }
    }
    const cmd = spans.filter((s) => s.type === "command_exec");
    if (cmd.length > 0) {
      note("command_exec spans are kept only when status==='failed' (" +
        cmd.filter((s) => s.status === "failed").length + "/" + cmd.length + " failed).");
    }
  } else {
    note(kept.length + " usable spans reached the buffer, so the extractor ran.");
    note("The consolidator returned nothing, or every candidate failed validation.");
    note("Notes must cite sourceRunIds and sourceSpanIds that exist in the buffer.");
    note("MEMORY_EXTRACTOR=" + (process.env.MEMORY_EXTRACTOR ?? "fake") +
      " — 'off' always returns zero notes.");
  }
  if (!task.flushedAt) {
    note("flushedAt is null: consolidation never ran. decideFlush wants a " +
      "terminal sink node and at least one completed node.");
  }
}

// --- the governance claim ---------------------------------------------------
const landed = db.landedMemoryFiles.filter(
  (f) => f.removedAt === null && notes.some((n) => n.id === f.noteId),
);
const missing = landed.filter((f) => !existsSync(f.path));
if (notes.length > 0) {
  if (grants.length === 0) {
    failures += 1;
    line(FAIL, "ledger", "notes exist but no grant records were written");
  } else {
    const withheld = grants.filter((g) => g.decision === "withheld").length;
    line(PASS, "ledger", grants.length + " decisions (" + withheld + " withheld)");
  }
  if (missing.length > 0) {
    failures += 1;
    line(FAIL, "landed files", missing.length + " row(s) point at a file that is gone");
    for (const f of missing) note(f.path);
  } else if (landed.length > 0) {
    line(PASS, "landed files", landed.length + " file(s) present on disk");
  }
}

// --- safety invariants ------------------------------------------------------
const codexHome = loadConfig(process.env).codexHome;
const strayHome = existsSync(path.join(codexHome, "skills"))
  ? readdirSync(path.join(codexHome, "skills")).filter((d) => d.startsWith("memory-"))
  : [];
const strayShared =
  existsSync(task.sharedCodePath) &&
  readdirSync(task.sharedCodePath).some((e) => e === "AGENTS.md" || e === ".agents");
if (strayHome.length === 0 && !strayShared) {
  line(PASS, "isolation", "no governed memory under CODEX_HOME or shared-code");
} else {
  failures += 1;
  line(FAIL, "isolation", "governed memory escaped its workspace");
  if (strayHome.length > 0) note("CODEX_HOME/skills has: " + strayHome.join(", ") +
    " — that path is GLOBAL to every Agent");
  if (strayShared) note("shared-code contains AGENTS.md or .agents/");
}

// --- 4. does the skill fire? ------------------------------------------------
const skills = landed.filter((f) => f.kind === "skill");
if (skills.length > 0) {
  line(INFO, "skill fires", "not checkable from here — run the Proof tab");
  const first = skills[0];
  note("granted: " + agentName(first.agentId) + "  →  " +
    path.basename(path.dirname(first.path)));
  const outsiders = db.agents.filter(
    (a) => !db.groups.find((g) => g.id === task.groupId)?.members.some((m) => m.agentId === a.id),
  );
  if (outsiders[0]) note("withheld: " + outsiders[0].name + " (holds nothing)");
  note("Codex emits no skill-invocation event, so this is the one claim the " +
    "audit cannot make for you.");
} else if (notes.length > 0) {
  line(WARN, "skill fires", "no skill landed — approve a normal note first");
}

console.log("");
if (failures === 0) {
  console.log("  All checkable claims hold. The Proof tab is the remaining one.");
} else {
  console.log("  " + failures + " check(s) failed — see the arrows above.");
}
console.log("");
process.exit(failures === 0 ? 0 : 1);
