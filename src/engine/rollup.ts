/**
 * Aletheia Aegis: roll-up over the metrics history (AEGIS_METRICS_LOG).
 *
 * Reads the content-free JSONL the server appends (one line per check) and
 * summarizes it per day or per ISO week (UTC): replies, verdicts, signatures,
 * judge usage and tokens, overrides, Crossref outcomes and latency. Run it on
 * a schedule from the host (cron, CI); the server runs no scheduler.
 *
 * Observed counts only: like runtime telemetry, the history has no labels,
 * so catch and false-positive rates are not computed here.
 * The file is read as data: unknown fields are ignored, malformed lines are
 * counted and skipped, and nothing from a line is echoed except known
 * counters and check/signature ids that match the expected shape.
 */

import fs from "node:fs";
import readline from "node:readline";

export type RollupPeriod = "day" | "week";

export interface RollupBucket {
  period: string;
  replies: number;
  verdicts: { allow: number; flag: number; block: number };
  bySignature: Record<string, number>;
  judge: { called: number; cacheHits: number; skippedHardBlock: number; errors: number; notUsed: number; tokens: { input: number; output: number }; estimatedCostUsd: number | null };
  overrides: { replies: number; cleared: number; bySignature: Record<string, number> };
  crossref: { checks: number; references: number; found: number; notFound: number; s1Lifted: number };
  latencyMs: { totalP50: number; totalP95: number; judgeP50: number; judgeP95: number };
}

export interface Rollup {
  period: RollupPeriod;
  since?: string;
  linesRead: number;
  linesSkipped: number;
  buckets: RollupBucket[];
  costBasis: string;
  note: string;
}

const SIG_RE = /^S(?:[1-8]|2a)$/;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 1000) / 1000;
}

export function periodKey(ts: number, period: RollupPeriod): string {
  const d = new Date(ts);
  if (period === "day") return d.toISOString().slice(0, 10);
  // ISO week start (Monday, UTC).
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return `week of ${monday.toISOString().slice(0, 10)}`;
}

interface Acc { b: RollupBucket; total: number[]; judge: number[] }

function newAcc(period: string): Acc {
  return {
    b: {
      period, replies: 0, verdicts: { allow: 0, flag: 0, block: 0 }, bySignature: {},
      judge: { called: 0, cacheHits: 0, skippedHardBlock: 0, errors: 0, notUsed: 0, tokens: { input: 0, output: 0 }, estimatedCostUsd: null },
      overrides: { replies: 0, cleared: 0, bySignature: {} },
      crossref: { checks: 0, references: 0, found: 0, notFound: 0, s1Lifted: 0 },
      latencyMs: { totalP50: 0, totalP95: 0, judgeP50: 0, judgeP95: 0 },
    },
    total: [], judge: [],
  };
}

export async function rollupHistory(
  file: string,
  opts: { period?: RollupPeriod; since?: string; priceInputPerMTok?: number | null; priceOutputPerMTok?: number | null } = {},
): Promise<Rollup> {
  const period = opts.period ?? "day";
  const sinceTs = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) : NaN;
  if (opts.since && Number.isNaN(sinceTs)) throw new Error("--since must be a date like 2026-11-01");
  const accs = new Map<string, Acc>();
  let linesRead = 0, linesSkipped = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    linesRead++;
    let l: any;
    try { l = JSON.parse(raw); } catch { linesSkipped++; continue; }
    const verdict = typeof l?.verdict === "string" ? l.verdict.toLowerCase() : "";
    if (!l || typeof l !== "object" || typeof l.ts !== "number" || !["allow", "flag", "block"].includes(verdict)) { linesSkipped++; continue; }
    if (!Number.isNaN(sinceTs) && l.ts < sinceTs) continue;
    const key = periodKey(l.ts, period);
    const acc = accs.get(key) ?? newAcc(key);
    accs.set(key, acc);
    const b = acc.b;
    b.replies++;
    b.verdicts[verdict as "allow" | "flag" | "block"]++;
    for (const s of Array.isArray(l.signatures) ? l.signatures : []) if (typeof s === "string" && SIG_RE.test(s)) b.bySignature[s] = (b.bySignature[s] ?? 0) + 1;
    switch (l.judge) {
      case "called": b.judge.called++; break;
      case "cache_hit": b.judge.cacheHits++; break;
      case "skipped_hard_block": b.judge.skippedHardBlock++; break;
      case "error": b.judge.errors++; break;
      default: b.judge.notUsed++;
    }
    if (l.judgeTokens) { b.judge.tokens.input += num(l.judgeTokens.input); b.judge.tokens.output += num(l.judgeTokens.output); }
    if (l.overruled && typeof l.overruled === "object") {
      b.overrides.replies++;
      if (l.cleared === true) b.overrides.cleared++;
      for (const [s, n] of Object.entries(l.overruled)) if (SIG_RE.test(s)) b.overrides.bySignature[s] = (b.overrides.bySignature[s] ?? 0) + num(n);
    }
    if (l.crossref && typeof l.crossref === "object") {
      b.crossref.checks++;
      b.crossref.references += num(l.crossref.references);
      b.crossref.found += num(l.crossref.found);
      b.crossref.notFound += num(l.crossref.notFound);
      if (l.crossref.liftedS1 === true) b.crossref.s1Lifted++;
    }
    if (l.ms && typeof l.ms === "object") {
      acc.total.push(num(l.ms.total));
      if (typeof l.ms.judge === "number") acc.judge.push(num(l.ms.judge));
    }
  }
  const priced = opts.priceInputPerMTok != null && opts.priceOutputPerMTok != null;
  const buckets = [...accs.values()].sort((a, b) => a.b.period.localeCompare(b.b.period)).map(({ b, total, judge }) => {
    b.latencyMs = { totalP50: percentile(total, 50), totalP95: percentile(total, 95), judgeP50: percentile(judge, 50), judgeP95: percentile(judge, 95) };
    if (priced) b.judge.estimatedCostUsd = Math.round(((b.judge.tokens.input * opts.priceInputPerMTok! + b.judge.tokens.output * opts.priceOutputPerMTok!) / 1e6) * 1e6) / 1e6;
    return b;
  });
  return {
    period,
    ...(opts.since ? { since: opts.since } : {}),
    linesRead,
    linesSkipped,
    buckets,
    costBasis: priced
      ? `Estimate: provider-reported tokens x your prices (USD ${opts.priceInputPerMTok}/M input, ${opts.priceOutputPerMTok}/M output).`
      : "Not estimated: set AEGIS_JUDGE_PRICE_INPUT_PER_MTOK and AEGIS_JUDGE_PRICE_OUTPUT_PER_MTOK.",
    note: "Observed counts only. The history has no labels, so it cannot say whether a block or flag was right; catch and false-positive rates come from labeled eval runs.",
  };
}

export function rollupMarkdown(r: Rollup): string {
  const sigs = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(", ") || "—";
  const lines = [
    `# Aegis metrics roll-up (per ${r.period}${r.since ? `, since ${r.since}` : ""})`,
    "",
    `${r.linesRead} lines read${r.linesSkipped ? `, ${r.linesSkipped} malformed and skipped` : ""}.`,
    "",
    "| Period | Replies | Allow / Flag / Block | Replies by signature | Judge called / cached / skipped (hard block) / errors | Tokens in / out | Est. cost | Judge overrides (cleared) | Crossref checks (S1 lifted) | p50 / p95 ms | Judge p50 / p95 ms |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...r.buckets.map((b) => `| ${b.period} | ${b.replies} | ${b.verdicts.allow} / ${b.verdicts.flag} / ${b.verdicts.block} | ${sigs(b.bySignature)} | ${b.judge.called} / ${b.judge.cacheHits} / ${b.judge.skippedHardBlock} / ${b.judge.errors} | ${b.judge.tokens.input} / ${b.judge.tokens.output} | ${b.judge.estimatedCostUsd === null ? "—" : `$${b.judge.estimatedCostUsd}`} | ${b.overrides.replies} (${b.overrides.cleared}) | ${b.crossref.checks} (${b.crossref.s1Lifted}) | ${b.latencyMs.totalP50} / ${b.latencyMs.totalP95} | ${b.judge.called ? `${b.latencyMs.judgeP50} / ${b.latencyMs.judgeP95}` : "—"} |`),
    "",
    `Cost: ${r.costBasis}`,
    "",
    r.note,
    "",
  ];
  return lines.join("\n");
}
