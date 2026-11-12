/**
 * Aletheia Aegis: Incident classifier.
 *
 * Re-implements the paper's keyword classifier (Aletheia §3.2, Appendix C)
 * for the eval harness's corpus mode: given incident text, it returns a
 * per-signature confidence score so a corpus file can be checked against the
 * paper's published distribution (§3.3).
 *
 * Scoring rule, verbatim from the paper: confidence = min(1.0, hits x 0.4),
 * where hits = count of vocabulary keywords matching (case-insensitive
 * substring) in the text. Inclusion threshold: 0.3 (at least one hit).
 * Cross-tagging: an incident may score above threshold on several signatures.
 *
 * This classifies incident *reports*, not model outputs. It is an offline
 * annotation tool. The live guard is the detector engine (detectors.ts),
 * which checks model responses with output-specific patterns.
 */

import type { SignatureId } from "./types.js";

/** Signature-specific vocabulary, from Appendix C of the paper. */
export const INCIDENT_VOCABULARY: Record<SignatureId, string[]> = {
  S1: [
    "hallucination", "fabricated", "false claim", "incorrect information",
    "made up citation", "wrong answer", "misinformation", "inaccurate",
    "fabrication", "citation error", "provided false", "gave incorrect",
    "wrong information", "factual error", "incorrect answer", "generated false",
    "confabulation", "factual inconsistency", "faithfulness failure",
    "grounding failure", "knowledge boundary violation", "medical chatbot error",
    "drug dosage error", "misdiagnosis", "unauthorized diet advice",
  ],
  S2a: [
    "deepfake", "impersonation", "trust bypass", "authority spoof",
    "fake identity", "credential forgery", "identity fraud", "spoofed",
    "fake account", "false identity", "synthetic media", "fake video",
    "manipulated media", "forged", "synthetic voice", "cloned voice",
    "voice cloning", "face swap", "identity theft", "ai-cloned",
    "ai-generated voice", "voice scam", "fake kidnapping", "extortion scam",
    "identity verification bypass", "speaker verification failure",
    "voice authentication failure",
  ],
  S2b: [
    "prompt injection", "jailbreak", "system prompt override", "jailbreaking",
    "adversarial prompt", "guardrail bypass", "safety filter bypass",
    "instruction override", "indirect injection", "role confusion",
    "bypassed safety", "circumvented filter", "tricked the ai",
    "escaped the sandbox", "broke the rules", "manipulated the chatbot",
    "alignment bypass", "rlhf bypass", "reward hacking", "goal misgeneralization",
    "specification gaming", "out-of-distribution robustness",
    "adversarial robustness", "red teaming",
  ],
  S3: [
    "unauthorized action", "exceeded scope", "unsanctioned", "beyond mandate",
    "overstepped", "unintended deletion", "scope creep", "out of scope",
    "unauthorized deletion", "deleted", "removed files", "unintended",
    "without permission", "without authorization", "unexpected action",
    "did more than", "went beyond", "took additional action",
    "training data leak", "data memorization", "pii exposure",
    "information leak", "privacy leakage", "membership inference",
    "data extraction", "memorization attack", "attribute inference",
  ],
  S4: [
    "literal interpretation", "missed context", "misunderstood intent",
    "tone deaf", "context blind", "pragmatic failure", "missed subtext",
    "context blindness", "misread intent", "failed to understand",
    "misunderstood", "missed the point", "ignored context", "did not recognize",
    "failed to recognize intent", "took literally",
    "coreference resolution failure", "implicature failure",
    "theory of mind failure", "sarcasm detection failure",
    "pragmatic inference failure", "discourse coherence failure",
    "anaphora resolution",
  ],
  S5: [
    "no stop mechanism", "continued despite error", "failed to halt",
    "emergency stop failure", "stuck in loop", "no fallback", "no override",
    "no kill switch", "braking failure", "failed to brake", "failed to stop",
    "self-driving", "autonomous vehicle", "robot malfunction", "malfunctioned",
    "out of control", "collision avoidance", "emergency stop", "brake failure",
    "could not stop", "missed the stop", "did not detect",
    "distribution shift failure", "out-of-distribution failure",
    "should not provide", "unauthorized advice", "deployment boundary violation",
    "epistemic overconfidence", "capability overgeneralization",
    "delivery robot", "medical out of domain",
  ],
  S6: [
    "vulnerable user", "mental health", "crisis signal", "self-harm",
    "missed warning", "at-risk user", "suicide", "distress signal",
    "crisis detection", "vulnerability blind", "mental illness", "depression",
    "anxiety", "harm reduction", "crisis intervention", "at risk",
    "vulnerable population", "emotional distress", "psychological harm",
    "eating disorder", "domestic violence", "non-consensual", "ncii",
    "psychological safety", "non-consensual intimate imagery",
    "survivor support", "crisis nlp", "safeguarding failure",
  ],
  S7: [
    "official channel", "institutional authority", "government ai",
    "amplified credibility", "false authority", "institutional framing",
    "misrepresented authority", "false official", "authority amplification",
    "facial recognition", "wrongful arrest", "predictive policing",
    "recidivism", "risk score", "criminal justice", "law enforcement",
    "government algorithm", "court algorithm", "official system",
    "credit scoring", "hiring algorithm", "automated decision", "police",
    "parole", "sentencing", "disinformation", "influence operation",
    "election misinformation", "political deepfake", "opaque algorithm",
    "rejected claims", "narrative manipulation", "synthetic propaganda",
    "astroturfing", "coordinated inauthentic behavior",
  ],
  S8: [
    "no feedback loop", "no correction", "widespread harm",
    "scale without monitoring", "mass deployment failure", "runaway system",
    "no human review", "automated at scale", "unchecked deployment",
    "no oversight", "algorithmic bias", "biased algorithm",
    "perpetuated bias", "discriminatory algorithm", "systemic bias",
    "disparate impact", "recommendation algorithm", "deployed at scale",
    "widespread discrimination", "bias in", "biased results",
    "unfair algorithm",
  ],
};

export const CLASSIFIER_THRESHOLD = 0.3;

export interface IncidentClassification {
  /** Per-signature confidence in [0, 1]. */
  scores: Record<SignatureId, number>;
  /** Signatures at or above the 0.3 inclusion threshold, highest first. */
  matched: SignatureId[];
  /** Keywords that matched, per signature (for auditability). */
  matchedKeywords: Partial<Record<SignatureId, string[]>>;
}

const SIGNATURE_ORDER: SignatureId[] = [
  "S1", "S2a", "S2b", "S3", "S4", "S5", "S6", "S7", "S8",
];

/**
 * Classify incident text against the Appendix C vocabulary.
 * Deterministic, no model involved. Case-insensitive substring matching,
 * exactly as the paper specifies.
 */
export function classifyIncident(text: string): IncidentClassification {
  const lower = text.toLowerCase();
  const scores = {} as Record<SignatureId, number>;
  const matchedKeywords: Partial<Record<SignatureId, string[]>> = {};

  for (const sig of SIGNATURE_ORDER) {
    const hits = INCIDENT_VOCABULARY[sig].filter((kw) => lower.includes(kw));
    scores[sig] = Math.min(1.0, hits.length * 0.4);
    if (hits.length > 0) matchedKeywords[sig] = hits;
  }

  const matched = SIGNATURE_ORDER.filter((s) => scores[s] >= CLASSIFIER_THRESHOLD).sort(
    (a, b) => scores[b] - scores[a],
  );

  return { scores, matched, matchedKeywords };
}

/**
 * Paper §3.3 totals (unique incidents per signature across AIID, Supplemental,
 * AVID, MIT Risk; 2,571 unique incidents, 2,787 signature assignments due to
 * cross-tagging). Used only as the reference distribution in corpus-mode
 * scorecards — never presented as Aegis's own measurement.
 */
export const PAPER_SIGNATURE_TOTALS: Record<SignatureId, number> = {
  S1: 393,
  S2a: 433,
  S2b: 425,
  S3: 404,
  S4: 43,
  S5: 95,
  S6: 435,
  S7: 408,
  S8: 151,
};
