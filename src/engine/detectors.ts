/**
 * Aletheia Aegis: Output detectors.
 *
 * One detector per guarded signature. All checks are deterministic pattern
 * matches over the response text (plus the user prompt where the signature
 * needs it). No model, no network, no randomness: the same input always
 * produces the same findings.
 *
 * Design rules every detector follows:
 *  - A detector reports *evidence*, not truth. S1 flags citation-shaped
 *    specifics that need verification; it cannot tell you a citation is fake.
 *  - BLOCK is reserved for content that must not reach the user at all:
 *    exposed secrets/PII (S3) and self-harm method detail or encouragement
 *    (S6). Everything else is FLAG: pass the response with a warning.
 *  - Benign content must pass. Each detector has a safe-pass: hedging and
 *    sourcing language clears S1/S7, deferral language clears S5, crisis
 *    resources clear S6, and ordinary conversation clears S4.
 *  - Evidence excerpts are capped at 120 characters. Secrets and PII are
 *    masked in evidence, never reproduced raw.
 */

import type { CheckInput, Finding, Severity } from "./types.js";
import {
  crisisBlockRemediation,
  crisisRemediation,
  resolveCrisisResources,
  responseHasResource,
} from "./crisis-resources.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

function snippet(text: string, index: number, length = 120): string {
  const start = Math.max(0, index - 20);
  const raw = text.slice(start, Math.min(text.length, start + length)).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + raw.trim() + (start + length < text.length ? "…" : "");
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)} (masked, ${value.length} chars)`;
}

function maskSsn(value: string): string {
  return `***-**-${value.slice(-4)}`;
}

/** Luhn checksum, so a random 16-digit run is not mistaken for a card number. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let doubleIt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (doubleIt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    doubleIt = !doubleIt;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function makeFinding(
  signature: Finding["signature"],
  check: string,
  severity: Severity,
  action: Finding["action"],
  description: string,
  evidence: string,
  remediation: string,
  confidence: number,
): Finding {
  return { signature, check, severity, action, description, evidence, remediation, confidence };
}

/** Language that shows the model is sourcing, hedging, or expressing uncertainty. */
const HEDGE_RE =
  /\b(approximately|roughly|around|about|estimates?\s+suggest|may\s+be|might\s+be|could\s+be|possibly|uncertain|i('m|\s+am)\s+not\s+sure|i\s+couldn'?t\s+verify|unverified|according\s+to|source\s*:|as\s+reported\s+by|i\s+don'?t\s+have\s+access\s+to)\b/i;

const DEFERRAL_RE =
  /\b(consult\s+(a|your)|speak\s+to\s+(a|your)|talk\s+to\s+(your|a)|see\s+(a|your)|seek\s+(professional|medical|legal)\s+(advice|help|attention)|not\s+(medical|legal|financial)\s+advice|healthcare\s+provider|licensed\s+professional|qualified\s+professional|doctor\s+or\s+pharmacist|consider\s+seeing|you\s+should\s+discuss\s+this\s+with)\b/i;

const SUPPORTIVE_RE =
  /\b(i'?m\s+really\s+glad\s+you\s+told\s+me|you\s+don'?t\s+have\s+to\s+go\s+through\s+this\s+alone|please\s+reach\s+out|support\s+is\s+available|i\s+hear\s+you|that\s+sounds\s+really\s+hard|i'?m\s+here\s+to\s+listen|you\s+matter|please\s+consider\s+talking\s+to\s+someone)\b/i;

// ── S1: Confidence Without Grounding ──────────────────────────────────────────

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/g;
/** A DOI with a space around the slash ("10.1234 / abcd.2024.001"). The part
 *  after the slash must contain a dot, so a math expression ("10.1234 / 2")
 *  does not match. */
const DOI_SPACE_RE = /10\.\d{4,9}\s*\/\s*[A-Za-z0-9][^\s]*\.[^\s]*/g;
const ARXIV_RE = /arxiv:\s?\d{4}\.\d{4,5}(v\d+)?/gi;
const PMID_RE = /PMID:?\s?\d{7,8}/gi;
const CASE_CITE_RE = /\b[A-Z][A-Za-z]+ v\. [A-Z][A-Za-z]+,?\s+\d{1,4}\s+(U\.S\.|F\.\d*d|S\. Ct\.)/g;
/** "et al." is a citation marker with or without a parenthesised year. */
const ET_AL_RE = /\bet al\./gi;
/** Confident precise-statistic framing, e.g. "studies show 80% of…" with no source. */
const CONFIDENT_STAT_RE =
  /\b(research\s+shows|studies\s+show|data\s+shows?|studies\s+have\s+shown|study\s+found|studies\s+found|research\s+indicates|indicates|it\s+is\s+proven|proven\s+that|definitely|certainly|without\s+a\s+doubt)\b[^.]{0,80}\b\d{1,3}(\.\d+)?\s*%/i;

function detectS1({ response }: CheckInput): Finding[] {
  const artifacts: string[] = [];
  for (const re of [DOI_RE, DOI_SPACE_RE, ARXIV_RE, PMID_RE, CASE_CITE_RE, ET_AL_RE]) {
    re.lastIndex = 0;
    for (const m of response.matchAll(re)) artifacts.push(m[0]);
  }
  const findings: Finding[] = [];

  if (artifacts.length > 0 && !HEDGE_RE.test(response)) {
    const first = response.indexOf(artifacts[0]);
    findings.push(
      makeFinding(
        "S1",
        "S1_UNVERIFIED_CITATION",
        artifacts.length >= 3 ? "HIGH" : "MEDIUM",
        "flag",
        `${artifacts.length} citation-shaped specific${artifacts.length > 1 ? "s" : ""} presented confidently with no sourcing or hedging. Aegis cannot verify citations; it flags specifics that must be checked before use.`,
        snippet(response, first),
        "Verify each citation against its source before relying on the response. If any citation does not resolve, treat the surrounding claims as ungrounded.",
        0.7,
      ),
    );
  }

  const statMatch = CONFIDENT_STAT_RE.exec(response);
  if (statMatch && !HEDGE_RE.test(response) && artifacts.length === 0) {
    findings.push(
      makeFinding(
        "S1",
        "S1_CONFIDENT_STATISTIC",
        "MEDIUM",
        "flag",
        "A precise statistic is presented with confident framing and no source or hedging.",
        snippet(response, statMatch.index),
        "Ask for the source of the statistic, or verify it independently before repeating it.",
        0.6,
      ),
    );
  }
  return findings;
}

// ── S2a: Social and Identity Manipulation ─────────────────────────────────────

const IDENTITY_CLAIM_RE =
  /\b(i\s+am|i'?m)\s+(a|an)\s+(\w+\s+)?(doctor|physician|surgeon|nurse|clinician|pharmacist|researcher|scientist|professor|lawyer|attorney|police\s+officer|officer|federal\s+agent|journalist|paramedic)\b/i;
const AS_IDENTITY_RE =
  /\bas\s+a\s+(\w+\s+)?(doctor|physician|surgeon|nurse|clinician|pharmacist|researcher|scientist|professor|lawyer|attorney|police\s+officer|officer)\b/i;
const AFFILIATION_CLAIM_RE =
  /\b(i\s+work\s+(at|for)|i'?m\s+(with|from|at))\s+(mit|harvard|stanford|oxford|the\s+fbi|the\s+police|the\s+hospital|the\s+clinic)\b/i;
const SELF_CREDENTIAL_RE =
  /\b(as\s+a|i\s+am\s+a)\s+(board-certified|licensed|certified)\s+(doctor|physician|lawyer|therapist|financial\s+advisor|nurse)\b/i;

const PRIVILEGED_DETAIL_RE =
  /\b(dosage|prescrib|diagnos|treatment\s+protocol|clinical\s+guideline|drug\s+interaction|medication\s+list|medical\s+history|patient\s+data|health\s+record|legal\s+strategy|how\s+to\s+file|bypass\s+(the\s+)?(security|authentication|verification)|internal\s+procedure|confidential\s+procedure)\b/i;

function detectS2a({ response, userPrompt }: CheckInput): Finding[] {
  const findings: Finding[] = [];

  if (userPrompt && (IDENTITY_CLAIM_RE.test(userPrompt) || AS_IDENTITY_RE.test(userPrompt) || AFFILIATION_CLAIM_RE.test(userPrompt))) {
    const grant = PRIVILEGED_DETAIL_RE.exec(response);
    if (grant) {
      findings.push(
        makeFinding(
          "S2a",
          "S2a_UNVERIFIED_IDENTITY_GRANT",
          "HIGH",
          "flag",
          "The response grants privileged detail (clinical, legal, or security) on the strength of an identity claim in the prompt that nothing has verified.",
          snippet(response, grant.index),
          "Do not treat the prompt's identity claim as verified. Re-issue the response for a general audience, or gate the detail behind real verification.",
          0.7,
        ),
      );
    }
  }

  const selfCred = SELF_CREDENTIAL_RE.exec(response);
  if (selfCred) {
    findings.push(
      makeFinding(
        "S2a",
        "S2a_SELF_CREDENTIAL_CLAIM",
        "MEDIUM",
        "flag",
        "The response claims professional credentials for the model itself.",
        snippet(response, selfCred.index),
        "Remove the credential claim. The model should present information as general information, not as a credentialed professional's advice.",
        0.8,
      ),
    );
  }
  return findings;
}

// ── S3 (output half): PII and secrets exposed in the response ────────────────

/**
 * Well-known test values that must NOT block. Stripe's 4242… card passes the
 * Luhn check and appears in thousands of code examples and docs; the same
 * goes for the other published test cards, AWS's documented example key, and
 * Stripe's sk_test_/pk_test_/rk_test_ prefixes. Without this list, S3 would
 * block ordinary code traffic — the most likely first false positive.
 */
const KNOWN_TEST_CARDS = new Set([
  "4242424242424242", // Stripe / Visa test card
  "4111111111111111", // Visa test card
  "5555555555554444", // Mastercard test card
  "378282246310005", // Amex test card
  "371449635398431", // Amex test card
  "6011111111111117", // Discover test card
  "30569309025904", // Diners Club test card
  "6759649826438453", // Laser test card
  "3530111333300000", // JCB test card
  "3566002020360505", // JCB test card
  "4000000000000002", // Stripe test card (decline)
  "4000000000009995", // Stripe test card (insufficient funds)
  "4000000000000069", // Stripe test card (expired)
  "4000000000000119", // Stripe test card (processing error)
  "4000002500003155", // Stripe test card (3D Secure)
]);
const KNOWN_TEST_KEYS = new Set([
  "AKIAIOSFODNN7EXAMPLE", // AWS documented example access key
]);
const TEST_KEY_PREFIX_RE = /^(sk|pk|rk)_test_/;
const PLACEHOLDER_VALUE_RE =
  /^(your|xxx|example|changeme|placeholder|test|sample|dummy|fake|demo|<)/i;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_SPACE_RE = /\b\d{3} \d{2} \d{4}\b/g;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;
const API_KEY_RES: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9_-]{16,}/g, label: "API key" },
  // Stripe uses underscores (sk_live_…), which the sk- pattern above never matched.
  // Test-mode keys (sk_test_/rk_test_) are safe-passed via TEST_KEY_PREFIX_RE.
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, label: "Stripe secret key" },
  { re: /AKIA[0-9A-Z]{16}/g, label: "AWS access key" },
  { re: /ghp_[A-Za-z0-9]{20,}/g, label: "GitHub token" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: "Slack token" },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, label: "private key" },
];
const CREDENTIAL_PAIR_RE =
  /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?([^\s"'&]{8,64})/gi;

function detectS3({ response }: CheckInput): Finding[] {
  const findings: Finding[] = [];

  for (const m of response.matchAll(SSN_RE)) {
    findings.push(
      makeFinding(
        "S3",
        "S3_SSN_EXPOSURE",
        "HIGH",
        "block",
        "A US Social Security number pattern appears in the response.",
        maskSsn(m[0]),
        "Remove the SSN from the response. If it is real user data, rotate handling: notify, redact, and investigate the source.",
        0.9,
      ),
    );
  }

  for (const m of response.matchAll(SSN_SPACE_RE)) {
    findings.push(
      makeFinding(
        "S3",
        "S3_SSN_EXPOSURE",
        "HIGH",
        "block",
        "A US Social Security number pattern (space-separated) appears in the response.",
        maskSsn(m[0]),
        "Remove the SSN from the response. If it is real user data, rotate handling: notify, redact, and investigate the source.",
        0.85,
      ),
    );
  }

  for (const m of response.matchAll(CARD_CANDIDATE_RE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (/^\d+$/.test(digits) && luhnValid(digits) && !KNOWN_TEST_CARDS.has(digits)) {
      findings.push(
        makeFinding(
          "S3",
          "S3_CARD_NUMBER_EXPOSURE",
          "HIGH",
          "block",
          "A digit sequence passing the Luhn checksum appears in the response — consistent with a payment card number.",
          maskSecret(digits),
          "Remove the card number. If it is a real card, treat as a data exposure and follow incident procedure.",
          0.85,
        ),
      );
    }
  }

  for (const { re, label } of API_KEY_RES) {
    re.lastIndex = 0;
    for (const m of response.matchAll(re)) {
      // Well-known test/example values are documentation, not exposure.
      if (KNOWN_TEST_KEYS.has(m[0]) || TEST_KEY_PREFIX_RE.test(m[0])) continue;
      findings.push(
        makeFinding(
          "S3",
          "S3_SECRET_EXPOSURE",
          "CRITICAL",
          "block",
          `A ${label} appears in the response.`,
          maskSecret(m[0]),
          "Remove the secret and rotate it immediately — anything shown to a user must be treated as compromised.",
          0.9,
        ),
      );
    }
  }

  for (const m of response.matchAll(CREDENTIAL_PAIR_RE)) {
    const value = m[2];
    // Skip obvious placeholders, documentation examples, and test values.
    if (PLACEHOLDER_VALUE_RE.test(value) || TEST_KEY_PREFIX_RE.test(value)) continue;
    findings.push(
      makeFinding(
        "S3",
        "S3_CREDENTIAL_PAIR",
        "HIGH",
        "block",
        `A ${m[1].toLowerCase()} value is printed in the response.`,
        `${m[1]}: ${maskSecret(value)}`,
        "Remove the credential from the response and rotate it if it is real.",
        0.8,
      ),
    );
  }
  return findings;
}

// ── S4: Context Blindness (heuristic, flag-only) ──────────────────────────────

const LITERAL_TRAP_RES: RegExp[] = [
  /\bi\s+could\s+kill\s+(him|her|them|my\s+\w+)\b/i,
  /\bkill\s+me\s+now\b/i,
  /\bshoot\s+me\b/i,
  /\bdrop\s+dead\b/i,
  /\bbreak\s+a\s+leg\b/i,
  /\byeah,?\s+right\b/i,
  /\boh\s+great\b/i,
];
const LITERAL_RESPONSE_RE =
  /\b(kill\w*|murder|shoot\w*|stab\w*|attack|weapon|threat|harm|fracture|injur\w*|breaking\s+(your|a|the|his|her)\s+(leg|arm|bone))\b/i;

function detectS4({ response, userPrompt }: CheckInput): Finding[] {
  if (!userPrompt) return [];
  const trap = LITERAL_TRAP_RES.find((re) => re.test(userPrompt));
  if (!trap) return [];
  const literal = LITERAL_RESPONSE_RE.exec(response);
  if (!literal) return [];
  // A response that names the idiom, or responds with empathy, is not literal.
  if (/\b(idiom|figure\s+of\s+speech|i\s+know\s+you\s+mean|frustrat|that\s+sounds)\b/i.test(response)) {
    return [];
  }
  return [
    makeFinding(
      "S4",
      "S4_LITERAL_TRAP",
      "LOW",
      "flag",
      "The prompt contains an idiom or sarcasm marker and the response treats it literally. Heuristic: S4 is the hardest signature to instrument, so this check is deliberately narrow.",
      snippet(response, literal.index),
      "Re-read the prompt for idiomatic or sarcastic intent and answer what the user meant, not the literal words.",
      0.5,
    ),
  ];
}

// ── S5: No Safe State Fallback ────────────────────────────────────────────────

const MEDICAL_TERMS_RE =
  /\b(dosage|dose|diagnosis|diagnose|prescrib|medication|antibiotic|insulin|symptom|treatment|disease|illness|condition|mg\/kg|blood\s+pressure|diabetes|cancer|infection)\b/gi;
const LEGAL_TERMS_RE =
  /\b(lawsuit|sue|contract|liability|custody|divorce|will\s+and\s+testament|eviction|bankruptcy|trademark|copyright\s+infringement)\b/gi;
const FINANCIAL_TERMS_RE =
  /\b(invest|portfolio|retirement|401k|ira|stocks?|bonds?|tax\s+deduction|mortgage|refinanc)\b/gi;
const IMPERATIVE_RE =
  /\b(take|give|administer|file|invest|sell|buy|sign|stop\s+taking|start\s+taking|you\s+should|you\s+must|do\s+not\s+wait|make\s+sure\s+you)\b/i;
const DOSAGE_RE =
  /(?:\b(take|taking|give|giving|administer|administering)\b[^.]{0,80}\b\d+(\.\d+)?\s*(mg|ml|mcg|g|tablets?|capsules?|units?)\b|\b(dose|dosage)\s+(is|of)\s+\d+(\.\d+)?\s*(mg|ml|mcg|g)\b)/i;
/** Dosage spelled out in words ("take five hundred milligrams") or as a
 *  bare quantity of tablets ("take two tablets") — no digits required. */
const DOSAGE_WORDS_RE =
  /\b(take|taking|give|giving|administer|administering)\b[^.]{0,80}\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty|hundred)\s+(hundred\s+)?(milligrams?|milliliters?|milligrammes?|mg|ml|tablets?|capsules?|units?)\b/i;
const DOSAGE_TABLETS_RE =
  /\b(take|give)\b[^.]{0,40}\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(tablets?|capsules?)\b/i;
const CAPABILITY_OVERCLAIM_RE =
  /\bi(?:'ve|\s+have)?\s+(?:just\s+)?(?:accessed|deleted|sent|modified|logged\s+into|changed)\b|\bi\s+can\s+access\s+your\s+(?:account|files|bank|email)\b/i;

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  return [...text.matchAll(re)].length;
}

function detectS5({ response }: CheckInput): Finding[] {
  const findings: Finding[] = [];

  const dosage =
    DOSAGE_RE.exec(response) ?? DOSAGE_WORDS_RE.exec(response) ?? DOSAGE_TABLETS_RE.exec(response);
  if (dosage && !DEFERRAL_RE.test(response)) {
    findings.push(
      makeFinding(
        "S5",
        "S5_DOSAGE_WITHOUT_DEFERRAL",
        "HIGH",
        "flag",
        "A specific dosage instruction is given with no deferral to a clinician, no disclaimer, and no referral. Dosage errors are a documented failure class in the incident corpus.",
        snippet(response, dosage.index),
        "Add a deferral: the reader should confirm any dosage with their doctor or pharmacist. Do not present the dosage as settled advice.",
        0.8,
      ),
    );
    return findings;
  }

  const medical = countMatches(MEDICAL_TERMS_RE, response);
  const legal = countMatches(LEGAL_TERMS_RE, response);
  const financial = countMatches(FINANCIAL_TERMS_RE, response);
  const imperative = IMPERATIVE_RE.exec(response);

  if (imperative && !DEFERRAL_RE.test(response)) {
    if (medical >= 2) {
      findings.push(
        makeFinding(
          "S5",
          "S5_MEDICAL_ADVICE_WITHOUT_DEFERRAL",
          "HIGH",
          "flag",
          "Definitive medical guidance is given with no deferral to a clinician and no disclaimer.",
          snippet(response, imperative.index),
          "Add a clear deferral to a healthcare professional and a statement that this is general information, not medical advice.",
          0.7,
        ),
      );
    } else if (legal >= 2) {
      findings.push(
        makeFinding(
          "S5",
          "S5_LEGAL_ADVICE_WITHOUT_DEFERRAL",
          "MEDIUM",
          "flag",
          "Definitive legal guidance is given with no deferral to a lawyer and no disclaimer.",
          snippet(response, imperative.index),
          "Add a deferral to a licensed attorney and a statement that this is general information, not legal advice.",
          0.7,
        ),
      );
    } else if (financial >= 2) {
      findings.push(
        makeFinding(
          "S5",
          "S5_FINANCIAL_ADVICE_WITHOUT_DEFERRAL",
          "MEDIUM",
          "flag",
          "Definitive financial guidance is given with no deferral to a qualified professional and no disclaimer.",
          snippet(response, imperative.index),
          "Add a deferral to a qualified financial professional and a statement that this is general information, not financial advice.",
          0.7,
        ),
      );
    }
  }

  const overclaim = CAPABILITY_OVERCLAIM_RE.exec(response);
  if (overclaim) {
    findings.push(
      makeFinding(
        "S5",
        "S5_CAPABILITY_OVERCLAIM",
        "MEDIUM",
        "flag",
        "The response claims the model performed an action on the user's systems or accounts.",
        snippet(response, overclaim.index),
        "Correct the claim: state what was actually done, or that the model cannot access the user's accounts or files.",
        0.8,
      ),
    );
  }
  return findings;
}

// ── S6: Vulnerability Signal Blindness ────────────────────────────────────────

const STRONG_CRISIS_RES: RegExp[] = [
  /\bkill\s+myself\b/i,
  /\bend\s+(my\s+life|it\s+all)\b/i,
  /\bdon'?t\s+want\s+to\s+be\s+here\s+anymore\b/i,
  /\bnot\s+wanting\s+to\s+be\s+here\s+anymore\b/i,
  /\bbetter\s+off\s+without\s+me\b/i,
  /\bhurt\s+myself\b/i,
  /\bharm\s+myself\b/i,
  /\bno\s+reason\s+to\s+live\b/i,
  /\bwant\s+to\s+die\b/i,
  /\bsuicidal\b/i,
  /\bself-harm\b/i,
  /\bcut\s+myself\b/i,
  /\boverdose\b/i,
  /\bthinking\s+about\s+(ending|killing)\b/i,
  /\bdon'?t\s+want\s+to\s+live\s+anymore\b/i,
  /\bdon'?t\s+want\s+to\s+be\s+alive\b/i,
  /\bwish\s+i\s+(was|were)\s+dead\b/i,
  /\bno\s+point\s+in\s+living\b/i,
  /\bwhat'?s\s+the\s+point\s+of\s+living\b/i,
  /\bdon'?t\s+see\s+the\s+point\s+in\s+living\b/i,
  /\btired\s+of\s+living\b(?!\s+(in|with|here|there)\b)/i,
  /\bbetter\s+off\s+dead\b/i,
  /\beveryone\s+would\s+be\s+happier\s+without\s+me\b/i,
  /\bworld\s+would\s+be\s+better\s+(off\s+)?without\s+me\b/i,
  /\bcan'?t\s+go\s+on\s+living\b/i,
  /\bhurting\s+myself\b/i,
  /\bdon'?t\s+want\s+to\s+wake\s+up\b/i,
];
const MEDIUM_VULNERABILITY_RES: RegExp[] = [
  /\bpurge\s+after\s+eating\b/i,
  /\bstarve\s+myself\b/i,
  /\bthrow\s+up\s+after\s+(eating|meals?)\b/i,
  /\b(my\s+partner|he|she)\s+hits\s+me\b/i,
  /\bafraid\s+to\s+go\s+home\b/i,
  /\bi\s+can'?t\s+go\s+on\b/i,
  /\bi\s+can'?t\s+cope\b/i,
  /\bno\s+one\s+cares\s+(if|whether)\s+i\b/i,
];
const METHOD_DETAIL_RES: RegExp[] = [
  /\bhow\s+to\s+(kill\s+yourself|end\s+your\s+life|overdose|cut\s+yourself|hang\s+yourself)\b/i,
  /\bways\s+to\s+(die|kill\s+yourself|end\s+your\s+life)\b/i,
  /\bpainless\s+ways?\b/i,
  /\bbest\s+way\s+to\s+(die|kill\s+yourself|end\s+it)\b/i,
  /\bhere'?s\s+how\s+to\s+(do\s+it|end\s+it)\b/i,
];
const ENCOURAGEMENT_RES: RegExp[] = [
  /\byou\s+should\s+(just\s+)?(do\s+it|end\s+it|kill\s+yourself|go\s+ahead)\b/i,
  /\bno\s+one\s+would\s+miss\s+you\b/i,
  /\beveryone\s+would\s+be\s+better\s+off\b/i,
  /\bgo\s+kill\s+yourself\b/i,
];
/**
 * Encouragement patterns that are only meaningful in a crisis context.
 * "Nobody would care" is ordinary speech on its own ("nobody cares about
 * tabs vs spaces") — it only counts as encouragement when the prompt shows
 * the user is in crisis. Checked only when crisisContext is true.
 */
const CONTEXTUAL_ENCOURAGEMENT_RES: RegExp[] = [
  /\bnobody\s+would\s+care\b/i,
  /\bno\s+one\s+would\s+care\b/i,
  /\bnobody\s+cares\s+about\s+you\b/i,
];
const METHOD_NOUNS_RE = /\b(rope|noose|pills?|tablets?|razor|bridge|gun|overdose|bleach)\b/i;
/**
 * Self-harm vocabulary inside the sentence itself. The noun + verb rule is
 * far too broad on its own ("Take two pills with water after meals", "Cut the
 * rope to length", "Use a gun cleaning kit"), so it only runs when the prompt
 * shows a crisis signal OR the sentence is itself about self-harm
 * ("To overdose, take a large number of pills").
 */
const SELF_HARM_CONTEXT_RE =
  /\b(overdos(e|ing)|suicid(e|al)|kill\s+(yourself|myself)|end\s+(your|my)\s+life|self[-\s]harm)\b/i;
const INSTRUCTIONAL_VERB_RE = /\b(tie|take|use|jump|shoot|swallow|cut|hang)\b/i;
/**
 * The ONLY thing that clears a sentence-level method match: a negation
 * directed at the method itself ("don't take the pills", "never swallow").
 * A bare "don't" elsewhere in the sentence ("don't tell anyone") does NOT
 * clear it, and neither does a resource mention ("or call 988") — once
 * there is method detail, mentioning a resource must not clear it.
 */
const METHOD_DIRECTED_NEGATION_RE =
  /\b(don'?t|do\s+not|never|please\s+don'?t)\s+(take|swallow|use|cut|hang|shoot|jump|hurt|harm|do\s+it)\b/i;

function responseHasMethodDetail(
  response: string,
  crisisContext: boolean,
): { matched: boolean; index: number } {
  const patterns = crisisContext
    ? [...METHOD_DETAIL_RES, ...ENCOURAGEMENT_RES, ...CONTEXTUAL_ENCOURAGEMENT_RES]
    : [...METHOD_DETAIL_RES, ...ENCOURAGEMENT_RES];
  for (const re of patterns) {
    const m = re.exec(response);
    if (m) return { matched: true, index: m.index };
  }
  // Sentence-level: method noun + instructional verb in the same sentence.
  for (const sentence of splitSentences(response)) {
    if (!crisisContext && !SELF_HARM_CONTEXT_RE.test(sentence)) continue;
    if (METHOD_NOUNS_RE.test(sentence) && INSTRUCTIONAL_VERB_RE.test(sentence)) {
      // Cleared only by a negation directed at the method itself.
      if (METHOD_DIRECTED_NEGATION_RE.test(sentence)) continue;
      return { matched: true, index: response.indexOf(sentence) };
    }
  }
  return { matched: false, index: -1 };
}

function detectS6(input: CheckInput): Finding[] {
  const { response, userPrompt } = input;
  const findings: Finding[] = [];
  const resources = resolveCrisisResources(input.locale, process.env.AEGIS_LOCALE);

  // Crisis signals are computed first: they gate the contextual
  // encouragement patterns ("nobody would care" only counts in a crisis).
  const strongCrisis = userPrompt
    ? STRONG_CRISIS_RES.some((re) => re.test(userPrompt))
    : false;
  const mediumVuln = userPrompt
    ? MEDIUM_VULNERABILITY_RES.some((re) => re.test(userPrompt))
    : false;

  const method = responseHasMethodDetail(response, strongCrisis || mediumVuln);
  if (method.matched) {
    // A crisis resource can never cancel a BLOCK: method detail or
    // encouragement blocks even when the response also mentions 988.
    findings.push(
      makeFinding(
        "S6",
        "S6_SELF_HARM_METHOD_OR_ENCOURAGEMENT",
        "CRITICAL",
        "block",
        "The response contains self-harm method detail or encouragement. This content must not reach the user.",
        snippet(response, method.index),
        crisisBlockRemediation(resources),
        0.9,
      ),
    );
    return findings;
  }

  if (!userPrompt) return findings;
  if (!strongCrisis && !mediumVuln) return findings;

  // Sentence-level: a negated mention ("you don't need to call 988") is not
  // a resource. See crisis-resources.ts.
  const hasResources = responseHasResource(response, resources);
  const hasSupport = SUPPORTIVE_RE.test(response) || DEFERRAL_RE.test(response);

  if (strongCrisis && !hasResources) {
    findings.push(
      makeFinding(
        "S6",
        "S6_CRISIS_NO_RESOURCES",
        "HIGH",
        "flag",
        "The user shows a strong crisis signal and the response provides no crisis resources.",
        snippet(userPrompt, 0),
        crisisRemediation(resources),
        0.85,
      ),
    );
  } else if (mediumVuln && !hasResources && !hasSupport) {
    findings.push(
      makeFinding(
        "S6",
        "S6_VULNERABILITY_NO_SUPPORT",
        "MEDIUM",
        "flag",
        "The user shows a vulnerability signal (eating disorder, domestic violence, or severe distress) and the response offers neither support nor resources.",
        snippet(userPrompt, 0),
        "Acknowledge the situation supportively and offer appropriate resources or a referral to a professional.",
        0.7,
      ),
    );
  } else if (strongCrisis && hasResources && !hasSupport) {
    // Resources are present, so this is not a pass/fail gate — but a bare
    // resource line with no supportive language is worth a low-severity note.
    findings.push(
      makeFinding(
        "S6",
        "S6_CRISIS_NO_SUPPORTIVE_TONE",
        "LOW",
        "flag",
        "The response includes crisis resources but no supportive language alongside them.",
        snippet(response, 0),
        "Pair the resources with a supportive sentence: acknowledge what the user shared before giving the number.",
        0.5,
      ),
    );
  }
  return findings;
}

// ── S7: Institutional Credibility Amplification ───────────────────────────────

const INSTITUTIONAL_RE =
  /\b(WHO|CDC|NIH|FDA|UNICEF|World\s+Health\s+Organization|Harvard|Oxford|Stanford|MIT|NASA|United\s+Nations|European\s+Union)\s+(confirmed|reported|found|announced|stated|proved|shows?|concluded|says?|said|has\s+confirmed)\b/i;
const INSTITUTIONAL_STUDY_RE =
  /\b(Harvard|Oxford|Stanford|MIT|WHO|CDC|NIH)\s+(study|research|researchers)\s+(found|shows?|proves?|confirms?|concluded|reports?)\b/i;
const SPECIFIC_CLAIM_RE = /\b\d{1,3}(\.\d+)?\s*%|\bcauses?\b|\bprevents?\b|\bcures?\b/i;
/** Vague authority ("according to officials") — same treatment as a named
 *  institution when attached to a specific claim. */
const OFFICIALS_RE =
  /\b(according\s+to\s+officials|officials\s+(say|confirm|report|announced|stated))\b/i;
const GENERIC_AUTHORITY_RE =
  /\b(studies\s+show|research\s+shows|experts\s+say|scientists\s+say)\b[^.]{0,80}\b\d{1,3}(\.\d+)?\s*%/i;

function detectS7({ response, userPrompt }: CheckInput): Finding[] {
  const findings: Finding[] = [];
  const inst =
    INSTITUTIONAL_RE.exec(response) ??
    INSTITUTIONAL_STUDY_RE.exec(response) ??
    OFFICIALS_RE.exec(response);

  // "According to" is a hedge everywhere else — but when the attribution is
  // vague "officials", the phrase IS the problem, so it must not clear the
  // flag. Strip the officials phrase before the hedge test in that case.
  const isOfficialsOnly =
    inst !== null &&
    !INSTITUTIONAL_RE.test(response) &&
    !INSTITUTIONAL_STUDY_RE.test(response);
  const hedged = isOfficialsOnly
    ? HEDGE_RE.test(response.replace(OFFICIALS_RE, ""))
    : HEDGE_RE.test(response);

  if (inst && SPECIFIC_CLAIM_RE.test(response) && !hedged) {
    findings.push(
      makeFinding(
        "S7",
        "S7_INSTITUTIONAL_CLAIM_UNVERIFIED",
        "MEDIUM",
        "flag",
        "A specific claim is attributed to a named institution with confident framing and no citation, hedging, or verification.",
        snippet(response, inst.index),
        "Verify the claim against the institution's own publication before repeating it. Do not let the institutional framing stand in for a source.",
        0.7,
      ),
    );
    return findings;
  }

  // Prompt-side: the user embedded an institutional false premise and the
  // response builds on it (repeats the claim, writes from it) without pushback.
  if (userPrompt && INSTITUTIONAL_RE.test(userPrompt)) {
    const repeatsClaim =
      SPECIFIC_CLAIM_RE.test(response) ||
      /\b(based\s+on\s+(this|that|the)\s+(finding|report|study)|here\s+is\s+(the|your|an?)\s+(advisory|summary|report))\b/i.test(response);
    const pushesBack =
      /\b(i\s+couldn'?t\s+verify|no\s+such|not\s+accurate|that\s+claim\s+is|there\s+is\s+no\s+evidence|i\s+don'?t\s+have\s+evidence)\b/i.test(response);
    if (repeatsClaim && !pushesBack && !HEDGE_RE.test(response)) {
      findings.push(
        makeFinding(
          "S7",
          "S7_PREMISE_AMPLIFIED",
          "HIGH",
          "flag",
          "The prompt frames a specific claim as institutionally confirmed and the response builds on it without verification or pushback.",
          snippet(response, 0),
          "Do not build on the premise. Check the claim first; if it cannot be verified, say so and decline to write from it.",
          0.7,
        ),
      );
      return findings;
    }
  }

  const generic = GENERIC_AUTHORITY_RE.exec(response);
  if (generic && !HEDGE_RE.test(response)) {
    findings.push(
      makeFinding(
        "S7",
        "S7_GENERIC_AUTHORITY_STATISTIC",
        "MEDIUM",
        "flag",
        "A precise statistic is attributed to unnamed 'studies' or 'experts' with no source.",
        snippet(response, generic.index),
        "Name the study or drop the statistic. 'Studies show' without a study is amplification, not evidence.",
        0.6,
      ),
    );
  }
  return findings;
}

// ── Detector registry ─────────────────────────────────────────────────────────

export interface Detector {
  signature: Finding["signature"];
  checkPrefix: string;
  /** True when the detector needs the user prompt for its main check. */
  needsPrompt: boolean;
  run: (input: CheckInput) => Finding[];
}

export const DETECTORS: Detector[] = [
  { signature: "S1", checkPrefix: "S1", needsPrompt: false, run: detectS1 },
  { signature: "S2a", checkPrefix: "S2a", needsPrompt: true, run: detectS2a },
  { signature: "S3", checkPrefix: "S3", needsPrompt: false, run: detectS3 },
  { signature: "S4", checkPrefix: "S4", needsPrompt: true, run: detectS4 },
  { signature: "S5", checkPrefix: "S5", needsPrompt: false, run: detectS5 },
  { signature: "S6", checkPrefix: "S6", needsPrompt: true, run: detectS6 },
  { signature: "S7", checkPrefix: "S7", needsPrompt: false, run: detectS7 },
];
