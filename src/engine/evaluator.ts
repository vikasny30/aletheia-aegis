/**
 * Aletheia Aegis: Output evaluator.
 *
 * Runs every detector over a model response and combines the findings into
 * one verdict. Deterministic and side-effect free: the same input always
 * produces the same result. Telemetry recording is the caller's job.
 */

import { performance } from "node:perf_hooks";
import { DETECTORS, redactSecrets } from "./detectors.js";
import { normalizeText } from "./normalize.js";
import type { CheckInput, CheckResult, Finding, GuardedSignature, Severity, Verdict } from "./types.js";
import { judgeWouldTruncate, looksLikeJudgeInjection, type Judge } from "./judge.js";
import { extractReferences, lookupReferences, type ReferenceLookup } from "./citation-lookup.js";

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

/** Mask secrets in everything a result carries back to the caller. */
function scrub(result: CheckResult): CheckResult {
  const f = (x: Finding): Finding => ({ ...x, description: redactSecrets(x.description), evidence: redactSecrets(x.evidence) });
  return {
    ...result,
    findings: result.findings.map(f),
    explanation: redactSecrets(result.explanation),
    ...(result.overruledFindings ? { overruledFindings: result.overruledFindings.map(f) } : {}),
    ...(result.judge ? { judge: { ...result.judge, ...(result.judge.reason !== undefined ? { reason: redactSecrets(result.judge.reason) } : {}) } } : {}),
    ...(result.citationCheck ? { citationCheck: { ...result.citationCheck, lookups: result.citationCheck.lookups.map((l) => ({ ...l, reference: redactSecrets(l.reference) })) } } : {}),
  };
}

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
    return scrub(this.evaluatePatterns(rawInput));
  }

  private evaluatePatterns(rawInput: CheckInput): CheckResult {
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
  /**
   * Async path: patterns, then the optional model judge, then the optional
   * Crossref reference check for replies flagged under S1.
   */
  async evaluateEnhanced(...args: Parameters<OutputEvaluator["evaluateEnhancedRaw"]>): Promise<CheckResult> {
    return scrub(await this.evaluateEnhancedRaw(...args));
  }

  private async evaluateEnhancedRaw(
    rawInput: CheckInput,
    opts: { judge?: Judge; verifyCitations?: boolean; lookup?: (text: string) => Promise<ReferenceLookup[]> } = {},
  ): Promise<CheckResult> {
    let result = opts.judge ? await this.evaluateWithJudge(rawInput, opts.judge) : this.evaluate(rawInput);
    if (!opts.verifyCitations || !result.findings.some((f) => f.signature === "S1")) return result;
    const lookups = await (opts.lookup ?? lookupReferences)(normalizeText(rawInput.response));
    if (lookups.length === 0) return result;
    const found = lookups.filter((l) => l.status === "found").length;
    const notFound = lookups.filter((l) => l.status === "not_found");
    // Lift only when every reference in the reply was checked: lookups are
    // capped, and real references listed first must not clear fabricated
    // ones listed after the cap.
    const totalRefs = extractReferences(normalizeText(rawInput.response), Number.MAX_SAFE_INTEGER).length;
    const allFound = found === lookups.length && lookups.length >= totalRefs;
    let findings = result.findings;
    if (allFound) {
      // Every reference resolves to a real work with matching author and year:
      // lift the S1 findings (a finding that also names other signatures keeps those).
      findings = findings.flatMap((f) => {
        if (f.signature !== "S1") return [f];
        const other = f.check.startsWith("JUDGE_") ? f.check.replace(/^JUDGE_/, "").split("_").filter((s) => s !== "S1") : [];
        return other.length ? [{ ...f, signature: (other[0] === "S2A" ? "S2a" : other[0]) as GuardedSignature }] : [];
      });
    } else if (notFound.length) {
      findings = findings.map((f) => f.signature === "S1"
        ? { ...f, evidence: `${f.evidence} | Not found in Crossref: ${notFound.map((l) => l.reference.slice(0, 80)).join(" ; ")}` }
        : f);
    }
    const verdict = verdictFor(findings);
    result = {
      ...result,
      verdict,
      riskScore: combineRisk(findings),
      findings,
      passed: verdict === "ALLOW",
      explanation: explain(verdict, findings, result.checksSkipped) + (allFound ? ` [All ${found} cited works were found in Crossref; S1 findings lifted.]` : ""),
      citationCheck: {
        source: "crossref",
        references: lookups.length,
        found,
        notFound: notFound.length,
        unverifiable: lookups.length - found - notFound.length,
        liftedS1: allFound,
        lookups,
      },
    };
    return result;
  }

  async evaluateWithJudge(rawInput: CheckInput, judge: Judge): Promise<CheckResult> {
    return scrub(await this.evaluateWithJudgeRaw(rawInput, judge));
  }

  private async evaluateWithJudgeRaw(rawInput: CheckInput, judge: Judge): Promise<CheckResult> {
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
    // Text aimed at the reviewer (forged tags, "note to the automated reviewer",
    // a verdict in the judge's format) means the judge may be manipulated:
    // it can still add findings, but may not overrule the patterns.
    const injection = looksLikeJudgeInjection(normalizeText(rawInput.response), rawInput.userPrompt === undefined ? undefined : normalizeText(rawInput.userPrompt));
    // A reply too long to send in full can't be cleared by a judge that saw only part of it.
    const effective = injection || judgeWouldTruncate(rawInput.response, rawInput.userPrompt) ? "strict" : policy;
    const kept = effective === "strict" ? [...base.findings] : base.findings.filter(HARD_CHECK);
    const overruled = effective === "strict" ? [] : base.findings.filter((f) => !HARD_CHECK(f));
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
    // Floor: the judge may soften a pattern BLOCK to FLAG but never clear it.
    // A reply that manipulates the judge then still reaches the user only
    // with a warning, never as clean.
    if (base.verdict === "BLOCK" && verdictFor(kept) === "ALLOW") {
      const strongest = overruled.find((f) => f.action === "block") ?? overruled[0];
      if (strongest) {
        overruled.splice(overruled.indexOf(strongest), 1);
        kept.push({ ...strongest, action: "flag", severity: "HIGH", description: `${strongest.description} (Blocked by the patterns; the model judge disagreed, so it is flagged rather than cleared.)` });
      }
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
      judge: { provider: jv.provider, model: jv.model, label: jv.label, signatures: jv.signatures, reason: jv.reason, latencyMs: jv.latencyMs, cached: jv.cached, policy, ...(injection ? { injectionSuspected: true } : {}) },
      ...(overruled.length ? { overruledFindings: overruled } : {}),
    };
  }
}
