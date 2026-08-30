# Person 3 — Governed Memory And Extraction

## Mission

Make memory configuration real, extraction provenance robust, and demo versus
production behavior explicit.

## Exclusive ownership

You may edit:

- apps/server/src/config.ts
- .env.example
- apps/server/src/memory/consolidator.ts
- apps/server/src/memory/extractor-client.ts
- apps/server/src/memory/pipeline.ts
- apps/server/src/memory/safety.ts
- apps/server/src/memory/landing.ts
- apps/server/src/memory/review.ts
- apps/server/src/memory/ledger.ts
- apps/server/src/memory/task-buffer.ts
- apps/server/src/memory/flush-trigger.ts
- apps/server/src/memory/types.ts
- the matching memory tests

Do not edit:

- apps/server/src/memory/group-runner.ts
- apps/server/src/memory/group-chain.ts
- apps/server/src/memory/group-prompt.ts
- apps/server/src/agent-service.ts
- apps/server/src/store.ts
- apps/server/src/workspace.ts
- apps/server/src/index.ts
- apps/server/src/app.ts
- apps/web/**
- TODO.md or TODO_Instructions/**

## Work items from the baseline

1. Thread the configured extractor timeout. The hardcoded 30-second value in
   buildExtractorRequest() must be replaced with the validated
   MEMORY_EXTRACT_TIMEOUT_MS value from AppConfig.

2. Remove the environment-only config stub. Pass the real validated AppConfig
   into createExtractorClient() and remove the duplicate process.env source.

3. Stop asking the extractor to echo UUIDs. Use short integer indices into the
   task buffer and map them to real run/span UUIDs server-side while retaining
   exact provenance validation and fail-open behavior for malformed output.

4. Keep fake extraction safe and explicit. FakeExtractorClient remains required
   for network-free tests and the offline demo, but real/demo configuration
   must not silently look like production extraction. Reconcile this with the
   SPEC requirement that npm run check never hits the network: keep fake as the
   test default or explicit test override, and make the real runtime choice
   explicit rather than weakening the offline check guarantee. Document that
   fake output is canned and topic-blind.

## Acceptance

- Changing MEMORY_EXTRACT_TIMEOUT_MS changes the actual extractor timeout.
- There is one validated memory configuration source.
- Real-model extraction can cite provenance without copying UUIDs.
- Fake extraction remains available for deterministic tests and the offline
  demo, but cannot be mistaken for real extraction.
- Existing safety, landing, review, and ledger invariants still pass.
- Targeted memory tests pass without network access.

## Handoff

Person 1 supplies completed execution records; do not edit GroupRunner to make
the memory pipeline work. Person 4 consumes notes, grants, landed files, and
review state through the existing API DTOs.

