/**
 * Aletheia Aegis: Python/TypeScript classifier parity test (D8).
 *
 * The TypeScript classifier (src/engine/classifier.ts) and the Python
 * reference (test/parity/classify_incident.py) are two independent
 * implementations of the paper's Appendix C spec. This test requires:
 *   1. identical vocabularies (sorted keyword lists per signature), and
 *   2. identical scores and matched sets on every example in
 *      test/parity/examples.jsonl.
 * Either implementation can be edited freely — but they cannot drift apart
 * without this test failing.
 *
 * Run: npm run test:parity
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  INCIDENT_VOCABULARY,
  classifyIncident,
  type SignatureId,
} from "../src/engine/classifier.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(HERE, "parity", "classify_incident.py");
const EXAMPLES = path.join(HERE, "parity", "examples.jsonl");

console.log("Aletheia Aegis classifier parity test (Python vs TypeScript)");
console.log("=============================================================");

// 1. Vocabularies must be identical.
const pyVocab = JSON.parse(
  execFileSync("python3", [PY, "--vocabulary"], { encoding: "utf-8" }),
) as Record<SignatureId, string[]>;
for (const sig of Object.keys(INCIDENT_VOCABULARY) as SignatureId[]) {
  const ts = [...INCIDENT_VOCABULARY[sig]].sort();
  const py = [...(pyVocab[sig] ?? [])].sort();
  assert.deepEqual(py, ts, `vocabulary mismatch for ${sig}`);
}
console.log("  ok 1 - vocabularies identical across all 9 signatures");

// 2. Classifications must agree on every example.
const examples = fs
  .readFileSync(EXAMPLES, "utf-8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as { id: string; text: string });
const pyOut = execFileSync("python3", [PY, "--classify", EXAMPLES], {
  encoding: "utf-8",
})
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as { id: string; scores: Record<string, number>; matched: string[] });
assert.equal(pyOut.length, examples.length, "example count mismatch");

for (const example of examples) {
  const ts = classifyIncident(example.text);
  const py = pyOut.find((r) => r.id === example.id);
  assert.ok(py, `missing Python result for ${example.id}`);
  assert.deepEqual(py.scores, ts.scores, `score mismatch for ${example.id}`);
  assert.deepEqual(py.matched, ts.matched, `matched mismatch for ${example.id}`);
}
console.log(`  ok 2 - identical scores and matched sets on ${examples.length} examples`);

console.log("\nParity test passed.");
