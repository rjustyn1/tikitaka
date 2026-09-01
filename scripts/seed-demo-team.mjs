#!/usr/bin/env node
/**
 * Seed the Agents and the team a live demo starts from, over the HTTP API.
 *
 * The demo's first minute should not be spent filling in CRUD forms, so this
 * creates the roster once. It is idempotent by NAME: re-running reuses whatever
 * already exists rather than collecting duplicates, which matters when you
 * reseed between rehearsals.
 *
 *   node scripts/seed-demo-team.mjs
 *
 * Reads APP_AUTH_TOKEN and PORT from .env, like the server does.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
    }),
);

const BASE = "http://localhost:" + (env.PORT ?? "3000");
const TOKEN = env.APP_AUTH_TOKEN;

async function api(path, init = {}) {
  const response = await fetch(BASE + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + TOKEN,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/** One instruction for all three working Agents, as briefed. */
const INSTRUCTIONS = [
  "Implement the task cleanly in one pass, in-memory, no external dependencies,",
  "then stop. Apply sensible input validation and auth where the task implies it.",
  "No tests or config files.",
].join("\n");

// The description is what the planner reads to assign work and what the
// recognizer embeds to route memory, so it carries the real weight here.
const AGENTS = [
  {
    name: "backend",
    description:
      "Backend HTTP/JSON API endpoints, authentication, and in-memory storage in plain Node/JS.",
    instructions: INSTRUCTIONS,
  },
  {
    name: "frontend",
    description:
      "Minimal HTML/JS UI — login form and list views, no frameworks or build tools.",
    instructions: INSTRUCTIONS,
  },
  {
    name: "security",
    description:
      "Reviews authentication, input validation, and secret handling; adds small targeted guards.",
    instructions: INSTRUCTIONS,
  },
  {
    name: "ops",
    description:
      "Keeps the run reproducible: environment, processes and logs. Present on the roster; rarely assigned work.",
    instructions: INSTRUCTIONS,
  },
];

// `--fresh` gives the team a new identity instead of reusing the existing one.
// There is no delete-group endpoint, and a team that has already run carries
// its old notes; for a rehearsal you usually want a clean board.
const FRESH = process.argv.includes("--fresh");
const TEAM_NAME = FRESH
  ? "App Dev Team " + new Date().toISOString().slice(11, 16).replace(":", "")
  : "App Dev Team";
const TEAM_DESCRIPTION = "Build a small to-do list app with authentication.";

const existingAgents = (await api("/api/agents")).agents;
const ids = {};
for (const wanted of AGENTS) {
  const found = existingAgents.find((agent) => agent.name === wanted.name);
  if (found) {
    ids[wanted.name] = found.id;
    console.log(`  agent ${wanted.name.padEnd(9)} reused  ${found.id}`);
    continue;
  }
  const created = (await api("/api/agents", {
    method: "POST",
    body: JSON.stringify(wanted),
  })).agent;
  ids[wanted.name] = created.id;
  console.log(`  agent ${wanted.name.padEnd(9)} created ${created.id}`);
}

// The role label only picks a colour dot; the planner reads the description.
const members = [
  { agentId: ids.backend, role: "backend" },
  { agentId: ids.frontend, role: "frontend" },
  { agentId: ids.security, role: "security" },
  { agentId: ids.ops, role: "backend" },
];

const existingTeam = (await api("/api/groups")).groups.find(
  (group) => group.name === TEAM_NAME,
);
const team = existingTeam
  ? (await api("/api/groups/" + existingTeam.id, {
      method: "PATCH",
      body: JSON.stringify({ description: TEAM_DESCRIPTION, members }),
    })).group
  : (await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({
        name: TEAM_NAME,
        description: TEAM_DESCRIPTION,
        members,
      }),
    })).group;

console.log(`  team  ${TEAM_NAME}  ${existingTeam ? "updated" : "created"}  ${team.id}`);
console.log("\nReady. Open the team and send:\n");
console.log("  Build a small to-do list app with authentication.\n");
