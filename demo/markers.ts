import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Timestamps for the cut. Playwright's video clock starts when the context is
 * created, a beat before the test body, so cut.mjs pads every window.
 */
let t0 = 0;
let file = "";

export function startClock(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  file = path.join(outDir, "markers.jsonl");
  writeFileSync(file, "");
  t0 = Date.now();
  mark("run-start");
}

export function mark(label: string, note?: string): void {
  const t = Date.now() - t0;
  appendFileSync(file, JSON.stringify({ t, label, ...(note ? { note } : {}) }) + "\n");
  console.log(`[marker] ${(t / 1000).toFixed(1)}s  ${label}${note ? "  " + note : ""}`);
}
