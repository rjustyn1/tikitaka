#!/usr/bin/env node
// Cheap, ARK-free probe: embed realistic node EXPLANATIONS through the actual
// SBERT model and print cosine drift, to see if it separates same-subject
// facets (should be LOW) from different subjects (should be HIGH) BEFORE
// spending tokens on a real run.
//
//   MEMORY_SBERT_PYTHON=.venv-recognition/bin/python node scripts/probe-drift.mjs
import { spawnSync } from "node:child_process";

const PY = process.env.MEMORY_SBERT_PYTHON || ".venv-recognition/bin/python";
const MODEL = "data/recognition/model";
const BRIDGE = "scripts/embed-recognizer.py";

// One coherent feature (upload) split across roles — the "keep together" case.
const coherent = {
  backend:
    "Implemented the POST /upload endpoint. It accepts a JSON body with a filename, stores the record in an in-memory map keyed by a generated id, and returns the id and a url. Filenames containing '..' or '/' are rejected.",
  frontend:
    "Built the upload UI: a small HTML page with a filename text input and a submit button that POSTs the filename to /upload and shows the returned url.",
  security:
    "Reviewed the upload endpoint. Confirmed filenames are validated against path traversal ('..' and '/'), and that storage credentials are never returned to the browser.",
};
// Three unrelated subjects in one task — the "should split" case.
const mixed = {
  slug:
    "Wrote slugify(text): lowercases the string and replaces runs of non-alphanumeric characters with single hyphens, trimming leading and trailing hyphens.",
  dateparser:
    "Implemented a JSON date parser that reads ISO-8601 timestamps and returns Date objects, handling timezone offsets and milliseconds.",
  cipher:
    "Added a Caesar cipher that shifts each alphabetic character by a configurable key, wrapping around the alphabet and preserving case and non-letters.",
};

const labels = [
  ...Object.entries(coherent).map(([k, v]) => ["coherent", k, v]),
  ...Object.entries(mixed).map(([k, v]) => ["mixed", k, v]),
];
const texts = labels.map((l) => l[2]);

const res = spawnSync(PY, [BRIDGE, "--model-path", MODEL], {
  input: JSON.stringify({ texts }),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (res.status !== 0) {
  console.error("bridge failed:\n" + (res.stderr || res.error?.message || "?"));
  process.exit(1);
}
const emb = JSON.parse(res.stdout).embeddings;

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};
const mean = (vs) => {
  const o = new Array(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < o.length; i++) o[i] += v[i] / vs.length;
  return o;
};
const idxOf = (grp) => labels.map((l, i) => (l[0] === grp ? i : -1)).filter((i) => i >= 0);

// Mimic the runtime: each node vs the mean of the buffer built so far.
function groupDrift(idxs) {
  const buf = [];
  const rows = [];
  for (const i of idxs) {
    const drift = buf.length ? 1 - cos(emb[i], mean(buf)) : null;
    rows.push([labels[i][1], drift]);
    buf.push(emb[i]);
  }
  return rows;
}

const coh = idxOf("coherent");
const mix = idxOf("mixed");

console.log("\nCOHERENT (one upload feature) — expect LOW drift:");
for (const [n, d] of groupDrift(coh))
  console.log("  " + n.padEnd(11) + (d === null ? "(first node)" : "drift=" + d.toFixed(4)));

console.log("\nMIXED (3 unrelated subjects) — expect HIGH drift:");
for (const [n, d] of groupDrift(mix))
  console.log("  " + n.padEnd(11) + (d === null ? "(first node)" : "drift=" + d.toFixed(4)));

const cohMean = mean(coh.map((i) => emb[i]));
console.log("\nCROSS (each mixed node vs the upload centroid) — sanity, expect HIGH:");
for (const i of mix)
  console.log("  " + labels[i][1].padEnd(11) + "drift=" + (1 - cos(emb[i], cohMean)).toFixed(4));
console.log("");
