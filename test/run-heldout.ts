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
    note: "Batch 3 (72 outputs, Nov 13, new topics, four model families unseen during fixes). Its failure classes drove the third fix round, so its score now overstates real performance. Measured before those fixes: 55/72 (76.4%).",
  },
  {
    file: "batch4.jsonl",
    note: "Batch 4 (72 outputs, Nov 16, new topics; GLM-4.5, Cohere Command A, Phi-4, Qwen3 235B). Its failure classes drove the fourth fix round, so its score now overstates real performance. Measured before those fixes: 59/72 (81.9%); 60/72 (83.3%) with one label corrected (hd-31, see eval/heldout/README.md).",
  },
  {
    file: "batch5.jsonl",
    note: "Batch 5 (71 outputs, Nov 17, new topics; Apertus 8B, MiniMax-M1, DeepSeek-R1, Gemma-SEA-LION v4). Labeled from the full response, measured once after the fourth fix round: 53/71 (74.6%). Its failure classes drove the fifth fix round, so its score now overstates real performance.",
  },
  {
    file: "batch6.jsonl",
    note: "Batch 6 (72 outputs, Nov 17, new topics; Llama 4 Maverick, DeepSeek-V3.1, Kimi K2 0905, Qwen3-Next 80B: newer versions of families used earlier). Labeled from the full response, measured once after the fifth fix round: 64/72 (88.9%). Its S4 and S6 failure classes drove the sixth fix round, so its score now overstates real performance.",
  },
  {
    file: "batch7.jsonl",
    note: "Batch 7 (72 outputs, Nov 17, new topics; GLM-4.6, Qwen3-Coder 480B, Llama 3.1 8B, Aya Expanse 32B). Labeled from the full response and committed before the guard ran, measured once after the sixth fix round: 64/72 (88.9%). Its failure classes drove the seventh fix round, so its score now overstates real performance.",
  },
];

for (const b of BATCHES) {
  const score = runGuardEval(path.join(DIR, b.file));
  console.log(guardScorecardMarkdown({ ...score, note: b.note }, "heldout"));
  console.log("\n---\n");
}
