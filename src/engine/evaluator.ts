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
import type { CheckInput, CheckResult, Finding, GuardedSignature, Severity, Verdict } from "./types.js";
import type { Judge } from "./judge.js";

/** Pattern checks the judge can never overrule: structured leaks (SSNs, card
 *  numbers, secrets) are exact matches, not judgment calls. */
const HARD_CHECK = (f: Finding) => f.signature === "S3";

const JUDGE_REMEDIATION: Record<GuardedSignature, string> = {
  S1: "Verify the cited sources or figures, or remove them and say they could not be verified.",
  S2a: "Do not treat the identity claim as verified. Re-issue the response for a general audience.",
  S3: "Remove the personal data or secret from the response.",
  S4: "Re-read the prompt for idiomatic intent and answer what the user meant.",
  S5: "Add a referral to a qualified professional, or urgent care when the situation is urgent; for unknown programming languages, say so.",
  S6: "Add crisis resources and remove any method detail or validation of a plan.",
  S7: "Do not repeat the institutional claim as fact; say it could not be verified.",
};

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
      mode: "patterns",
    };
  }

  /**
   * Pattern detectors plus a model judge. Balanced policy (default): the judge
   * decides, except that S3 pattern hits (SSNs, card numbers, secrets) always
   * count. Strict policy: flag when either the patterns or the judge flags.
   * On held-out data, balanced roughly doubled the share of failures caught
   * without raising false alarms; strict caught a little more at nearly twice
   * the false-alarm rate. If the judge fails, the pattern result is returned
   * with mode "patterns (judge unavailable)".
   */
  async evaluateWithJudge(rawInput: CheckInput, judge: Judge): Promise<CheckResult> {
    const base = this.evaluate(rawInput);
    const policy = judge.config.policy;
    let jv;
    try {
      jv = await judge.review(normalizeText(rawInput.response), rawInput.userPrompt === undefined ? undefined : normalizeText(rawInput.userPrompt));
    } catch (e) {
      return {
        ...base,
        mode: "patterns (judge unavailable)",
        judge: { provider: judge.config.provider, model: judge.config.model, policy, error: (e as Error).message },
        explanation: `${base.explanation} [Judge unavailable: ${(e as Error).message}; pattern verdict only.]`,
      };
    }
    const kept = policy === "strict" ? [...base.findings] : base.findings.filter(HARD_CHECK);
    const overruled = policy === "strict" ? [] : base.findings.filter((f) => !HARD_CHECK(f));
    if (jv.label !== "allow") {
      const sigs = jv.signatures.length ? jv.signatures : (["S1"] as GuardedSignature[]);
      kept.push({
        signature: sigs[0],
        check: `JUDGE_${sigs.join("_").toUpperCase()}`,
        severity: jv.label === "block" ? "CRITICAL" : "HIGH",
        action: jv.label === "block" ? "block" : "flag",
        description: `Model judge (${jv.provider}/${jv.model}): ${jv.reason}`,
        evidence: jv.reason,
        remediation: sigs.map((s) => JUDGE_REMEDIATION[s]).join(" "),
        confidence: 0.8,
      });
      // A pattern finding on a signature the judge also flagged supports it.
      for (const f of overruled.splice(0)) (sigs.includes(f.signature) ? kept : overruled).push(f);
    }
    const verdict = verdictFor(kept);
    return {
      ...base,
      verdict,
      riskScore: combineRisk(kept),
      findings: kept,
      passed: verdict === "ALLOW",
      latencyMs: Math.round((base.latencyMs + jv.latencyMs) * 1000) / 1000,
      explanation: explain(verdict, kept, base.checksSkipped),
      mode: "patterns+judge",
      judge: { provider: jv.provider, model: jv.model, label: jv.label, signatures: jv.signatures, reason: jv.reason, latencyMs: jv.latencyMs, cached: jv.cached, policy },
      ...(overruled.length ? { overruledFindings: overruled } : {}),
    };
  }
}
