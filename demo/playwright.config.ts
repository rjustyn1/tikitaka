import { defineConfig } from "@playwright/test";

/** Demo recorder. Not part of the app's test suite — lives outside apps/*. */
export default defineConfig({
  testDir: ".",
  outputDir: "out/artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 50 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    video: { mode: "on", size: { width: 1280, height: 800 } },
    trace: "off",
    actionTimeout: 30_000,
  },
});
