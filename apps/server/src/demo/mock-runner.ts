/**
 * An offline stand-in for Codex, for demoing the whole workflow without a
 * model, a key or a container.
 *
 * It is a real `AgentRunner`, not a stub that returns a string: it takes time,
 * emits the same span shapes the real runner does, and WRITES REAL FILES into
 * the group's shared code. That matters because the rest of the product is
 * built on the filesystem being the truth -- the workspace explorer reads the
 * tree, and the consolidator reads spans. A runner that skipped either would
 * demo a hollow version of the thing.
 *
 * Selected by DEMO_MODE=1. Never reachable otherwise.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RunCancelledError } from "../errors.js";
import type {
  AgentRunner,
  RunnerRequest,
  RunnerResult,
  TraceSpan,
  TraceSpanPayload,
  TraceSpanType,
} from "../types.js";

/**
 * Per-step pacing. Long on purpose: a step has to stay on screen long enough
 * to read its message and watch its files appear, and the spread means the
 * parallel branches finish at different times rather than all at once.
 */
const MIN_STEP_MS = 15_000;
const MAX_STEP_MS = 20_000;

/**
 * Files a step writes, chosen by the role in its prompt. Content is ordinary
 * and specific: the consolidator has to have something worth remembering, and
 * "lorem ipsum" produces notes about nothing.
 */
const WORK: Array<{
  match: RegExp;
  summary: string;
  facts: string[];
  files: Array<{ path: string; body: string }>;
}> = [
  {
    // Deliberately last-resort: matched only if no specific role fits.
    match: /^__planning__$/,
    summary:
      "Split the to-do app into auth, the to-do API, the UI and a review pass. " +
      "Settled the session model first because every other step depends on it.",
    facts: [
      "Sessions are an in-memory Map from opaque token to user id; there is no JWT and no store.",
      "Every to-do carries an ownerId, and list queries filter by the session's user.",
    ],
    files: [
      {
        path: "docs/plan.md",
        body: [
          "# To-do app with authentication",
          "",
          "1. Auth: register, login, session tokens",
          "2. To-do API: create, list, toggle, delete — scoped to the caller",
          "3. UI: login form and list view, no framework",
          "4. Security review of auth and input validation",
          "",
          "## Settled up front",
          "",
          "- Sessions: opaque random token -> userId, held in memory.",
          "- Every to-do has an `ownerId`; listing filters on the session user.",
        ].join("\n"),
      },
    ],
  },
  {
    // One backend step now: three branches, three working Agents, so auth and
    // the to-do endpoints are the same Agent's step rather than two.
    match: /^api$|auth|todo|endpoint|session/i,
    summary:
      "Added auth and the to-do endpoints. Passwords are hashed with scrypt " +
      "and a per-user salt, login returns an opaque session token, and every " +
      "to-do carries an ownerId so reads are scoped to the caller.",
    facts: [
      "Passwords are hashed with scrypt and a per-user salt; plaintext is never stored.",
      "The session token is opaque and random; it never encodes the user id.",
      "Login answers identically for an unknown user and a wrong password, so the endpoint cannot enumerate accounts.",
      "Every to-do carries an ownerId; reads filter by the session user, never by a client-supplied id.",
      "Titles are trimmed and capped at 200 characters; an empty title is a 400.",
    ],
    files: [
      {
        path: "src/auth.js",
        body: [
          "const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');",
          "",
          "const users = new Map();    // email -> { id, salt, hash }",
          "const sessions = new Map(); // token -> userId",
          "",
          "function hash(password, salt) {",
          "  return scryptSync(password, salt, 64);",
          "}",
          "",
          "function register(email, password) {",
          "  if (users.has(email)) throw new Error('Email already registered');",
          "  const salt = randomBytes(16).toString('hex');",
          "  const id = randomBytes(8).toString('hex');",
          "  users.set(email, { id, salt, hash: hash(password, salt) });",
          "  return id;",
          "}",
          "",
          "function login(email, password) {",
          "  const user = users.get(email);",
          "  // Same answer either way: a different one would enumerate accounts.",
          "  if (!user || !timingSafeEqual(hash(password, user.salt), user.hash)) {",
          "    return null;",
          "  }",
          "  const token = randomBytes(24).toString('hex');",
          "  sessions.set(token, user.id);",
          "  return token;",
          "}",
          "",
          "module.exports = { register, login, sessions };",
        ].join("\n"),
      },
      {
        path: "src/todos.js",
        body: [
          "const { randomBytes } = require('node:crypto');",
          "",
          "const todos = []; // { id, ownerId, title, done }",
          "const MAX_TITLE = 200;",
          "",
          "function create(ownerId, title) {",
          "  const clean = String(title ?? '').trim();",
          "  if (!clean) throw Object.assign(new Error('Title required'), { status: 400 });",
          "  if (clean.length > MAX_TITLE) throw Object.assign(new Error('Title too long'), { status: 400 });",
          "  const todo = { id: randomBytes(8).toString('hex'), ownerId, title: clean, done: false };",
          "  todos.push(todo);",
          "  return todo;",
          "}",
          "",
          "// Ownership is the filter. Never take the owner from the request body.",
          "function list(ownerId) {",
          "  return todos.filter((todo) => todo.ownerId === ownerId);",
          "}",
          "",
          "module.exports = { create, list, todos };",
        ].join("\n"),
      },
      {
        path: "src/server.js",
        body: [
          "const http = require('node:http');",
          "const { sessions } = require('./auth');",
          "const todos = require('./todos');",
          "",
          "function userFor(request) {",
          "  const token = (request.headers.authorization ?? '').replace('Bearer ', '');",
          "  return sessions.get(token) ?? null;",
          "}",
          "",
          "http.createServer((request, response) => {",
          "  const ownerId = userFor(request);",
          "  if (!ownerId) {",
          "    response.writeHead(401).end(JSON.stringify({ error: 'Sign in first' }));",
          "    return;",
          "  }",
          "  response.end(JSON.stringify(todos.list(ownerId)));",
          "}).listen(8080);",
        ].join("\n"),
      },
    ],
  },
  {
    match: /ui|frontend|client|form|view/i,
    summary:
      "Built the login form and list view in plain HTML and JS. The token is " +
      "kept in memory for the page session rather than localStorage.",
    facts: [
      "The session token is held in a page variable, not localStorage, so it does not outlive the tab.",
      "The UI renders to-do titles with textContent, never innerHTML.",
    ],
    files: [
      {
        path: "public/index.html",
        body: [
          "<!doctype html>",
          "<meta charset=\"utf-8\">",
          "<title>To-do</title>",
          "<form id=\"login\">",
          "  <input name=\"email\" type=\"email\" required>",
          "  <input name=\"password\" type=\"password\" required>",
          "  <button>Sign in</button>",
          "</form>",
          "<ul id=\"list\"></ul>",
          "<script src=\"app.js\"></script>",
        ].join("\n"),
      },
      {
        path: "public/app.js",
        body: [
          "// Kept in memory on purpose: the token should not outlive the tab.",
          "let token = null;",
          "",
          "async function render() {",
          "  const items = await (await fetch('/todos', {",
          "    headers: { authorization: 'Bearer ' + token },",
          "  })).json();",
          "  const list = document.getElementById('list');",
          "  list.replaceChildren();",
          "  for (const item of items) {",
          "    const li = document.createElement('li');",
          "    li.textContent = item.title; // textContent, never innerHTML",
          "    list.append(li);",
          "  }",
          "}",
        ].join("\n"),
      },
    ],
  },
  {
    match: /integration-check/i,
    summary:
      "Checked the parts against each other. The UI, the endpoints and the " +
      "session model agree; one gap: the to-do routes trusted the caller for " +
      "ownership on delete.",
    facts: [
      "Ownership must be re-checked on delete, not only on read.",
    ],
    files: [
      {
        path: "docs/integration-notes.md",
        body: [
          "# Integration check",
          "",
          "- Login -> token -> `Authorization: Bearer` works end to end.",
          "- Gap: `delete` did not re-check ownership. Handed to hardening.",
        ].join("\n"),
      },
    ],
  },
  {
    match: /hardening/i,
    summary:
      "Applied the guard the integration check asked for: delete now resolves " +
      "the to-do by id AND owner, so a stolen id is not enough.",
    facts: [
      "Every mutating route resolves the record by id AND owner; an id alone is never sufficient.",
    ],
    files: [
      {
        path: "src/guards.js",
        body: [
          "// Resolve by id AND owner. An id on its own is not authorisation.",
          "function ownedBy(todos, ownerId, id) {",
          "  return todos.find((todo) => todo.id === id && todo.ownerId === ownerId) ?? null;",
          "}",
          "",
          "module.exports = { ownedBy };",
        ].join("\n"),
      },
    ],
  },
  {
    match: /security|review|audit|final/i,
    summary:
      "Reviewed auth and the to-do path. Ownership is enforced server-side on " +
      "every read, and the login response cannot be used to enumerate accounts.",
    facts: [
      "Ownership must be enforced server-side on every read; a client-supplied ownerId is never trusted.",
      "Session tokens must never be logged: the token is the credential.",
    ],
    files: [
      {
        path: "docs/security-review.md",
        body: [
          "# Security review",
          "",
          "- Ownership is enforced server-side on every read. A client-supplied",
          "  `ownerId` is never trusted.",
          "- Login answers identically for unknown email and wrong password.",
          "- Session tokens are credentials and must not be logged.",
          "- Titles are trimmed, length-capped, and rendered with textContent.",
        ].join("\n"),
      },
    ],
  },
];

const PLANNING = WORK[0]!;

/**
 * Match on THIS node's role only.
 *
 * The turn prompt embeds the dependency outputs of earlier steps, so testing
 * the whole prompt made the client step match the API step's text and write
 * the API's files. `buildTurnPrompt` states the role on its own line, so that
 * is the one part of the prompt that describes this node and nothing else.
 */
function roleOf(prompt: string): string {
  const match = /^Node role: (.+?)\.$/m.exec(prompt) ?? /^Node: (.+)$/m.exec(prompt);
  return match?.[1]?.trim() ?? "";
}

function workFor(prompt: string): (typeof WORK)[number] {
  const role = roleOf(prompt);
  const specific = WORK.slice(1).find((entry) => entry.match.test(role));
  return specific ?? PLANNING;
}

export class MockAgentRunner implements AgentRunner {
  private readonly cancels = new Map<string, () => void>();

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const work = workFor(request.prompt);
    const startedAt = new Date().toISOString();

    request.onSpan?.(
      span(request, 1, "reasoning", {
        kind: "reasoning",
        text:
          "Reading the shared code, then doing my part: " +
          work.summary.split(".")[0] + ".",
        truncated: false,
        terminal: true,
      }),
    );

    await this.pace(request.agentId);

    // Real files, in the real shared directory. The explorer polls this, so the
    // tree fills in while the DAG is still running.
    const written: string[] = [];
    if (request.sharedCodePath) {
      for (const file of work.files) {
        const target = path.join(request.sharedCodePath, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.body + "\n", "utf8");
        written.push(file.path);
        request.onSpan?.(
          span(request, written.length + 1, "file_write", {
            kind: "file_write",
            changes: [{ path: file.path, changeKind: "add" }],
          }),
        );
      }
    }

    const output = [
      work.summary,
      "",
      written.length > 0
        ? "Added:\n" + written.map((file) => "  " + file).join("\n")
        : "Nothing to add here — this step only read.",
      "",
      "What follows from this:",
      ...work.facts.map((fact) => "- " + fact),
    ].join("\n");

    request.onSpan?.(
      span(request, written.length + 2, "agent_message", {
        kind: "agent_message",
        text: output,
      }),
    );

    return {
      output,
      threadId: request.threadId ?? "demo-thread-" + request.agentId.slice(0, 8),
      usage: { inputTokens: 900 + written.length * 40, outputTokens: 220 },
    };

    function span(
      req: RunnerRequest,
      seq: number,
      type: TraceSpanType,
      payload: TraceSpanPayload,
    ): TraceSpan {
      return {
        id: randomUUID(),
        runId: req.runId,
        agentId: req.agentId,
        seq,
        type,
        parentId: null,
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: 1,
        payload,
        itemId: null,
      };
    }
  }

  /** Cancellable sleep, so Stop still works during a demo run. */
  private pace(agentId: string): Promise<void> {
    const ms = MIN_STEP_MS + Math.random() * (MAX_STEP_MS - MIN_STEP_MS);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cancels.delete(agentId);
        resolve();
      }, ms);
      this.cancels.set(agentId, () => {
        clearTimeout(timer);
        this.cancels.delete(agentId);
        reject(new RunCancelledError());
      });
    });
  }

  async cancel(agentId: string): Promise<boolean> {
    const stop = this.cancels.get(agentId);
    if (!stop) return false;
    stop();
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
