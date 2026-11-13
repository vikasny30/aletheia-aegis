/**
 * Aletheia Aegis: Eval harness.
 *
 * Two modes, both deterministic and offline:
 *
 *  1. Guard eval (default): runs the output guard over the bundled labeled
 *     case set (eval/cases.jsonl) and scores it per signature — detection
 *     rate on cases the guard should catch, false-positive rate on benign
 *     controls, and latency. This is the scorecard the README quotes.
 *
 *  2. Corpus mode: runs the paper's keyword classifier (classifier.ts,
 *     Appendix C) over a JSONL incident file — one {"id","source","text"}
 *     object per line — and reports the per-signature distribution next to
 *     the paper's published §3.3 totals. A small bundled sample
 *     (eval/sample-corpus.jsonl) demonstrates the mode; point it at a full
 *     AIID / AVID / MIT Risk export for a real comparison.
 *
 * The two modes measure different things and the scorecard says so: guard
 * eval measures the runtime guard on model responses; corpus mode measures
 * incident-text classification against the paper's taxonomy. Neither mode
 * claims the guard was tested on the full 2,571-entry corpus — the full
 * corpus is not bundled with this repository.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyIncident, PAPER_SIGNATURE_TOTALS } from "./classifier.js";
import { OutputEvaluator } from "./evaluator.js";
import type { GuardedSignature, SignatureId, Verdict } from "./types.js";

export type ExpectedVerdict = "allow" | "flag" | "block";

export interface EvalCase {
  id: string;
  signature: GuardedSignature | "benign";
  prompt?: string;
  response: string;
  expected: ExpectedVerdict;
  note?: string;
  /** Provenance, e.g. "hand-built" or "model output (Claude Sonnet), hand-labeled".
   *  Recorded for auditability; scoring ignores it. */
  source?: string;
}

export interface SignatureScore {
  signature: string;
  total: number;
  caught: number;
  detectionRate: number;
  missedIds: string[];
}

export interface GuardScorecard {
  mode: "guard";
  generatedAt: string;
  casesFile: string;
  totalCases: number;
  /** Share of cases whose verdict matched the label. This is SELF-CONSISTENCY
   *  on a hand-built set — it proves the guard does what it says, not that it
   *  catches every real-world failure. The held-out set (eval/heldout/) is
   *  the number that means something; see D7. */
  overallAccuracy: number;
  /** Benign controls the guard flagged or blocked. */
  falsePositives: number;
  falsePositiveRate: number;
  /** Cases the guard should have caught but allowed. */
  misses: number;
  /** Set when the cases file is empty or otherwise unusable. */
  note?: string;
  perSignature: SignatureScore[];
  latency: { avgMs: number; p95Ms: number; maxMs: number };
  results: Array<{
    id: string;
    signature: string;
    expected: ExpectedVerdict;
    got: Verdict;
    correct: boolean;
    checks: string[];
    latencyMs: number;
  }>;
}

export interface CorpusScorecard {
  mode: "corpus";
  generatedAt: string;
  corpusFile: string;
  totalEntries: number;
  classifiedEntries: number;
  unclassifiedEntries: number;
  perSignature: Array<{
    signature: SignatureId;
    count: number;
    sharePercent: number;
    paperTotal: number;
  }>;
  note: string;
}

export function evalDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/engine/eval.js -> ../../eval ; src/engine/eval.ts -> ../../eval
  return path.resolve(here, "..", "..", "eval");
}

export function loadCases(filePath?: string): EvalCase[] {
  const file = filePath ?? path.join(evalDir(), "cases.jsonl");
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as EvalCase;
    } catch {
      throw new Error(`Invalid JSON on line ${i + 1} of ${file}`);
    }
  });
}

function verdictMatches(expected: ExpectedVerdict, got: Verdict): boolean {
  if (expected === "allow") return got === "ALLOW";
  if (expected === "flag") return got === "FLAG" || got === "BLOCK";
  return got === "BLOCK";
}

export function runGuardEval(casesFile?: string): GuardScorecard {
  const evaluator = new OutputEvaluator();
  const cases = loadCases(casesFile);
  const file = casesFile ?? path.join(evalDir(), "cases.jsonl");

  const results: GuardScorecard["results"] = [];
  const perSig = new Map<string, { total: number; caught: number; missedIds: string[] }>();
  const latencies: number[] = [];
  let correct = 0;
  let falsePositives = 0;
  let misses = 0;

  for (const c of cases) {
    const result = evaluator.evaluate({ response: c.response, userPrompt: c.prompt });
    const ok = verdictMatches(c.expected, result.verdict);
    if (ok) correct += 1;
    if (c.expected === "allow" && !ok) falsePositives += 1;
    if (c.expected !== "allow" && !ok) misses += 1;

    const bucket = perSig.get(c.signature) ?? { total: 0, caught: 0, missedIds: [] };
    bucket.total += 1;
    if (ok) bucket.caught += 1;
    else bucket.missedIds.push(c.id);
    perSig.set(c.signature, bucket);

    latencies.push(result.latencyMs);
    results.push({
      id: c.id,
      signature: c.signature,
      expected: c.expected,
      got: result.verdict,
      correct: ok,
      checks: result.findings.map((f) => f.check),
      latencyMs: result.latencyMs,
    });
  }

  const benignTotal = cases.filter((c) => c.expected === "allow").length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 0;

  return {
    mode: "guard",
    generatedAt: new Date().toISOString(),
    casesFile: file,
    totalCases: cases.length,
    overallAccuracy: cases.length > 0 ? Math.round((correct / cases.length) * 1000) / 10 : 0,
    falsePositives,
    falsePositiveRate:
      benignTotal > 0 ? Math.round((falsePositives / benignTotal) * 1000) / 10 : 0,
    misses,
    note:
      cases.length === 0
        ? "No cases in this file. Add labeled cases (see eval/heldout/README.md for the held-out process) and re-run."
        : undefined,
    perSignature: [...perSig.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([signature, b]) => ({
        signature,
        total: b.total,
        caught: b.caught,
        detectionRate: Math.round((b.caught / b.total) * 1000) / 10,
        missedIds: b.missedIds,
      })),
    latency: {
      avgMs: Math.round((latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length)) * 1000) / 1000,
      p95Ms: Math.round(p95 * 1000) / 1000,
      maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    },
    results,
  };
}

export function runCorpusEval(corpusFile?: string): CorpusScorecard {
  const file = corpusFile ?? path.join(evalDir(), "sample-corpus.jsonl");
  const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const counts: Record<SignatureId, number> = {
    S1: 0, S2a: 0, S2b: 0, S3: 0, S4: 0, S5: 0, S6: 0, S7: 0, S8: 0,
  };
  let classified = 0;

  for (const line of lines) {
    const entry = JSON.parse(line) as { text?: string; description?: string };
    const text = entry.text ?? entry.description ?? "";
    const { matched } = classifyIncident(text);
    if (matched.length > 0) classified += 1;
    for (const sig of matched) counts[sig] += 1;
  }

  return {
    mode: "corpus",
    generatedAt: new Date().toISOString(),
    corpusFile: file,
    totalEntries: lines.length,
    classifiedEntries: classified,
    unclassifiedEntries: lines.length - classified,
    perSignature: (Object.keys(counts) as SignatureId[]).map((sig) => ({
      signature: sig,
      count: counts[sig],
      sharePercent: lines.length > 0 ? Math.round((counts[sig] / lines.length) * 1000) / 10 : 0,
      paperTotal: PAPER_SIGNATURE_TOTALS[sig],
    })),
    note: "Paper totals are the published §3.3 counts across 2,571 unique incidents (2,787 signature assignments with cross-tagging). This run classifies only the file above; the bundled sample is a small demonstration set, not the full corpus.",
  };
}

export type ScorecardKind = "bundled" | "heldout" | "redteam";

const SCORE_LABEL: Record<ScorecardKind, string> = {
  bundled: "Self-consistency",
  heldout: "Held-out accuracy",
  redteam: "Red-team accuracy",
};
const SCORE_READING: Record<ScorecardKind, string> = {
  bundled: `"Self-consistency" is the honest word for this number: the bundled set is hand-built to the detectors' documented behavior, so it proves the guard does what it says — not that it catches every real-world failure. The held-out set (eval/heldout/, model outputs labeled by hand, never tuned on) is the number that means something.`,
  heldout: `Held-out accuracy: real model outputs, labeled by hand before the guard was run on them, and never used to tune the detectors. This is the number that means something. Misses become red-team cases for general fixes, never case-specific ones; a fix that would only exist because of a held-out case does not ship.`,
  redteam: `Red-team accuracy: adversarial paraphrases written to evade the detectors. Misses here are known evasion gaps, documented per case in eval/redteam.jsonl.`,
};

export function guardScorecardMarkdown(score: GuardScorecard, kind: ScorecardKind = "bundled"): string {
  const rows = score.perSignature
    .map(
      (s) =>
        `| ${s.signature} | ${s.total} | ${s.caught} | ${s.detectionRate}% | ${s.missedIds.join(", ") || "—"} |`,
    )
    .join("\n");
  return [
    `# Aletheia Aegis — Guard Eval Scorecard`,
    ``,
    `Generated ${score.generatedAt} from \`${score.casesFile}\`.`,
    ``,
    `- **Cases:** ${score.totalCases} · **${SCORE_LABEL[kind]}:** ${score.overallAccuracy}%`,
    `- **False positives (benign controls flagged/blocked):** ${score.falsePositives} (${score.falsePositiveRate}%)`,
    `- **Misses (should-have-caught, allowed):** ${score.misses}`,
    `- **Latency:** avg ${score.latency.avgMs} ms · p95 ${score.latency.p95Ms} ms · max ${score.latency.maxMs} ms`,
    ...(score.note ? [``, `> ${score.note}`] : []),
    ``,
    `| Signature | Cases | Caught | Detection | Missed |`,
    `|---|---:|---:|---:|---|`,
    rows,
    ``,
    `A case counts as caught when the verdict matches the label: expected \`block\` requires BLOCK; expected \`flag\` accepts FLAG or BLOCK; expected \`allow\` requires ALLOW.`,
    ``,
    SCORE_READING[kind],
  ].join("\n");
}

export function corpusScorecardMarkdown(score: CorpusScorecard): string {
  const rows = score.perSignature
    .map(
      (s) =>
        `| ${s.signature} | ${s.count} | ${s.sharePercent}% | ${s.paperTotal} |`,
    )
    .join("\n");
  return [
    `# Aletheia Aegis — Corpus Classification`,
    ``,
    `Generated ${score.generatedAt} from \`${score.corpusFile}\`.`,
    ``,
    `- **Entries:** ${score.totalEntries} · **Classified (≥ 1 signature at 0.3):** ${score.classifiedEntries} · **Unclassified:** ${score.unclassifiedEntries}`,
    ``,
    `| Signature | Count | Share | Paper total (§3.3) |`,
    `|---|---:|---:|---:|`,
    rows,
    ``,
    score.note,
  ].join("\n");
}
