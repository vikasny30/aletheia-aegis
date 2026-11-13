/**
 * Aletheia Aegis: held-out eval runner (D7).
 *
 * Runs the guard over each held-out batch in eval/heldout/: real model outputs,
 * labeled before the guard was run on them. See eval/heldout/README.md.
 *
 * Batches are reported separately on purpose. Once a batch has been used to
 * find failure classes, fixes inspired by it make its later scores optimistic.
 * The newest batch measured before any fix it inspired is the honest number.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { runGuardEval, guardScorecardMarkdown } from "../src/engine/eval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..", "eval", "heldout");

const BATCHES = [
  {
    file: "batch1.jsonl",
    note: "Batch 1 (72 outputs, Nov 12). Its failure classes drove the v0.1.2 detector fixes, so its score now overstates real performance. Measured before those fixes: 56/72 (77.8%).",
  },
  {
    file: "batch2.jsonl",
    note: "Batch 2 (72 outputs, Nov 13). Its failure classes drove the second fix round, so its score now overstates real performance. Measured before those fixes: 52/72 (72.2%).",
  },
  {
    file: "batch3.jsonl",
    note: "Batch 3 (72 outputs, Nov 13, new topics, four model families unseen during fixes). Measured once after the second fix round. This is the current honest number.",
  },
];

for (const b of BATCHES) {
  const score = runGuardEval(path.join(DIR, b.file));
  console.log(guardScorecardMarkdown({ ...score, note: b.note }, "heldout"));
  console.log("\n---\n");
}
