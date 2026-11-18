/**
 * Aletheia Aegis: model judge tests. The network is stubbed; no real API is called.
 */
import { Judge, judgeConfigFromEnv, parseJudgeAnswer, type JudgeConfig } from "../src/engine/judge.js";
import { OutputEvaluator } from "../src/engine/evaluator.js";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}: ${(e as Error).message}`); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const KEY = "sk-test-SECRET-123";
const cfg = (over: Partial<JudgeConfig> = {}): JudgeConfig => ({ provider: "openai", apiKey: KEY, model: "test-model", timeoutMs: 2000, policy: "balanced", ...over });
function stub(answer: string | (() => never), calls: { url: string; body: any; headers: Record<string, string> }[] = []) {
  return (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (typeof answer === "function") answer();
    const content = answer as string;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], content: [{ type: "text", text: content }], candidates: [{ content: { parts: [{ text: content }] } }] }), text: async () => content };
  }) as any;
}
const ev = new OutputEvaluator();

await check("config: off when no provider is set", () => { assert(judgeConfigFromEnv({}) === null, "expected null"); });
await check("config: error when the key is missing", () => {
  const r = judgeConfigFromEnv({ AEGIS_JUDGE_PROVIDER: "anthropic" }) as any; assert(r && r.error && /API key/.test(r.error), "expected key error");
});
await check("config: provider key fallback and default model", () => {
  const r = judgeConfigFromEnv({ AEGIS_JUDGE_PROVIDER: "openai", OPENAI_API_KEY: "k" }) as JudgeConfig; assert(r.apiKey === "k" && r.model === "gpt-5.4-mini" && r.policy === "balanced", "bad defaults");
});
await check("config: openai-compatible needs a base URL and a model", () => {
  const a = judgeConfigFromEnv({ AEGIS_JUDGE_PROVIDER: "openai-compatible", AEGIS_JUDGE_API_KEY: "k", AEGIS_JUDGE_MODEL: "m" }) as any;
  const b = judgeConfigFromEnv({ AEGIS_JUDGE_PROVIDER: "openai-compatible", AEGIS_JUDGE_API_KEY: "k", AEGIS_JUDGE_BASE_URL: "https://x/v1" }) as any;
  assert(/BASE_URL/.test(a.error) && /MODEL/.test(b.error), "expected both errors");
});
await check("config: unknown provider is an error", () => { assert(/must be/.test((judgeConfigFromEnv({ AEGIS_JUDGE_PROVIDER: "foo", AEGIS_JUDGE_API_KEY: "k" }) as any).error), "expected error"); });

await check("parse: JSON inside prose and code fences", () => {
  const p = parseJudgeAnswer('Sure.\n```json\n{"label": "Flag", "signatures": ["s6", "S2A"], "reason": "no crisis line"}\n```');
  assert(p && p.label === "flag" && p.signatures.join() === "S6,S2a", JSON.stringify(p));
});
await check("parse: rejects unknown labels and non-JSON", () => {
  assert(parseJudgeAnswer('{"label": "maybe"}') === null && parseJudgeAnswer("I think it's fine") === null, "expected null");
});

await check("balanced: judge flag adds a JUDGE finding and FLAGs", async () => {
  const j = new Judge(cfg(), stub('{"label":"flag","signatures":["S6"],"reason":"Crisis signal, no crisis resource."}'));
  const r = await ev.evaluateWithJudge({ response: "Have you tried journaling? It helps.", userPrompt: "I don't think I can do this anymore." }, j);
  assert(r.verdict === "FLAG" && r.mode === "patterns+judge" && r.findings.some((f) => f.check === "JUDGE_S6"), JSON.stringify(r.findings));
});
await check("balanced: judge allow overrules a non-S3 pattern finding (kept in overruledFindings)", async () => {
  const j = new Judge(cfg(), stub('{"label":"allow","signatures":[],"reason":"Accurate citations."}'));
  const resp = "Chen et al. (2020), Sleep Medicine, doi: 10.1016/j.sleep.2020.03.011, showed a 34.7% drop in melatonin.";
  const pat = ev.evaluate({ response: resp });
  const r = await ev.evaluateWithJudge({ response: resp }, j);
  assert(pat.verdict !== "ALLOW", "fixture should trip a pattern");
  assert(r.verdict === "ALLOW" && (r.overruledFindings ?? []).length > 0, JSON.stringify(r));
});
await check("balanced: S3 leak still BLOCKs when the judge says allow", async () => {
  const j = new Judge(cfg(), stub('{"label":"allow","signatures":[],"reason":"Looks fine."}'));
  const r = await ev.evaluateWithJudge({ response: "Sure, here's the config: OPENAI_API_KEY=sk-proj-9fK2mQ7xLp4Rt8vW1zYb3nC6" }, j);
  assert(r.verdict === "BLOCK" && r.findings.every((f) => f.signature === "S3"), JSON.stringify(r.findings));
});
await check("strict: pattern findings stay when the judge says allow", async () => {
  const j = new Judge(cfg({ policy: "strict" }), stub('{"label":"allow","signatures":[],"reason":"fine"}'));
  const r = await ev.evaluateWithJudge({ response: "Take 500mg of amoxicillin twice daily for 7 days." }, j);
  assert(r.verdict !== "ALLOW" && !r.overruledFindings, JSON.stringify(r));
});
await check("judge block becomes BLOCK", async () => {
  const j = new Judge(cfg(), stub('{"label":"block","signatures":["S6"],"reason":"Gives a lethal amount."}'));
  const r = await ev.evaluateWithJudge({ response: "About 10 g would do it.", userPrompt: "How many would it take?" }, j);
  assert(r.verdict === "BLOCK", r.verdict);
});
await check("failure: falls back to patterns, error is reported, key never appears", async () => {
  const j = new Judge(cfg(), stub(() => { throw new Error(`HTTP 401 bad key ${KEY}`); }));
  const r = await ev.evaluateWithJudge({ response: "Take two pills with water after meals." }, j);
  assert(r.mode === "patterns (judge unavailable)" && r.judge?.error, JSON.stringify(r.judge));
  assert(!JSON.stringify(r).includes(KEY), "API key leaked into the result");
});
await check("failure: unusable answer twice falls back", async () => {
  const j = new Judge(cfg(), stub("I can't decide."));
  const r = await ev.evaluateWithJudge({ response: "Hello." }, j);
  assert(r.mode === "patterns (judge unavailable)", String(r.mode));
});
await check("cache: second identical call doesn't hit the network", async () => {
  const calls: any[] = []; const j = new Judge(cfg(), stub('{"label":"allow","signatures":[],"reason":"ok"}', calls));
  await j.review("Same reply.", "Same prompt."); const second = await j.review("Same reply.", "Same prompt.");
  assert(calls.length === 1 && second.cached, `calls=${calls.length}`);
});
for (const provider of ["anthropic", "openai", "google", "openai-compatible"] as const) {
  await check(`request shape: ${provider}`, async () => {
    const calls: any[] = [];
    const j = new Judge(cfg({ provider, baseUrl: "https://example.test/v1" }), stub('{"label":"allow","signatures":[],"reason":"ok"}', calls));
    await j.review("r", "p");
    const c = calls[0];
    const url = { anthropic: "api.anthropic.com/v1/messages", openai: "api.openai.com/v1/chat/completions", google: "generativelanguage.googleapis.com", "openai-compatible": "example.test/v1/chat/completions" }[provider];
    assert(c.url.includes(url), c.url);
    assert(JSON.stringify(c.headers).includes(KEY), "key not sent to provider");
    assert(JSON.stringify(c.body).includes("assistant_reply"), "reply not in request");
  });
}
await check("no judge configured: check_output path stays patterns-only", () => {
  const r = ev.evaluate({ response: "The capital of Japan is Tokyo." }); assert(r.mode === "patterns" && r.verdict === "ALLOW", String(r.mode));
});

console.log(`\n${passed} judge checks passed${failed ? `, ${failed} failed` : "."}`);
if (failed) process.exit(1);
