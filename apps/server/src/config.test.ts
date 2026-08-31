import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("memory configuration", () => {
  it("anchors local storage defaults at the repository root", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      dataDirectory: path.join(root, ".data"),
      workspaceRoot: path.join(root, "workspaces"),
      codexHome: path.join(root, "codex-home"),
    });
  });

  it("defaults extraction to Ark and recognition to the local checkpoint", () => {
    // Both default to the real thing. The extractor degrades to fake when
    // ARK_* is unusable; SBERT is required and fails startup if unprovisioned.
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      memoryExtractor: "ark",
      memoryExtractTimeoutMs: 30_000,
      memoryRecognizer: "sbert",
      memoryRecognitionAgentThreshold: 0.35,
      memoryRecognitionSkillThreshold: 0.45,
      memoryEmbeddingTimeoutMs: 30_000,
      memoryAutoGrantEnabled: false,
      memoryEnabled: true,
    });
  });

  it("accepts explicit offline extractor and timeout overrides", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        MEMORY_EXTRACTOR: "fake",
        MEMORY_EXTRACT_TIMEOUT_MS: "4242",
      }),
    ).toMatchObject({
      memoryExtractor: "fake",
      memoryExtractTimeoutMs: 4_242,
    });
  });

  it("parses MEMORY_ENABLED as the governed-memory master switch", () => {
    expect(loadConfig({ NODE_ENV: "test", MEMORY_ENABLED: "false" })).toMatchObject({
      memoryEnabled: false,
    });
  });

  it("accepts the local SBERT embedding bridge configuration", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        MEMORY_RECOGNIZER: "sbert",
        MEMORY_SBERT_PYTHON: "/tmp/recognition-python",
        MEMORY_SBERT_MODEL_DIR: "/tmp/recognition-model",
        MEMORY_SBERT_BRIDGE: "/tmp/embed-recognizer.py",
        MEMORY_AUTO_GRANT_ENABLED: "true",
      }),
    ).toMatchObject({
      memoryRecognizer: "sbert",
      memorySbertPython: "/tmp/recognition-python",
      memorySbertModelDir: "/tmp/recognition-model",
      memorySbertBridge: "/tmp/embed-recognizer.py",
      memoryAutoGrantEnabled: true,
    });
  });
});
