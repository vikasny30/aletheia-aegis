/**
 * Aletheia Aegis: Eval runner (CLI).
 *
 * Prints the guard eval scorecard, then the corpus-classification scorecard.
 * Run: npm run eval
 */

import {
  corpusScorecardMarkdown,
  guardScorecardMarkdown,
  runCorpusEval,
  runGuardEval,
} from "../src/engine/eval.js";

console.log(guardScorecardMarkdown(runGuardEval()));
console.log("\n---\n");
console.log(corpusScorecardMarkdown(runCorpusEval()));
