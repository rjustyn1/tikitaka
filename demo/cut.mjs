#!/usr/bin/env node
/**
 * Turn the raw recording into the short cut.
 *
 *   node demo/cut.mjs            # newest .webm under demo/out/artifacts
 *   node demo/cut.mjs some.webm
 *
 * Keeps a window around every marker and drops the waiting in between, so a
 * 20-minute run becomes ~90 seconds. Needs ffmpeg on PATH.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const PRE = Number(process.env.CUT_PRE ?? 2.5);   // seconds kept before a marker
const POST = Number(process.env.CUT_POST ?? 6);   // seconds kept after

/**
 * winget installs ffmpeg outside PATH until the shell is restarted, so fall
 * back to its package directory rather than failing on a tool that is present.
 */
function findFfmpeg() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return "ffmpeg";
  } catch {}
  const root = path.join(
    process.env.LOCALAPPDATA ?? "",
    "Microsoft/WinGet/Packages",
  );
  if (!existsSync(root)) return "ffmpeg";
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "ffmpeg.exe") return full;
    }
  }
  return "ffmpeg";
}

function newestVideo(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".webm")) found.push(full);
    }
  };
  try { walk(dir); } catch { return null; }
  if (!found.length) return null;
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const source = process.argv[2] ?? newestVideo(path.join(out, "artifacts"));
if (!source) {
  console.error("No .webm found. Run the recorder first.");
  process.exit(1);
}

const markers = readFileSync(path.join(out, "markers.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line));
if (!markers.length) {
  console.error("markers.jsonl is empty.");
  process.exit(1);
}

// Merge overlapping windows so the cut never repeats a frame.
const windows = [];
for (const { t } of markers) {
  const start = Math.max(0, t / 1000 - PRE);
  const end = t / 1000 + POST;
  const last = windows.at(-1);
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else windows.push([start, end]);
}

const kept = windows.reduce((sum, [a, b]) => sum + (b - a), 0);
console.log(`${markers.length} markers -> ${windows.length} windows, ~${kept.toFixed(0)}s kept`);

const select = windows.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join("+");
const target = path.join(out, "demo-cut.mp4");

execFileSync(findFfmpeg(), [
  "-y", "-i", source,
  "-vf", `select='${select}',setpts=N/FRAME_RATE/TB`,
  "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
  "-pix_fmt", "yuv420p", target,
], { stdio: "inherit" });

console.log(`\nWrote ${target}`);
