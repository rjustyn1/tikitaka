import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArkExtractorClient,
  ExtractorError,
  FakeExtractorClient,
  OffExtractorClient,
  createExtractorClient,
  memoryConfigFromEnv,
  type MemoryConfig,
} from "./extractor-client.js";

const arkConfig: MemoryConfig = {
  memoryExtractor: "ark",
  memoryExtractTimeoutMs: 5_000,
  arkApiKey: "secret-ark-key-value",
  arkModel: "ep-test",
  arkBaseUrl: "https://ark.example.com/api/v3",
};

// A prompt shaped like the consolidator's, so the fake can find identifiers.
const FIXTURE_PROMPT = [
  "## Agents you may target",
  "- 11111111-1111-4111-8111-111111111111  (backend)",
  "- 22222222-2222-4222-8222-222222222222  (frontend)",
  "",
  "## Node outputs",
  "- node n1: run 33333333-3333-4333-8333-333333333333; spans 44444444-4444-4444-8444-444444444444",
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createExtractorClient", () => {
  it("selects the backend by config", () => {
    expect(
      createExtractorClient({ ...arkConfig, memoryExtractor: "off" }),
    ).toBeInstanceOf(OffExtractorClient);
    expect(
      createExtractorClient({ ...arkConfig, memoryExtractor: "fake" }),
    ).toBeInstanceOf(FakeExtractorClient);
    expect(createExtractorClient(arkConfig)).toBeInstanceOf(ArkExtractorClient);
  });
});

describe("memoryConfigFromEnv", () => {
  it("defaults to the fake extractor so tests never hit the network", () => {
    expect(memoryConfigFromEnv({}).memoryExtractor).toBe("fake");
  });

  it("honours an explicit extractor choice", () => {
    expect(
      memoryConfigFromEnv({ MEMORY_EXTRACTOR: "off" }).memoryExtractor,
    ).toBe("off");
  });
});

describe("OffExtractorClient", () => {
  it("returns an empty note list", async () => {
    const result = await new OffExtractorClient().extract({
      system: "s",
      prompt: "p",
      timeoutMs: 1000,
    });
    expect(JSON.parse(result.rawText)).toEqual({ notes: [] });
  });
});

describe("FakeExtractorClient", () => {
  it("returns deterministic notes wired to real ids from the prompt", async () => {
    const result = await new FakeExtractorClient().extract({
      system: "s",
      prompt: FIXTURE_PROMPT,
      timeoutMs: 1000,
    });
    const parsed = JSON.parse(result.rawText);
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.notes[0].targetAgentIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(parsed.notes[0].sourceRunIds).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(parsed.notes[0].sourceSpanIds).toEqual([
      "44444444-4444-4444-8444-444444444444",
    ]);
    // Deterministic: same input, same output.
    const again = await new FakeExtractorClient().extract({
      system: "s",
      prompt: FIXTURE_PROMPT,
      timeoutMs: 1000,
    });
    expect(again.rawText).toBe(result.rawText);
  });

  it("returns zero notes when no identifiers are present", async () => {
    const result = await new FakeExtractorClient().extract({
      system: "s",
      prompt: "no ids here",
      timeoutMs: 1000,
    });
    expect(JSON.parse(result.rawText).notes).toEqual([]);
  });
});

describe("ArkExtractorClient", () => {
  it("builds the expected request shape and never logs the api key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"notes":[]}' } }] }),
          { status: 200 },
        ),
      );

    const client = new ArkExtractorClient(arkConfig);
    const result = await client.extract({
      system: "system prompt",
      prompt: "user prompt",
      timeoutMs: 5_000,
    });

    expect(result.rawText).toBe('{"notes":[]}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ark.example.com/api/v3/chat/completions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-ark-key-value");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("ep-test");
    expect(body.temperature).toBe(0);
    expect(body.messages).toHaveLength(2);

    // The key must never have been written to a log line.
    for (const call of logSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("secret-ark-key-value");
    }
  });

  it("throws a typed ExtractorError on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    await expect(
      new ArkExtractorClient(arkConfig).extract({
        system: "s",
        prompt: "p",
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(ExtractorError);
  });

  it("aborts and throws when the request exceeds the timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit).signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      new ArkExtractorClient(arkConfig).extract({
        system: "s",
        prompt: "p",
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(ExtractorError);
  });
});
