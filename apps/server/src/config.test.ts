import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("memory configuration", () => {
  it("defaults extraction to the offline fake with the specified timeout", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      memoryExtractor: "fake",
      memoryExtractTimeoutMs: 30_000,
    });
  });

  it("accepts explicit extractor and timeout overrides", () => {
    expect(
      loadConfig({
        NODE_ENV: "test",
        MEMORY_EXTRACTOR: "ark",
        MEMORY_EXTRACT_TIMEOUT_MS: "4242",
      }),
    ).toMatchObject({
      memoryExtractor: "ark",
      memoryExtractTimeoutMs: 4_242,
    });
  });
});
