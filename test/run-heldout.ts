/**
 * Aletheia Aegis: held-out eval runner (D7).
 *
 * Runs the guard eval over eval/heldout/cases.jsonl — the set the detectors
 * were never tuned on. This is the number that means something. See
 * eval/heldout/README.md for the process and the one rule: never tune the
 * detectors on this set.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { runGuardEval, guardScorecardMarkdown } from "../src/engine/eval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "..", "eval", "heldout", "cases.jsonl");

const score = runGuardEval(FILE);
console.log(guardScorecardMarkdown(score));
