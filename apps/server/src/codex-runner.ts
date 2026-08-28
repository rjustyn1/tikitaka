import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
  TraceSpan,
  TraceSpanPayload,
  TraceSpanStatus,
  TraceSpanType,
} from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_SPANS = 500;
const MAX_REASONING_CHARS = 8_000;
const MAX_CMD_OUTPUT_CHARS = 4_000;
const MAX_TOOL_PAYLOAD_CHARS = 4_000;

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  spans: TraceSpan[];
  openSpans: Map<string, TraceSpan>;
  pendingReasoning: TraceSpan[];
  seq: number;
  runId: string;
  agentId: string;
  onSpan?: (span: TraceSpan) => void;
  onThreadId?: (id: string) => void;
}

export function createParsedEvents(init: {
  runId: string;
  agentId: string;
  threadId: string | null;
  onSpan?: (span: TraceSpan) => void;
  onThreadId?: (id: string) => void;
}): ParsedEvents {
  const events: ParsedEvents = {
    messages: [],
    threadId: init.threadId,
    usage: null,
    errors: [],
    spans: [],
    openSpans: new Map(),
    pendingReasoning: [],
    seq: 0,
    runId: init.runId,
    agentId: init.agentId,
  };
  if (init.onSpan !== undefined) events.onSpan = init.onSpan;
  if (init.onThreadId !== undefined) events.onThreadId = init.onThreadId;
  return events;
}

function makeSpan(
  parsed: ParsedEvents,
  type: TraceSpanType,
  payload: TraceSpanPayload,
  itemId: string | null,
  status: TraceSpanStatus = "started",
): TraceSpan {
  return {
    id: randomUUID(),
    runId: parsed.runId,
    agentId: parsed.agentId,
    seq: parsed.seq++,
    type,
    parentId: null,
    status,
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    payload,
    itemId,
  };
}

function applyLinkage(span: TraceSpan, parsed: ParsedEvents): void {
  if (span.type === "reasoning") {
    parsed.pendingReasoning.push(span);
  } else if (parsed.pendingReasoning.length > 0) {
    span.parentId = parsed.pendingReasoning.at(-1)!.id;
    parsed.pendingReasoning = [];
  }
}

function closeSpan(span: TraceSpan, status: TraceSpanStatus): void {
  span.status = status;
  span.completedAt = new Date().toISOString();
  span.durationMs =
    new Date(span.completedAt).getTime() - new Date(span.startedAt).getTime();
}

function fireSpan(span: TraceSpan, parsed: ParsedEvents): void {
  parsed.spans.push(span);
  parsed.onSpan?.(span);
}

function truncateTail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s;
}

function truncateHead(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function serializeTruncated(value: unknown, max: number): unknown {
  try {
    const str = JSON.stringify(value);
    if (str && str.length > max) return { __truncated: true };
  } catch {
    return { __truncated: true };
  }
  return value;
}

function itemTypeToSpanType(itemType: string): TraceSpanType | null {
  switch (itemType) {
    case "reasoning": return "reasoning";
    case "command_execution": return "command_exec";
    case "file_change": return "file_write";
    case "mcp_tool_call": return "tool_call";
    case "agent_message": return "agent_message";
    case "error": return "error";
    default: return null;
  }
}

function extractReasoningText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.summary === "string") return item.summary;
  if (Array.isArray(item.content)) {
    return (item.content as Array<{ text?: string }>)
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n");
  }
  return "";
}

function buildPayload(
  spanType: TraceSpanType,
  item: Record<string, unknown>,
  existing?: TraceSpanPayload,
): TraceSpanPayload {
  switch (spanType) {
    case "reasoning": {
      const raw = extractReasoningText(item);
      const truncated = raw.length > MAX_REASONING_CHARS;
      return {
        kind: "reasoning",
        text: truncateHead(raw, MAX_REASONING_CHARS),
        truncated,
      };
    }
    case "command_exec": {
      const prev = existing?.kind === "command_exec" ? existing : null;
      const rawOutput =
        typeof item.aggregated_output === "string" ? item.aggregated_output
        : typeof item.output === "string" ? item.output
        : prev?.output ?? "";
      const outputTruncated = rawOutput.length > MAX_CMD_OUTPUT_CHARS;
      const exitCode =
        typeof item.exit_code === "number" ? item.exit_code : prev?.exitCode ?? null;
      return {
        kind: "command_exec",
        command:
          typeof item.command === "string" ? item.command : prev?.command ?? "",
        exitCode,
        output: truncateTail(rawOutput, MAX_CMD_OUTPUT_CHARS),
        outputTruncated,
      };
    }
    case "file_write": {
      const changes = Array.isArray(item.changes)
        ? (item.changes as Array<Record<string, unknown>>).map((c) => ({
            path: typeof c.path === "string" ? c.path : "",
            changeKind: (["add", "update", "delete"].includes(c.kind as string)
              ? c.kind
              : "unknown") as "add" | "update" | "delete" | "unknown",
          }))
        : [];
      return { kind: "file_write", changes };
    }
    case "tool_call": {
      return {
        kind: "tool_call",
        server: typeof item.server === "string" ? item.server : "",
        tool: typeof item.tool === "string" ? item.tool : "",
        arguments: serializeTruncated(item.arguments, MAX_TOOL_PAYLOAD_CHARS),
        result: serializeTruncated(item.result, MAX_TOOL_PAYLOAD_CHARS),
      };
    }
    case "agent_message": {
      return {
        kind: "agent_message",
        text: typeof item.text === "string" ? item.text : "",
      };
    }
    case "error": {
      const msg =
        typeof item.message === "string"
          ? item.message
          : typeof item.error === "string"
            ? item.error
            : "Unknown error";
      return { kind: "error", message: msg, fatal: true };
    }
  }
}

function itemStatus(
  item: Record<string, unknown>,
  spanType: TraceSpanType,
): TraceSpanStatus {
  if (spanType === "command_exec") {
    const exitCode = item.exit_code;
    if (typeof exitCode === "number" && exitCode !== 0) return "failed";
  }
  if (item.status === "failed") return "failed";
  return "completed";
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    parsed.onThreadId?.(event.thread_id);
  }

  if (
    event.type === "turn.completed" &&
    event.usage &&
    typeof event.usage === "object"
  ) {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
    if (parsed.spans.length < MAX_SPANS) {
      const span = makeSpan(
        parsed,
        "error",
        { kind: "error", message, fatal: true },
        null,
        "completed",
      );
      span.completedAt = span.startedAt;
      span.durationMs = 0;
      fireSpan(span, parsed);
    }
  }

  if (event.type === "turn.failed") {
    const errObj =
      event.error && typeof event.error === "object"
        ? (event.error as Record<string, unknown>)
        : null;
    const message =
      typeof errObj?.message === "string"
        ? errObj.message
        : typeof event.message === "string"
          ? event.message
          : "Turn failed";
    parsed.errors.push(message);
    if (parsed.spans.length < MAX_SPANS) {
      const span = makeSpan(
        parsed,
        "error",
        { kind: "error", message, fatal: true },
        null,
        "completed",
      );
      span.completedAt = span.startedAt;
      span.durationMs = 0;
      fireSpan(span, parsed);
    }
  }

  if (
    (event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed") &&
    event.item &&
    typeof event.item === "object"
  ) {
    const item = event.item as Record<string, unknown>;
    const itemId = typeof item.id === "string" ? item.id : null;
    const itemType = typeof item.type === "string" ? item.type : "";
    const spanType = itemTypeToSpanType(itemType);

    // Preserve existing agent_message extraction for RunnerResult
    if (
      event.type === "item.completed" &&
      itemType === "agent_message" &&
      typeof item.text === "string"
    ) {
      parsed.messages.push(item.text);
    }

    if (!spanType) return;

    if (parsed.spans.length >= MAX_SPANS) {
      if (parsed.spans.length === MAX_SPANS) {
        const capSpan = makeSpan(
          parsed,
          "error",
          {
            kind: "error",
            message: "Span cap reached (500); subsequent events not recorded",
            fatal: false,
          },
          null,
          "completed",
        );
        capSpan.completedAt = capSpan.startedAt;
        capSpan.durationMs = 0;
        parsed.spans.push(capSpan);
        parsed.onSpan?.(capSpan);
      }
      return;
    }

    if (event.type === "item.started") {
      if (itemId && parsed.openSpans.has(itemId)) return;
      const payload = buildPayload(spanType, item);
      const span = makeSpan(parsed, spanType, payload, itemId, "started");
      applyLinkage(span, parsed);
      if (itemId) parsed.openSpans.set(itemId, span);
    } else if (event.type === "item.updated") {
      const existing = itemId ? parsed.openSpans.get(itemId) : undefined;
      if (existing) {
        existing.payload = buildPayload(spanType, item, existing.payload);
      } else {
        const payload = buildPayload(spanType, item);
        const span = makeSpan(parsed, spanType, payload, itemId, "started");
        applyLinkage(span, parsed);
        if (itemId) parsed.openSpans.set(itemId, span);
      }
    } else {
      // item.completed
      const existing = itemId ? parsed.openSpans.get(itemId) : undefined;
      if (existing) {
        existing.payload = buildPayload(spanType, item, existing.payload);
        closeSpan(existing, itemStatus(item, spanType));
        if (itemId) parsed.openSpans.delete(itemId);
        fireSpan(existing, parsed);
      } else {
        const payload = buildPayload(spanType, item);
        const span = makeSpan(parsed, spanType, payload, itemId);
        applyLinkage(span, parsed);
        closeSpan(span, itemStatus(item, spanType));
        fireSpan(span, parsed);
      }
    }
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    const args = buildCodexArgs(request, this.config.codexSandboxMode);
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.agentId, active);

    const parsed = createParsedEvents({
      runId: request.runId,
      agentId: request.agentId,
      threadId: request.threadId,
      ...(request.onSpan !== undefined && { onSpan: request.onSpan }),
      ...(request.onThreadId !== undefined && { onThreadId: request.onThreadId }),
    });

    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          // Step 0: raw event dump behind env flag
          if (process.env.TRACE_RAW_DUMP === "1" && line.trim()) {
            const dir = join(process.cwd(), ".data", "raw-events");
            mkdirSync(dir, { recursive: true });
            appendFileSync(
              join(dir, `${request.agentId}-${Date.now()}.jsonl`),
              line + "\n",
            );
          }
          parseCodexEventLine(line, parsed);
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error(
          "Codex timed out after " + this.config.codexTimeoutMs + " ms",
        );
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail =
          parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
      };
    } finally {
      // Flush remaining open spans as incomplete before returning/throwing
      const finishedAt = new Date().toISOString();
      for (const [, span] of parsed.openSpans) {
        span.status = "incomplete";
        span.completedAt = finishedAt;
        span.durationMs =
          new Date(finishedAt).getTime() - new Date(span.startedAt).getTime();
        fireSpan(span, parsed);
      }
      parsed.openSpans.clear();
      // Mark terminal reasoning spans (reasoning completed but no action followed)
      for (const span of parsed.pendingReasoning) {
        if (span.status === "completed" && span.payload.kind === "reasoning") {
          span.payload.terminal = true;
        }
      }
      parsed.pendingReasoning = [];
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null)
      return;
    // Fix 2: SIGINT instead of SIGTERM — codex has a SIGINT handler for clean shutdown
    active.child.kill("SIGINT");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(
        () => active.child.kill("SIGKILL"),
        3_000,
      );
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}
