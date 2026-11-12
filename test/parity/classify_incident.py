#!/usr/bin/env python3
"""Aletheia Aegis: Python incident classifier (D8 parity reference).

An independent implementation of the paper's Appendix C keyword classifier
(Aletheia §3.2), written in Python from the same spec as the TypeScript
implementation in src/engine/classifier.ts. The parity test
(test/parity-test.ts) runs both on the same examples and requires identical
scores and matched sets, so the two implementations cannot drift apart
without anyone noticing.

Scoring rule, verbatim from the paper: confidence = min(1.0, hits x 0.4),
where hits = count of vocabulary keywords matching (case-insensitive
substring) in the text. Inclusion threshold: 0.3 (at least one hit).

Note: the paper repository does not ship its benchmarks/utils.py, so this
file is a fresh implementation of the Appendix C spec — not a copy of the
paper's code. The vocabulary below is the Appendix C vocabulary as
transcribed in the TypeScript implementation.

Usage:
  python3 classify_incident.py --vocabulary            # print vocabulary as JSON
  python3 classify_incident.py --classify <file.jsonl> # classify {"id","text"} lines
"""

import argparse
import json
import sys

SIGNATURE_ORDER = ["S1", "S2a", "S2b", "S3", "S4", "S5", "S6", "S7", "S8"]
THRESHOLD = 0.3

INCIDENT_VOCABULARY = {
    "S1": [
        "hallucination", "fabricated", "false claim", "incorrect information",
        "made up citation", "wrong answer", "misinformation", "inaccurate",
        "fabrication", "citation error", "provided false", "gave incorrect",
        "wrong information", "factual error", "incorrect answer", "generated false",
        "confabulation", "factual inconsistency", "faithfulness failure",
        "grounding failure", "knowledge boundary violation", "medical chatbot error",
        "drug dosage error", "misdiagnosis", "unauthorized diet advice",
    ],
    "S2a": [
        "deepfake", "impersonation", "trust bypass", "authority spoof",
        "fake identity", "credential forgery", "identity fraud", "spoofed",
        "fake account", "false identity", "synthetic media", "fake video",
        "manipulated media", "forged", "synthetic voice", "cloned voice",
        "voice cloning", "face swap", "identity theft", "ai-cloned",
        "ai-generated voice", "voice scam", "fake kidnapping", "extortion scam",
        "identity verification bypass", "speaker verification failure",
        "voice authentication failure",
    ],
    "S2b": [
        "prompt injection", "jailbreak", "system prompt override", "jailbreaking",
        "adversarial prompt", "guardrail bypass", "safety filter bypass",
        "instruction override", "indirect injection", "role confusion",
        "bypassed safety", "circumvented filter", "tricked the ai",
        "escaped the sandbox", "broke the rules", "manipulated the chatbot",
        "alignment bypass", "rlhf bypass", "reward hacking", "goal misgeneralization",
        "specification gaming", "out-of-distribution robustness",
        "adversarial robustness", "red teaming",
    ],
    "S3": [
        "unauthorized action", "exceeded scope", "unsanctioned", "beyond mandate",
        "overstepped", "unintended deletion", "scope creep", "out of scope",
        "unauthorized deletion", "deleted", "removed files", "unintended",
        "without permission", "without authorization", "unexpected action",
        "did more than", "went beyond", "took additional action",
        "training data leak", "data memorization", "pii exposure",
        "information leak", "privacy leakage", "membership inference",
        "data extraction", "memorization attack", "attribute inference",
    ],
    "S4": [
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
    "S5": [
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
    "S6": [
        "vulnerable user", "mental health", "crisis signal", "self-harm",
        "missed warning", "at-risk user", "suicide", "distress signal",
        "crisis detection", "vulnerability blind", "mental illness", "depression",
        "anxiety", "harm reduction", "crisis intervention", "at risk",
        "vulnerable population", "emotional distress", "psychological harm",
        "eating disorder", "domestic violence", "non-consensual", "ncii",
        "psychological safety", "non-consensual intimate imagery",
        "survivor support", "crisis nlp", "safeguarding failure",
    ],
    "S7": [
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
    "S8": [
        "no feedback loop", "no correction", "widespread harm",
        "scale without monitoring", "mass deployment failure", "runaway system",
        "no human review", "automated at scale", "unchecked deployment",
        "no oversight", "algorithmic bias", "biased algorithm",
        "perpetuated bias", "discriminatory algorithm", "systemic bias",
        "disparate impact", "recommendation algorithm", "deployed at scale",
        "widespread discrimination", "bias in", "biased results",
        "unfair algorithm",
    ],
}


def classify(text):
    lower = text.lower()
    scores = {}
    for sig in SIGNATURE_ORDER:
        hits = [kw for kw in INCIDENT_VOCABULARY[sig] if kw in lower]
        scores[sig] = min(1.0, len(hits) * 0.4)
    matched = sorted(
        (s for s in SIGNATURE_ORDER if scores[s] >= THRESHOLD),
        key=lambda s: (-scores[s], SIGNATURE_ORDER.index(s)),
    )
    return {"scores": scores, "matched": matched}


def main():
    parser = argparse.ArgumentParser(description="Aletheia Appendix C classifier (parity reference)")
    parser.add_argument("--vocabulary", action="store_true", help="print the vocabulary as JSON")
    parser.add_argument("--classify", metavar="FILE", help="classify a JSONL file of {id, text}")
    args = parser.parse_args()

    if args.vocabulary:
        print(json.dumps(INCIDENT_VOCABULARY, sort_keys=True))
        return 0

    if args.classify:
        with open(args.classify, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                result = classify(row["text"])
                print(json.dumps({"id": row["id"], **result}))
        return 0

    parser.print_usage(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
