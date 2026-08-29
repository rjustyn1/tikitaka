/**
 * Shared test scaffolding.
 *
 * `PLAN.md` -> Testing Seams: "A fake runner is needed for group-runner tests.
 * One exists today only as a local class inside `agent-service.test.ts`;
 * Person 2 should extract it to a shared test helper rather than writing a
 * second one." This is that extraction.
 *
 * Kept inside `include` (not excluded like `*.test.ts`) so the helper itself is
 * typechecked by `npm run typecheck`.
 */

import { RunCancelledError } from "./errors.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

export interface FakeRunnerOptions {
  /** Defaults to `"Completed: " + prompt`, matching the original local fake. */
  outputFor?: (request: RunnerRequest) => string;
  /** Return a message to make that run fail; return `null` to let it succeed. */
  failFor?: (request: RunnerRequest) => string | null;
  /** Defaults to the incoming thread id, or `"fake-thread"` on a new thread. */
  threadIdFor?: (request: RunnerRequest) => string | null;
}

interface PendingRun {
  reject: (error: Error) => void;
}

/**
 * Records every request it receives -- including `sharedCodePath`, so A2 wiring
 * is assertable without a container -- and can be paused mid-run so lease
 * contention (A3) can be tested deterministically.
 */
export class FakeRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  private gate: { promise: Promise<void>; release: () => void } | null = null;
  private readonly pending = new Map<string, PendingRun>();

  constructor(private readonly options: FakeRunnerOptions = {}) {}

  /** Prompts seen so far, in order. Convenience for chain-ordering assertions. */
  get prompts(): string[] {
    return this.requests.map((request) => request.prompt);
  }

  /** Requests issued for one agent. */
  requestsFor(agentId: string): RunnerRequest[] {
    return this.requests.filter((request) => request.agentId === agentId);
  }

  /**
   * Block every subsequent run until the returned function is called. Lets a
   * test hold a group node in flight while it probes the solo path.
   */
  pause(): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = { promise, release };
    this.gate = gate;
    return () => {
      if (this.gate === gate) this.gate = null;
      release();
    };
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const groupRequest = request as RunnerRequest;
    this.requests.push(groupRequest);

    const gate = this.gate;
    if (gate) {
      await new Promise<void>((resolve, reject) => {
        this.pending.set(request.agentId, { reject });
        void gate.promise.then(resolve);
      });
      this.pending.delete(request.agentId);
    }

    const failure = this.options.failFor?.(groupRequest) ?? null;
    if (failure !== null) {
      throw new Error(failure);
    }

    return {
      output:
        this.options.outputFor?.(groupRequest) ?? "Completed: " + request.prompt,
      threadId:
        this.options.threadIdFor?.(groupRequest) ??
        request.threadId ??
        "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }

  async cancel(agentId: string): Promise<boolean> {
    const pending = this.pending.get(agentId);
    if (!pending) {
      return false;
    }
    this.pending.delete(agentId);
    pending.reject(new RunCancelledError());
    return true;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}
