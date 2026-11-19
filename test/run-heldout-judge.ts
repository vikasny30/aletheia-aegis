/**
 * Aletheia Aegis: held-out runner with the model judge (async).
 *
 * Scores held-out batches through evaluateWithJudge (patterns + judge) with
 * the CURRENT pattern code, policies and hard-block rule, against the
 * committed hand labels. The judge's answers are replayed from
 * eval/heldout/second-labeler/<batch>-judge-verdicts-<model>.jsonl, so the
 * default run makes no API calls and is fully reproducible.
 *
 *   npm run eval:heldout:judge                        replay batches 10 and 11
 *   npm run eval:heldout:judge -- --batches batch10   one batch
 *   npm run eval:heldout:judge -- --live              dry run: how many live calls would be needed
 *   npm run eval:heldout:judge -- --live --yes        fetch missing verdicts from the configured
 *                                                     judge (AEGIS_JUDGE_*), throttled, capped,
 *                                                     appended to the verdict file
 *
 * Options: --model <name> (verdict file suffix, default gemini-3.5-flash),
 * --throttle-ms (default 2500), --max-calls (default 250), --no-report.
 * Each batch is scored three ways from the same verdicts: patterns only,
 * balanced, strict. Batches are never pooled in the report.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { OutputEvaluator } from "../src/engine/evaluator.js";
import { loadCases, type EvalCase, type GuardScorecard } from "../src/engine/eval.js";
import { judgeConfigFromEnv, type JudgeConfig } from "../src/engine/judge.js";
import type { CheckResult } from "../src/engine/types.js";
import { ReplayJudge, readVerdicts } from "./heldout-judge.js";
import { summarize, writeEvalReport, type ScoreSummary } from "./eval-report.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..", "eval", "heldout");
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);

const batches = opt("--batches", "batch10,batch11").split(",").map((s) => s.trim()).filter(Boolean);
const model = opt("--model", "gemini-3.5-flash");
const live = args.includes("--live");
const yes = args.includes("--yes");
const throttleMs = Number(opt("--throttle-ms", "2500"));
const maxCalls = Number(opt("--max-calls", "250"));

let liveConfig: JudgeConfig | undefined;
if (live && yes) {
  const jc = judgeConfigFromEnv();
  if (!jc) { console.error("--live --yes needs a judge: set AEGIS_JUDGE_PROVIDER and its key."); process.exit(1); }
  if ("error" in jc) { console.error(`Judge not configured: ${jc.error}`); process.exit(1); }
  if (jc.model !== model) { console.error(`AEGIS_JUDGE_MODEL (${jc.model}) must match --model (${model}) so verdicts land in the right file.`); process.exit(1); }
  liveConfig = jc;
}

const ev = new OutputEvaluator();
type Policy = "patterns" | "balanced" | "strict";
const POLICIES: Policy[] = ["patterns", "balanced", "strict"];

function scorecard(file: string, cases: EvalCase[], got: CheckResult[]): GuardScorecard {
  const results = cases.map((c, i) => {
    const v = got[i].verdict;
    const correct = c.expected === "allow" ? v === "ALLOW" : c.expected === "flag" ? v !== "ALLOW" : v === "BLOCK";
    return { id: c.id, signature: c.signature, expected: c.expected, got: v, correct, checks: got[i].findings.map((f) => f.check), latencyMs: got[i].latencyMs };
  });
  const sigs = new Map<string, { total: number; caught: number; missedIds: string[] }>();
  for (const r of results) {
    const s = sigs.get(r.signature) ?? { total: 0, caught: 0, missedIds: [] };
    s.total++; if (r.correct) s.caught++; else s.missedIds.push(r.id);
    sigs.set(r.signature, s);
  }
  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    mode: "guard", generatedAt: new Date().toISOString(), casesFile: path.basename(file), totalCases: results.length,
    overallAccuracy: Math.round((results.filter((r) => r.correct).length / Math.max(1, results.length)) * 1000) / 10,
    falsePositives: results.filter((r) => r.expected === "allow" && !r.correct).length,
    falsePositiveRate: 0, misses: results.filter((r) => r.expected !== "allow" && !r.correct).length,
    perSignature: [...sigs].map(([signature, s]) => ({ signature, ...s, detectionRate: Math.round((s.caught / s.total) * 1000) / 10 })),
    latency: { avgMs: 0, p95Ms: lat[Math.min(lat.length - 1, Math.floor(0.95 * lat.length))] ?? 0, maxMs: lat[lat.length - 1] ?? 0 },
    results,
  };
}

const summaries: ScoreSummary[] = [];
let totalLive = 0;
const rows: string[] = [];
for (const batch of batches) {
  const file = path.join(DIR, `${batch}.jsonl`);
  const verdictFile = path.join(DIR, "second-labeler", `${batch}-judge-verdicts-${model}.jsonl`);
  const cases = loadCases(file);
  const recorded = readVerdicts(verdictFile);
  const base: Omit<JudgeConfig, "policy"> = liveConfig ?? { provider: "google", apiKey: "replay", model, timeoutMs: 20000 };
  const probe = new ReplayJudge({ ...base, policy: "balanced" } as JudgeConfig, cases, recorded);
  const missing = probe.missing();
  if (missing.length && !(live && yes)) {
    console.error(`${batch}: ${missing.length} case(s) have no recorded ${model} verdict (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}).`);
    console.error(live
      ? `Dry run: --live --yes would make up to ${missing.length} throttled call(s) (${throttleMs} ms apart, cap ${maxCalls}). Nothing was sent.`
      : "Replay only: re-run with --live for a dry run of the calls needed.");
    process.exit(live ? 0 : 1);
  }
  for (const policy of POLICIES) {
    const judge = new ReplayJudge({ ...base, policy: policy === "strict" ? "strict" : "balanced" } as JudgeConfig, cases, recorded,
      { live: live && yes, appendTo: verdictFile, throttleMs, maxLiveCalls: maxCalls - totalLive });
    const got: CheckResult[] = [];
    for (const c of cases) {
      const input = { response: c.response, userPrompt: c.prompt };
      got.push(policy === "patterns" ? ev.evaluate(input) : await ev.evaluateWithJudge(input, judge));
    }
    totalLive += judge.liveCalls;
    const unavailable = got.filter((r) => r.mode === "patterns (judge unavailable)").length;
    if (unavailable) { console.error(`${batch} ${policy}: ${unavailable} judge failure(s); not scoring an incomplete run.`); process.exit(1); }
    const s = summarize(`${batch} · ${policy === "patterns" ? "patterns only" : `patterns + judge (${policy})`}`, scorecard(file, cases, got), file);
    summaries.push(s);
    const skipped = got.filter((r) => r.mode === "patterns (judge skipped: hard block)").length;
    rows.push(`| ${batch} | ${policy === "patterns" ? "patterns only" : policy} | ${s.failures.caught}/${s.failures.total} | ${s.goodOutputs.wronglyFlagged}/${s.goodOutputs.total} | ${policy === "patterns" ? "—" : skipped} | ${s.failures.missedIds.join(", ") || "—"} | ${s.goodOutputs.wronglyFlaggedIds.join(", ") || "—"} | ${s.failures.underBlockedIds.join(", ") || "—"} |`);
  }
}

console.log(`Held-out with the ${model} judge (${live && yes ? `${totalLive} live call(s), rest replayed` : "replayed from recorded verdicts, no API calls"}); current pattern code and policies.\n`);
console.log("| Batch | Policy | Failures caught (FLAG or BLOCK) | Good outputs wrongly flagged | Judge skipped (hard block) | Missed | Wrongly flagged | FLAG where label says block |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
console.log("\nBatches are reported separately; batches whose errors drove fixes overstate performance (see eval/heldout/README.md).");
writeEvalReport("heldout-judge", `npm run eval:heldout:judge -- --batches ${batches.join(",")} --model ${model}`, summaries,
  `patterns + judge (${model}; ${live && yes ? `${totalLive} live call(s), rest replayed` : "replayed from committed verdicts, no API calls"})`);
