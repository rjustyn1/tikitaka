import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this package's own tests. Without this, vitest also picks up
    // scratch files the Codex runtime writes under `codex-home/.tmp/`, which
    // is gitignored local state and contains unrelated third-party tests.
    include: ["src/**/*.test.ts"],
  },
});
