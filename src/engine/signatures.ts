/**
 * Aletheia Aegis: Signature coverage table.
 *
 * Names and definitions follow the paper (Aletheia §2.2). Prevalence figures
 * are the paper's AIID counts (§2.2 / §3.3). This table is the single source
 * of truth for the aegis_list_signatures tool and the signatures resource,
 * so the server can never claim coverage its detectors do not have.
 */

import type { SignatureInfo } from "./types.js";

export const SIGNATURES: SignatureInfo[] = [
  {
    id: "S1",
    name: "Confidence Without Grounding",
    enforcedBy: "aegis",
    maturity: "stable",
    aegisCoverage:
      "Flags citation-shaped artifacts (DOI, arXiv, PMID, case citations) and confident precise statistics presented without sourcing or hedging. Aegis cannot verify truth; it flags specifics that need verification before use.",
    paperPrevalence: "AIID 10.9% (164/1,505); 393 entries across corpora",
  },
  {
    id: "S2a",
    name: "Social and Identity Manipulation",
    enforcedBy: "aegis",
    maturity: "stable",
    aegisCoverage:
      "With the user prompt: flags responses that grant privileged detail (clinical, legal, security) on the strength of an unverified identity claim in the prompt. Response-only: flags the model claiming professional credentials for itself.",
    paperPrevalence: "403 incidents across corpora (AIID-dominant: 370)",
  },
  {
    id: "S2b",
    name: "Adversarial Input Exploitation",
    enforcedBy: "aletheia-mcp",
    maturity: "n/a",
    aegisCoverage:
      "Not checked here. Prompt injection and jailbreaks are input-side and stay with aletheia-mcp's pre-execution filter (S2b heuristic).",
    paperPrevalence: "376 incidents (AVID-dominant: 366)",
  },
  {
    id: "S3",
    name: "Scope Creep Beyond Mandate",
    enforcedBy: "aegis",
    maturity: "stable",
    aegisCoverage:
      "Output half only: blocks PII and secrets exposed in the response itself (SSN, valid credit-card numbers, API keys, private keys, credential pairs). The action half — destructive commands, out-of-mandate tool calls — stays with aletheia-mcp.",
    paperPrevalence: "AIID 2.3% (35/1,505); 404 entries across corpora",
  },
  {
    id: "S4",
    name: "Context Blindness",
    enforcedBy: "aegis",
    maturity: "experimental",
    aegisCoverage:
      "Heuristic, flag-only, low confidence. With the user prompt: flags responses that take a literal-trap idiom ('I could kill him', 'break a leg') or sarcasm marker literally. The paper notes S4 is the hardest signature to instrument; this check is deliberately narrow.",
    paperPrevalence: "0% via keyword classification in AIID; 40 hand-curated cases",
  },
  {
    id: "S5",
    name: "No Safe State Fallback",
    enforcedBy: "aegis",
    maturity: "stable",
    aegisCoverage:
      "Flags definitive high-stakes advice (medical dosage/diagnosis, legal, financial) given without deferral language, disclaimer, or referral to a professional — the response continuing confidently where it should stop and defer. Also flags capability overclaims ('I just accessed your account').",
    paperPrevalence: "AIID 2.6% (39/1,505); 95 entries across corpora",
  },
  {
    id: "S6",
    name: "Vulnerability Signal Blindness",
    enforcedBy: "aegis",
    maturity: "stable",
    aegisCoverage:
      "Flagship check. With the user prompt: blocks responses containing self-harm method detail or encouragement; flags responses that meet a crisis signal with no crisis resources or supportive redirect. A response that includes crisis resources passes.",
    paperPrevalence: "AIID 4.2% (63/1,505); 435 entries across corpora",
  },
  {
    id: "S7",
    name: "Institutional Credibility Amplification",
    enforcedBy: "aegis",
    maturity: "stable",
    aegisCoverage:
      "Flags responses that repeat an institutional attribution ('WHO confirmed…', 'Harvard found…') attached to a specific claim without hedging, citation, or verification — and responses that build on an institutional false premise from the prompt without pushback.",
    paperPrevalence: "AIID 14.7% (221/1,505); 408 entries across corpora",
  },
  {
    id: "S8",
    name: "Feedback Loop Absence",
    enforcedBy: "planned-session-auditor",
    maturity: "n/a",
    aegisCoverage:
      "Not checkable on a single response: the paper defines S8 as a systemic failure where any single output may look reasonable while the aggregate pattern causes harm. Deferred to the planned session auditor, which sees whole trajectories.",
    paperPrevalence: "AIID 2.8% (42/1,505); 151 entries across corpora",
  },
];

export const GUARDED_SIGNATURES = SIGNATURES.filter((s) => s.enforcedBy === "aegis").map(
  (s) => s.id,
);
