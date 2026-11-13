/**
 * Aletheia Aegis: Output evaluator.
 *
 * Runs every detector over a model response and combines the findings into
 * one verdict. Deterministic and side-effect free: the same input always
 * produces the same result. Telemetry recording is the caller's job.
 */

import { performance } from "node:perf_hooks";
import { DETECTORS } from "./detectors.js";
import { normalizeText } from "./normalize.js";
import type { CheckInput, CheckResult, Finding, Severity, Verdict } from "./types.js";

const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 0.9,
  HIGH: 0.6,
  MEDIUM: 0.35,
  LOW: 0.15,
};

function combineRisk(findings: Finding[]): number {
  // 1 - Π(1 - w): several medium findings compound, but never exceed 1.
  let clear = 1;
  for (const f of findings) clear *= 1 - SEVERITY_WEIGHT[f.severity];
  return Math.round((1 - clear) * 1000) / 1000;
}

function verdictFor(findings: Finding[]): Verdict {
  if (findings.some((f) => f.action === "block")) return "BLOCK";
  if (findings.length > 0) return "FLAG";
  return "ALLOW";
}

function explain(verdict: Verdict, findings: Finding[], skipped: string[]): string {
  if (verdict === "ALLOW") {
    const note =
      skipped.length > 0
        ? ` Prompt-dependent checks skipped (no user prompt supplied): ${skipped.join(", ")}.`
        : "";
    return `No output-safety findings. The response passed all ${DETECTORS.length} signature detectors (6 enforced, 1 experimental).${note}`;
  }
  const bySignature = [...new Set(findings.map((f) => f.signature))].join(", ");
  const worst = findings.map((f) => f.description).slice(0, 2).join(" ");
  return `${verdict}: ${findings.length} finding${findings.length > 1 ? "s" : ""} across ${bySignature}. ${worst}`;
}

export class OutputEvaluator {
  /** Check ids escalated from FLAG to BLOCK by server configuration
   *  (AEGIS_BLOCK_CHECKS). Per-call `blockChecks` union with this set. */
  private readonly configuredBlockChecks: Set<string>;

  constructor(options: { blockChecks?: string[] } = {}) {
    this.configuredBlockChecks = new Set(
      options.blockChecks ??
        (process.env.AEGIS_BLOCK_CHECKS ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
    );
  }

  evaluate(rawInput: CheckInput): CheckResult {
    const started = performance.now();
    // Detectors see normalized text: curly quotes, Unicode spaces/hyphens and
    // zero-width characters would otherwise defeat every phrase pattern.
    const input: CheckInput = {
      ...rawInput,
      response: normalizeText(rawInput.response),
      userPrompt: rawInput.userPrompt === undefined ? undefined : normalizeText(rawInput.userPrompt),
    };
    const findings: Finding[] = [];
    const checksRun: string[] = [];
    const checksSkipped: string[] = [];

    for (const detector of DETECTORS) {
      if (detector.needsPrompt && !input.userPrompt) {
        // S2a, S4 and S6 have response-only checks too, so they still run;
        // only their prompt-dependent checks are skipped.
        checksRun.push(`${detector.checkPrefix} (response-only)`);
        checksSkipped.push(`${detector.checkPrefix} prompt-dependent checks`);
      } else {
        checksRun.push(detector.checkPrefix);
      }
      findings.push(...detector.run(input));
    }

    // D1: deployers can raise severity per check without changing defaults.
    // A health app can turn dosage findings into BLOCKs; the default stays FLAG.
    const blockChecks = new Set([
      ...this.configuredBlockChecks,
      ...(input.blockChecks ?? []),
    ]);
    for (const finding of findings) {
      if (finding.action === "flag" && blockChecks.has(finding.check)) {
        finding.action = "block";
        finding.description += " [Escalated to BLOCK by check configuration.]";
      }
    }

    const verdict = verdictFor(findings);
    const latencyMs = Math.round((performance.now() - started) * 1000) / 1000;

    return {
      verdict,
      riskScore: combineRisk(findings),
      findings,
      passed: verdict === "ALLOW",
      latencyMs,
      timestamp: Date.now(),
      checksRun,
      checksSkipped,
      explanation: explain(verdict, findings, checksSkipped),
    };
  }
}
