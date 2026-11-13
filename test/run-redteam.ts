/**
 * Aletheia Aegis: red-team runner.
 *
 * Runs the guard eval over eval/redteam.jsonl — adversarial paraphrases
 * written to evade the detectors. Unlike the bundled eval set, this set is
 * EXPECTED to have misses: the scorecard is the honest number, and the
 * missed ids are the next detector fixes. Exit code is 0 even with misses;
 * this runner reports, it does not gate.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { runGuardEval, guardScorecardMarkdown } from "../src/engine/eval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "eval", "redteam.jsonl");

const score = runGuardEval(FILE);
console.log(guardScorecardMarkdown(score, "redteam"));
console.log("");
console.log(
  "Red-team reading: misses here are known evasion gaps, documented per case in eval/redteam.jsonl. " +
    "Fix a gap only when the fix does not create a false-positive risk of its own — see the notes on rt-13 and rt-14.",
);
