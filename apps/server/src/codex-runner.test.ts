import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  createParsedEvents,
  parseCodexEventLine,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        runId: "run",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        runId: "run",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = createParsedEvents({
      runId: "run-1",
      agentId: "agent-1",
      threadId: null,
    });
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("produces exactly one span when item.started + item.updated + item.completed fire for the same item", () => {
    const parsed = createParsedEvents({ runId: "r", agentId: "a", threadId: null });
    const item = { id: "cmd-1", type: "command_execution", command: "ls", exit_code: 0 };
    parseCodexEventLine(
      JSON.stringify({ type: "item.started", item }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({ type: "item.updated", item: { ...item, output: "file.txt" } }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { ...item, output: "file.txt", status: "completed" } }),
      parsed,
    );
    expect(parsed.spans).toHaveLength(1);
    expect(parsed.spans[0].type).toBe("command_exec");
    expect(parsed.spans[0].status).toBe("completed");
    if (parsed.spans[0].payload.kind === "command_exec") {
      expect(parsed.spans[0].payload.exitCode).toBe(0);
    }
  });

  it("links reasoning span to following action via parentId", () => {
    const parsed = createParsedEvents({ runId: "r", agentId: "a", threadId: null });
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "r1", type: "reasoning", text: "I should list files" },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { id: "c1", type: "command_execution", command: "ls", exit_code: 1, status: "failed" },
      }),
      parsed,
    );
    const reasoning = parsed.spans.find((s) => s.type === "reasoning");
    const action = parsed.spans.find((s) => s.type === "command_exec");
    expect(reasoning).toBeDefined();
    expect(action).toBeDefined();
    expect(action?.parentId).toBe(reasoning?.id);
    expect(action?.status).toBe("failed");
  });

  it("assigns monotonically increasing seq across spans", () => {
    const parsed = createParsedEvents({ runId: "r", agentId: "a", threadId: null });
    for (let i = 0; i < 3; i++) {
      parseCodexEventLine(
        JSON.stringify({
          type: "item.completed",
          item: { id: `cmd-${i}`, type: "command_execution", command: `cmd${i}`, exit_code: 0 },
        }),
        parsed,
      );
    }
    const seqs = parsed.spans.map((s) => s.seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  // Fixture note: run `TRACE_RAW_DUMP=1 npm run dev`, perform an agent task,
  // then commit the output from .data/raw-events/ as apps/server/src/fixtures/codex-events.jsonl
  // to ground all parser tests in a real event stream.
});

describe("A2 - shared group code (local-process)", () => {
  const base = {
    agentId: "agent",
    runId: "run",
    workspacePath: "/tmp/workspace",
    prompt: "implement the upload endpoint",
    threadId: null,
  };

  it("grants the shared code directory with --add-dir, after -C", () => {
    const args = buildCodexArgs(
      { ...base, sharedCodePath: "/tmp/workspaces/shared-code/task-1" },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "--add-dir",
      "/tmp/workspaces/shared-code/task-1",
      "implement the upload endpoint",
    ]);
  });

  it("keeps --add-dir ahead of resume so it is parsed as an exec flag", () => {
    const args = buildCodexArgs(
      {
        ...base,
        threadId: "thread-123",
        sharedCodePath: "/tmp/shared",
      },
      "workspace-write",
    );
    expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("resume"));
    expect(args.slice(-3)).toEqual([
      "resume",
      "thread-123",
      "implement the upload endpoint",
    ]);
  });

  it("leaves a solo run byte-identical to before", () => {
    expect(buildCodexArgs(base, "workspace-write")).not.toContain("--add-dir");
  });
});
