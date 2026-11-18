/**
 * Aletheia Aegis: Telemetry and audit log.
 *
 * In-memory only, same shape as the sibling server's telemetry. One deliberate
 * difference: the audit log never stores response text. An output guard may
 * see sensitive user-facing content (including the secrets it blocks), so
 * records keep verdicts, finding checks, latency, and response length only.
 */

import type { AuditRecord, CheckResult, TelemetrySummary } from "./types.js";

const MAX_AUDIT_RECORDS = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 1000) / 1000;
}

export class Telemetry {
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
    this.latencies.push(result.latencyMs);
    if (this.latencies.length > 10000) this.latencies.splice(0, this.latencies.length - 10000);
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
    };
  }

  auditLog(limit = 50): AuditRecord[] {
    return this.records.slice(-limit).reverse();
  }
}
