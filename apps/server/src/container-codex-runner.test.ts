import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        runId: "run-1",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    // config.ts resolves CODEX_HOME, which is platform-dependent (on Windows
    // "/tmp/codex-home" resolves to "C:\tmp\codex-home"). Assert against the
    // resolved value so the mount is still verified on every platform.
    expect(args).toContain(
      "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        runId: "run-2",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});

describe("A2 - shared group code (container)", () => {
  const containerConfig = () =>
    loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });

  const base = {
    agentId: "agent",
    runId: "run-3",
    workspacePath: "/tmp/agent-workspace",
    prompt: "implement the upload endpoint",
    threadId: null,
  };

  it("bind-mounts shared code at /workspace/code, nested inside the workspace mount", () => {
    const args = buildContainerRunArgs(
      { ...base, sharedCodePath: "/tmp/workspaces/shared-code/task-1" },
      containerConfig(),
    );
    expect(args).toContain(
      "type=bind,src=/tmp/workspaces/shared-code/task-1,dst=/workspace/code",
    );
    // Ordering matters: Docker must create the nested mount point after the
    // parent workspace mount exists.
    expect(
      args.indexOf("type=bind,src=/tmp/agent-workspace,dst=/workspace"),
    ).toBeLessThan(
      args.indexOf(
        "type=bind,src=/tmp/workspaces/shared-code/task-1,dst=/workspace/code",
      ),
    );
  });

  it("does not pass --add-dir: /workspace/code is already inside the cwd", () => {
    const args = buildContainerRunArgs(
      { ...base, sharedCodePath: "/tmp/workspaces/shared-code/task-1" },
      containerConfig(),
    );
    expect(args).not.toContain("--add-dir");
  });

  it("mounts nothing extra for a solo run", () => {
    const args = buildContainerRunArgs(base, containerConfig());
    expect(args.filter((arg) => arg === "--mount")).toHaveLength(2);
    expect(args.some((arg) => arg.includes("/workspace/code"))).toBe(false);
  });
});
