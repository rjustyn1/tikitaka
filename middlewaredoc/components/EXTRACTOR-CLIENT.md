# Extractor Client Technical Design

## Component

`apps/server/src/memory/extractor-client.ts`

## Purpose

Provide the model call used by `consolidator.ts` behind a small interface.

This keeps tests offline and lets the demo use canned output if Ark or network
access is unavailable.

## Interface

```ts
interface ExtractorClient {
  extract(input: ExtractorRequest): Promise<ExtractorResponse>;
}

interface ExtractorRequest {
  system: string;
  prompt: string;
  timeoutMs: number;
}

interface ExtractorResponse {
  rawText: string;
}
```

## Code-Level Spec

Factory:

```ts
export function createExtractorClient(config: AppConfig): ExtractorClient {
  if (config.memoryExtractor === "off") return new OffExtractorClient();
  if (config.memoryExtractor === "fake") return new FakeExtractorClient();
  return new ArkExtractorClient(config);
}
```

Ark request shape:

```ts
const response = await fetch(`${config.arkBaseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${config.arkApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: config.arkModel,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.prompt },
    ],
    temperature: 0,
  }),
  signal,
});
```

Return only the raw assistant text:

```ts
return { rawText: data.choices?.[0]?.message?.content ?? "" };
```

Never log `ARK_API_KEY`, request headers, or full prompt bodies at info level.

## Implementations

```text
ArkExtractorClient:
  calls the configured Ark model

FakeExtractorClient:
  returns canned JSON for tests and demo fixtures

OffExtractorClient:
  returns an empty note list when MEMORY_EXTRACTOR=off
```

## Configuration

- `MEMORY_EXTRACTOR=ark|fake|off`
- `MEMORY_EXTRACT_TIMEOUT_MS`
- existing `ARK_API_KEY`
- existing `ARK_MODEL`
- existing `ARK_BASE_URL`

## Failure Behavior

Timeouts, network errors, and non-2xx responses should throw a typed extractor
error. `consolidator.ts` catches that and returns zero candidate notes.

## Tests

- fake client returns deterministic JSON;
- off client returns empty notes;
- Ark client builds the expected request shape without logging secrets;
- timeout is passed through and respected.
