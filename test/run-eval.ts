/**
 * Aletheia Aegis: Eval runner (CLI).
 *
 * Prints the guard eval scorecard, then the corpus-classification scorecard.
 * Run: npm run eval
 */

import path from "node:path";
import {
  corpusScorecardMarkdown,
  evalDir,
  guardScorecardMarkdown,
  runCorpusEval,
  runGuardEval,
} from "../src/engine/eval.js";
import { summarize, writeEvalReport } from "./eval-report.js";

const guard = runGuardEval();
console.log(guardScorecardMarkdown(guard));
console.log("\n---\n");
console.log(corpusScorecardMarkdown(runCorpusEval()));
writeEvalReport("eval", "npm run eval", [summarize("bundled eval set", guard, path.join(evalDir(), "cases.jsonl"))]);
