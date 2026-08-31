#!/usr/bin/env node
// Calibrate the node-level drift threshold from real runs.
//
//   1) capture a run's logs:   <launch server> 2>&1 | tee run.log
//   2) analyse:                node scripts/node-drift-stats.mjs run.log
//
// It reads the "[node-drift] {...}" lines the runner emits and prints the drift
// distribution + the largest GAP between consecutive scores — a natural
// threshold sits in that gap. Bias HIGH (toward the top of the gap): a false
// split fragments memory, which is worse than missing a subtle shift (the same
// false-positive-priority policy as the 0.72 recognizer threshold).
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/node-drift-stats.mjs <run.log>");
  process.exit(1);
}

const rows = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  const i = line.indexOf("[node-drift] ");
  if (i === -1) continue;
  try {
    rows.push(JSON.parse(line.slice(i + "[node-drift] ".length)));
  } catch {
    /* ignore malformed */
  }
}

const scored = rows.filter((r) => r.priorCompleted > 0); // first node of a task has no prior
if (scored.length === 0) {
  console.log("No comparable node-drift rows (need ≥2 completed nodes per task).");
  process.exit(0);
}

console.log(`\n${scored.length} node comparisons (drift ascending):`);
const sorted = [...scored].sort((a, b) => a.cosineDrift - b.cosineDrift);
for (const r of sorted) {
  console.log(
    `  ${r.cosineDrift.toFixed(4)}  role=${(r.role || "?").padEnd(16)} prior=${r.priorCompleted}`,
  );
}

// Largest gap between consecutive scores → the threshold candidate.
let gap = { size: -1, lo: 0, hi: 0 };
for (let i = 1; i < sorted.length; i++) {
  const size = sorted[i].cosineDrift - sorted[i - 1].cosineDrift;
  if (size > gap.size) gap = { size, lo: sorted[i - 1].cosineDrift, hi: sorted[i].cosineDrift };
}
const suggestion = (gap.lo + (gap.hi - gap.lo) * 0.66).toFixed(3); // biased high

console.log(
  `\nlargest gap: ${gap.lo.toFixed(4)} … ${gap.hi.toFixed(4)}  (width ${gap.size.toFixed(4)})`,
);
console.log(`suggested threshold (biased high, inside the gap): ~${suggestion}`);
console.log(
  "\nIf there is NO clear gap, node drift is not separating same-subject from\n" +
    "shifted work on your data — a signal to reconsider before building the\n" +
    "partial-flush machinery.\n",
);
