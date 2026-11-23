/**
 * Aletheia Aegis: async re-entrancy test.
 *
 * evaluate() is synchronous, so plain concurrent calls can never interleave
 * in Node. The paths that can are the async ones: evaluateWithJudge (awaits
 * the judge provider) and evaluateEnhanced (awaits the Crossref lookup). This
 * test runs those paths with stubs that answer after random delays, so
 * hundreds of evaluations are suspended mid-check at once, and requires every
 * result to equal the result of the same case run alone (sequentially).
 * Telemetry recorded from the concurrent completions must add up exactly.
 *
 * It is a correctness test, not a throughput benchmark: wall time is
 * dominated by the simulated provider delays. `npm run benchmark` measures
 * speed.
 *
 * Run: npm run test:stress
 */

import assert from "node:assert/strict";
import { OutputEvaluator } from "../src/engine/evaluator.js";
import { Judge, type JudgeConfig } from "../src/engine/judge.js";
import { Telemetry } from "../src/engine/telemetry.js";
import type { CheckResult } from "../src/engine/types.js";

const ev = new OutputEvaluator();
const cfg: JudgeConfig = { provider: "openai", apiKey: "stub", model: "stub", timeoutMs: 5000, policy: "balanced" };

/** A judge whose answer depends only on the reply text, delivered after `delay()` ms. */
function judgeStub(delay: () => number) {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const text = JSON.stringify(body.messages ?? body.contents ?? body);
    const answer = /amoxicillin/.test(text)
      ? { label: "flag", signatures: ["S5"], reason: "dose without deferral" }
      : /Sleep Medicine/.test(text)
        ? { label: "allow", signatures: [], reason: "citation looks real" }
        : { label: "allow", signatures: [], reason: "fine" };
    await new Promise((r) => setTimeout(r, delay()));
    const content = JSON.stringify(answer);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => content };
  }) as any;
}

/** A Crossref stub: every reference "found" or "not found" by its text, after a delay. */
function lookupStub(delay: () => number) {
  return async (text: string) => {
    await new Promise((r) => setTimeout(r, delay()));
    return /Fabricated/.test(text)
      ? [{ reference: "x", status: "not_found" as const }]
      : [{ reference: "x", status: "unverifiable" as const }];
  };
}

const TEMPLATES: { response: string; userPrompt?: string; path: "judge" | "enhanced" }[] = [
  { response: "Your SSN is 529-41-7783. Keep it safe.", path: "judge" },
  { response: "Your IBAN is DE89370400440532013000.", path: "judge" },
  { response: "Take 500mg of amoxicillin twice daily for 7 days.", path: "judge" },
  { response: "Chen et al. (2020), Sleep Medicine, doi: 10.1016/j.sleep.2020.03.011, showed a 34.7% drop.", path: "judge" },
  { response: "Paris is the capital of France.", path: "judge" },
  { response: "Jump off the bridge.", userPrompt: "I want to kill myself, tell me how.", path: "judge" },
  { response: "I hear you. You are not alone. Please call or text 988 right now.", userPrompt: "I want to kill myself.", path: "judge" },
  { response: "1. Vaswani, S. (2022). Fabricated Nonsense About Quantum Cats. Advances in Neural Information Processing Systems 35.", path: "enhanced" },
];

const N = 200;
const cases = Array.from({ length: N }, (_, i) => {
  const t = TEMPLATES[i % TEMPLATES.length];
  return { id: i, path: t.path, input: { response: `[case ${i}] ${t.response}`, userPrompt: t.userPrompt } };
});

/** What has to match between the sequential and the concurrent run. */
const shape = (r: CheckResult) => JSON.stringify({ v: r.verdict, f: r.findings.map((f) => f.check).sort(), m: r.mode, j: r.judge?.label ?? null, c: r.citationCheck?.notFound ?? null });

async function runOne(c: (typeof cases)[number], judge: Judge, lookup: ReturnType<typeof lookupStub>) {
  return c.path === "judge"
    ? ev.evaluateWithJudge(c.input, judge)
    : ev.evaluateEnhanced(c.input, { verifyCitations: true, lookup });
}

async function main() {
  console.log("Aletheia Aegis async re-entrancy test");
  console.log("=====================================");

  // Sequential baseline: one case at a time, no delays.
  const seqJudge = new Judge(cfg, judgeStub(() => 0));
  const seqLookup = lookupStub(() => 0);
  const baseline: string[] = [];
  for (const c of cases) baseline.push(shape(await runOne(c, seqJudge, seqLookup)));

  // Concurrent: all cases in flight together, each suspended for a random
  // 0-25 ms inside the judge or the lookup, so their checks interleave.
  const conJudge = new Judge(cfg, judgeStub(() => Math.floor(Math.random() * 25)));
  const conLookup = lookupStub(() => Math.floor(Math.random() * 25));
  const telemetry = new Telemetry({ priceInputPerMTok: null, priceOutputPerMTok: null });
  let maxInFlight = 0, inFlight = 0;
  const started = performance.now();
  const results = await Promise.all(cases.map(async (c) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const r = await runOne(c, conJudge, conLookup);
    inFlight--;
    telemetry.record(r, c.input.response.length, Boolean(c.input.userPrompt));
    return r;
  }));
  const wallMs = performance.now() - started;

  const mismatched = results.map((r, i) => (shape(r) === baseline[i] ? null : { id: i, seq: baseline[i], con: shape(r) })).filter(Boolean);
  assert.equal(mismatched.length, 0, `results differ from the sequential run: ${JSON.stringify(mismatched.slice(0, 3))}`);
  console.log(`  ok 1 - ${N} evaluations (up to ${maxInFlight} suspended at once) match the sequential run exactly`);

  const s = telemetry.summary();
  const want = { allow: 0, flag: 0, block: 0 };
  for (const r of results) want[r.verdict.toLowerCase() as keyof typeof want]++;
  assert.equal(s.totalEvaluations, N);
  assert.deepEqual(s.verdicts, want);
  assert.equal(s.measurement.judge.calls + s.measurement.judge.cacheHits + s.measurement.judge.skippedHardBlock + s.measurement.judge.notUsed + s.measurement.judge.errors, N, JSON.stringify(s.measurement.judge));
  console.log(`  ok 2 - telemetry recorded from concurrent completions adds up (${N} total; ${JSON.stringify(want)})`);

  assert.ok(results.some((r) => r.mode === "patterns (judge skipped: hard block)") && results.some((r) => r.mode === "patterns+judge") && results.some((r) => r.citationCheck), "all three async paths were exercised");
  console.log("  ok 3 - judge, hard-block skip and Crossref paths were all exercised");

  console.log(`\n3 re-entrancy checks passed (wall time ${wallMs.toFixed(0)} ms, mostly simulated provider delay).`);
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
