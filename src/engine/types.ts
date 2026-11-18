/**
 * Aletheia Aegis: Core Type Definitions
 *
 * Output-side guard for model responses. Covers the output-side signatures of
 * the Aletheia taxonomy (S1, S2a, S3-output, S4, S5, S6, S7). S2b and the
 * action half of S3 stay with the sibling server aletheia-mcp (pre-execution
 * tool-call filter); S8 needs a multi-output trajectory and belongs to the
 * planned session auditor.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** ALLOW: pass through. FLAG: pass with a warning attached. BLOCK: do not show to the user. */
export type Verdict = "ALLOW" | "FLAG" | "BLOCK";

/** Every signature in the Aletheia taxonomy (paper §2.2). */
export type SignatureId = "S1" | "S2a" | "S2b" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";

/** Signatures this server checks on a single model response. */
export type GuardedSignature = "S1" | "S2a" | "S3" | "S4" | "S5" | "S6" | "S7";

export type FindingAction = "block" | "flag";

export interface Finding {
  signature: GuardedSignature;
  /** Machine-readable check id, e.g. S6_CRISIS_NO_RESOURCES. */
  check: string;
  severity: Severity;
  /** What this finding means for the verdict. */
  action: FindingAction;
  /** Plain-language description of what was detected. */
  description: string;
  /** Short excerpt of the matched text. Secrets and PII are masked, never raw. */
  evidence: string;
  /** What the caller should do about it. */
  remediation: string;
  /** Detector confidence in [0, 1]. Pattern checks are 0.5-0.9 by design:
   *  a deterministic guard reports evidence, not certainty. */
  confidence: number;
}

export interface CheckInput {
  /** The model response to check. Required. */
  response: string;
  /** The user message the response answers. Optional, but S2a, S4 and S6
   *  need it: without the prompt they can only run their response-only checks. */
  userPrompt?: string;
  /** Optional free-form context (e.g. channel, user id). Stored only in
   *  telemetry counts, never with response text. */
  context?: string;
  /** Locale for crisis resources (e.g. "US", "GB", "IN"). Falls back to the
   *  AEGIS_LOCALE environment variable, then the US default. An unknown
   *  locale gets US resources plus the international directory. */
  locale?: string;
  /** Check ids (e.g. "S5_DOSAGE_WITHOUT_DEFERRAL") to escalate from FLAG to
   *  BLOCK for this call. Unions with the evaluator's configured set and the
   *  AEGIS_BLOCK_CHECKS environment variable. Lets a deployer raise severity
   *  per check without changing the defaults. */
  blockChecks?: string[];
}

export interface CheckResult {
  verdict: Verdict;
  /** 0.0 (benign) to 1.0 (maximum risk), combined from finding severities. */
  riskScore: number;
  findings: Finding[];
  /** True when verdict is ALLOW. */
  passed: boolean;
  latencyMs: number;
  timestamp: number;
  /** Which checks ran. Prompt-dependent checks report as skipped without a prompt. */
  checksRun: string[];
  checksSkipped: string[];
  explanation: string;
  /** "patterns": pattern detectors only (no judge configured).
   *  "patterns+judge": a model judge reviewed the reply (see `judge`).
   *  "patterns (judge unavailable)": a judge is configured but failed; the
   *  verdict falls back to the pattern detectors and `judge.error` says why. */
  mode?: "patterns" | "patterns+judge" | "patterns (judge unavailable)";
  /** The judge's own verdict, when one ran. The API key is never included. */
  judge?: {
    provider: string;
    model: string;
    label?: "allow" | "flag" | "block";
    signatures?: string[];
    reason?: string;
    latencyMs?: number;
    cached?: boolean;
    policy: "balanced" | "strict";
    error?: string;
  };
  /** Pattern findings the judge overruled (balanced policy): kept for
   *  transparency, not counted in the verdict. */
  overruledFindings?: Finding[];
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  verdict: Verdict;
  riskScore: number;
  findingsCount: number;
  latencyMs: number;
  findingChecks: string[];
  /** Length of the checked response in characters. Response text itself is
   *  never stored: an output guard may see sensitive user-facing content. */
  responseLength: number;
  hadUserPrompt: boolean;
}

export interface TelemetrySummary {
  uptimeSeconds: number;
  totalEvaluations: number;
  verdicts: { allow: number; flag: number; block: number };
  flagRatePercent: number;
  blockRatePercent: number;
  latency: {
    minMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  findingsBySignature: Record<string, number>;
  findingsByCheck: Record<string, number>;
}

export interface SignatureInfo {
  id: SignatureId;
  name: string;
  /** Where the signature is enforced today, or why it is not enforced here. */
  enforcedBy: "aegis" | "aletheia-mcp" | "planned-session-auditor" | "not-runtime-enforced";
  /** "stable": enforced as documented. "experimental": enforced as a narrow
   *  heuristic — partial coverage, flagged as such so the claim stays honest.
   *  "n/a": not enforced by this server. */
  maturity: "stable" | "experimental" | "n/a";
  /** One-line description of what Aegis checks for this signature (or why not). */
  aegisCoverage: string;
  paperPrevalence: string;
}
