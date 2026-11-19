/**
 * Aletheia Aegis: Telemetry and audit log.
 *
 * In-memory only, same shape as the sibling server's telemetry. One deliberate
 * difference: the audit log never stores response text. An output guard may
 * see sensitive user-facing content (including the secrets it blocks), so
 * records keep verdicts, finding checks, latency, and response length only.
 */

import { appendFileSync } from "node:fs";
import type { AuditRecord, CheckResult, MeasurementSummary, StageLatency, TelemetrySummary } from "./types.js";

const MAX_AUDIT_RECORDS = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 1000) / 1000;
}

const MAX_SAMPLES = 10000;
function pushCapped(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > MAX_SAMPLES) arr.splice(0, arr.length - MAX_SAMPLES);
}
function stage(samples: number[]): StageLatency {
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}
function price(env: string | undefined): number | null {
  const n = Number(env);
  return env !== undefined && env.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

export interface TelemetryOptions {
  /** Append one content-free JSON line per check here (AEGIS_METRICS_LOG). */
  historyPath?: string;
  /** USD per million tokens, for the cost estimate (AEGIS_JUDGE_PRICE_*_PER_MTOK). */
  priceInputPerMTok?: number | null;
  priceOutputPerMTok?: number | null;
}

export class Telemetry {
  private readonly historyPath?: string;
  private readonly priceIn: number | null;
  private readonly priceOut: number | null;
  private readonly stageMs = { patterns: [] as number[], judge: [] as number[], crossref: [] as number[] };
  private readonly judgeTotals = { calls: 0, cacheHits: 0, errors: 0, skippedHardBlock: 0, notUsed: 0, injectionSuspected: 0, callsWithoutTokenReport: 0 };
  private readonly judgeLabels = { allow: 0, flag: 0, block: 0 };
  private readonly tokens = { input: 0, output: 0 };
  private readonly crossref = { checks: 0, references: 0, found: 0, notFound: 0, unverifiable: 0, s1Lifted: 0 };
  private readonly overrides = { findings: 0, repliesCleared: 0, bySignature: {} as Record<string, number> };
  private readonly history = { linesWritten: 0, writeErrors: 0 };

  constructor(options: TelemetryOptions = {}) {
    this.historyPath = options.historyPath ?? (process.env.AEGIS_METRICS_LOG || undefined);
    this.priceIn = options.priceInputPerMTok !== undefined ? options.priceInputPerMTok : price(process.env.AEGIS_JUDGE_PRICE_INPUT_PER_MTOK);
    this.priceOut = options.priceOutputPerMTok !== undefined ? options.priceOutputPerMTok : price(process.env.AEGIS_JUDGE_PRICE_OUTPUT_PER_MTOK);
  }

  private startedAt = Date.now();
  private records: AuditRecord[] = [];
  private latencies: number[] = [];
  private counter = 0;
  // Running totals over every evaluation. The audit log keeps only the last
  // MAX_AUDIT_RECORDS, so totals and rates must not be computed from it.
  private readonly verdictTotals = { allow: 0, flag: 0, block: 0 };
  private readonly checkTotals: Record<string, number> = {};

  record(result: CheckResult, responseLength: number, hadUserPrompt: boolean): void {
    this.counter += 1;
    this.records.push({
      id: `aegis-${this.counter}`,
      timestamp: result.timestamp,
      verdict: result.verdict,
      riskScore: result.riskScore,
      findingsCount: result.findings.length,
      latencyMs: result.latencyMs,
      findingChecks: result.findings.map((f) => f.check),
      responseLength,
      hadUserPrompt,
    });
    if (this.records.length > MAX_AUDIT_RECORDS) this.records.shift();
    this.verdictTotals[result.verdict.toLowerCase() as "allow" | "flag" | "block"] += 1;
    for (const f of result.findings) this.checkTotals[f.check] = (this.checkTotals[f.check] ?? 0) + 1;
    pushCapped(this.latencies, result.latencyMs);
    this.measure(result);
  }

  /** Counts and timings only. Nothing here may read reply text, evidence,
   *  reasons, descriptions or Crossref references: those can hold PII. */
  private measure(result: CheckResult): void {
    const j = result.judge;
    const judgeMs = j && !j.cached && !j.error && !j.skipped ? (j.latencyMs ?? 0) : 0;
    pushCapped(this.stageMs.patterns, Math.max(0, Math.round((result.latencyMs - judgeMs) * 1000) / 1000));
    let judgeOutcome: string;
    if (!j) { this.judgeTotals.notUsed++; judgeOutcome = "not_used"; }
    else if (j.skipped) { this.judgeTotals.skippedHardBlock++; judgeOutcome = "skipped_hard_block"; }
    else if (j.error) { this.judgeTotals.errors++; judgeOutcome = "error"; }
    else if (j.cached) { this.judgeTotals.cacheHits++; judgeOutcome = "cache_hit"; }
    else {
      this.judgeTotals.calls++; judgeOutcome = "called";
      pushCapped(this.stageMs.judge, j.latencyMs ?? 0);
      if (j.tokens) { this.tokens.input += j.tokens.input; this.tokens.output += j.tokens.output; }
      else this.judgeTotals.callsWithoutTokenReport++;
    }
    if (j?.label) this.judgeLabels[j.label]++;
    if (j?.injectionSuspected) this.judgeTotals.injectionSuspected++;
    const c = result.citationCheck;
    if (c) {
      this.crossref.checks++;
      this.crossref.references += c.references;
      this.crossref.found += c.found;
      this.crossref.notFound += c.notFound;
      this.crossref.unverifiable += c.unverifiable;
      if (c.liftedS1) this.crossref.s1Lifted++;
      pushCapped(this.stageMs.crossref, c.latencyMs);
    }
    const overruled = result.overruledFindings ?? [];
    const overruledBySig: Record<string, number> = {};
    for (const f of overruled) {
      this.overrides.bySignature[f.signature] = (this.overrides.bySignature[f.signature] ?? 0) + 1;
      overruledBySig[f.signature] = (overruledBySig[f.signature] ?? 0) + 1;
    }
    this.overrides.findings += overruled.length;
    const cleared = overruled.length > 0 && result.verdict === "ALLOW";
    if (cleared) this.overrides.repliesCleared++;
    if (this.historyPath) this.appendHistory({
      ts: result.timestamp,
      verdict: result.verdict,
      signatures: [...new Set(result.findings.map((f) => f.signature))],
      checks: result.findings.map((f) => f.check),
      mode: result.mode ?? "patterns",
      judge: judgeOutcome,
      ...(j?.label ? { judgeLabel: j.label } : {}),
      ...(j?.tokens ? { judgeTokens: j.tokens } : {}),
      ...(Object.keys(overruledBySig).length ? { overruled: overruledBySig, cleared } : {}),
      ...(c ? { crossref: { references: c.references, found: c.found, notFound: c.notFound, unverifiable: c.unverifiable, liftedS1: c.liftedS1 } } : {}),
      ms: { total: result.latencyMs, ...(judgeMs ? { judge: judgeMs } : {}), ...(c ? { crossref: c.latencyMs } : {}) },
    });
  }

  private appendHistory(line: Record<string, unknown>): void {
    try {
      // One short line per write, opened with O_APPEND ("a"): concurrent
      // server processes (one per MCP client) never interleave within a line.
      appendFileSync(this.historyPath!, JSON.stringify(line) + "\n", { flag: "a" });
      this.history.linesWritten++;
    } catch (e) {
      if (this.history.writeErrors++ === 0) console.error(`[Aletheia Aegis] Metrics history not written: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }

  private measurementSummary(verdicts: { allow: number; flag: number; block: number }, total: number): MeasurementSummary {
    const priced = this.priceIn !== null && this.priceOut !== null;
    const cost = priced ? Math.round(((this.tokens.input * this.priceIn! + this.tokens.output * this.priceOut!) / 1e6) * 1e6) / 1e6 : null;
    const judged = this.judgeTotals.calls + this.judgeTotals.cacheHits;
    return {
      stageLatency: { patterns: stage(this.stageMs.patterns), judge: stage(this.stageMs.judge), crossref: stage(this.stageMs.crossref) },
      judge: {
        ...this.judgeTotals,
        labels: { ...this.judgeLabels },
        tokens: { ...this.tokens },
        estimatedCostUsd: cost,
        costBasis: priced
          ? `Estimate: provider-reported tokens x your prices (USD ${this.priceIn}/M input, ${this.priceOut}/M output). Calls without a token report are not costed.`
          : "Not estimated: set AEGIS_JUDGE_PRICE_INPUT_PER_MTOK and AEGIS_JUDGE_PRICE_OUTPUT_PER_MTOK to your provider's prices.",
      },
      crossref: { ...this.crossref },
      overrides: { ...this.overrides, bySignature: { ...this.overrides.bySignature } },
      rollup: {
        replies: total,
        blocked: verdicts.block,
        flagged: verdicts.flag,
        patternFlagsClearedByJudge: this.overrides.repliesCleared,
        judgeCostPerJudgedReplyUsd: cost !== null && judged > 0 ? Math.round((cost / judged) * 1e6) / 1e6 : null,
        note: "Observed counts only. Whether a block or flag was right needs a label: catch and false-positive rates come from labeled eval runs (npm run eval:heldout), not from runtime telemetry.",
      },
      history: { enabled: Boolean(this.historyPath), ...this.history },
    };
  }

  summary(): TelemetrySummary {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const verdicts = { ...this.verdictTotals };
    const findingsByCheck: Record<string, number> = { ...this.checkTotals };
    const findingsBySignature: Record<string, number> = {};
    for (const [check, n] of Object.entries(findingsByCheck)) {
      // JUDGE_S6 / JUDGE_S1_S6 count under the signatures the judge named.
      const sigs = check.startsWith("JUDGE_") ? check.slice(6).split("_").map((x) => (x === "S2A" ? "S2a" : x)) : [check.split("_")[0]];
      for (const sig of sigs) findingsBySignature[sig] = (findingsBySignature[sig] ?? 0) + n;
    }
    const total = this.counter;
    const avg =
      this.latencies.length > 0
        ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
        : 0;
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      totalEvaluations: total,
      verdicts,
      flagRatePercent: total > 0 ? Math.round((verdicts.flag / total) * 1000) / 10 : 0,
      blockRatePercent: total > 0 ? Math.round((verdicts.block / total) * 1000) / 10 : 0,
      latency: {
        minMs: sorted.length > 0 ? sorted[0] : 0,
        avgMs: Math.round(avg * 1000) / 1000,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      },
      findingsBySignature,
      findingsByCheck,
      measurement: this.measurementSummary(verdicts, total),
    };
  }

  auditLog(limit = 50): AuditRecord[] {
    return this.records.slice(-limit).reverse();
  }
}
