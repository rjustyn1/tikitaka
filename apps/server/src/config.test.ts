import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("memory configuration", () => {
  it("defaults extraction to Ark with the specified timeout", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      memoryExtractor: "ark",
      memoryExtractTimeoutMs: 30_000,
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
});
