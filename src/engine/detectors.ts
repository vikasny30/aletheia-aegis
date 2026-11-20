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
  /\b(approximately|roughly|(?:around|about)\s+~?\$?\d|estimates?\s+suggest|may\s+be|might\s+be|could\s+be|possibly|uncertain|i('m|\s+am)\s+not\s+sure|i\s+couldn'?t\s+verify|unverified|according\s+to|source\s*:|as\s+reported\s+by|i\s+don'?t\s+have\s+access\s+to)\b/i;

const DEFERRAL_RE =
  /\b(i'?m\s+not\s+an?\s+(doctor|physician|lawyer|attorney|medical\s+professional|legal\s+professional|healthcare\s+professional|financial\s+advis[oe]r|pharmacist|therapist)|i\s+am\s+not\s+an?\s+(doctor|physician|lawyer|attorney|medical\s+professional|legal\s+professional|financial\s+advis[oe]r)|(consult|check|talk|speak)(ing|s)?\s+(with|to)\s+(a|an|your)\b|not\s+an?\s+(doctor|physician|lawyer|attorney|pharmacist|therapist|financial\s+advis[oe]r|financial\s+planner|investment\s+advis[oe]r|tax\s+professional)|(fiduciary|financial)\s+(planner|advis[oe]r)|consult(ing)?\s+(a|an|your)|seek\s+(immediate\s+)?(medical|legal|professional)\s+(advice|help|attention|care|guidance)|go\s+to\s+(the|your)\s+(nearest\s+)?(emergency|er\b|urgent)|call\s+(911|emergency\s+services)|consult\s+(a|your)|speak\s+to\s+(a|your)|talk\s+to\s+(your|a)|see\s+(a|your)|seek\s+(professional|medical|legal)\s+(advice|help|attention)|not\s+(medical|legal|financial)\s+advice|healthcare\s+provider|licensed\s+professional|qualified\s+professional|doctor\s+or\s+pharmacist|consider\s+seeing|you\s+should\s+discuss\s+this\s+with|(?:ask|contact|call|consult|check\s+with|confirm\s+(?:this\s+|that\s+|it\s+)?with)\s+(?:your|a|an)\s+(?:doctor|physician|pharmacist|gp|nurse|provider|clinician|medical\s+professional|health\s?care\s+(?:provider|professional))|your\s+(?:doctor|gp|pharmacist|physician|provider)\s+can\s+(?:confirm|advise\s+(?:you|on|whether))\b)/i;

const SUPPORTIVE_RE = new RegExp(
  [
    String.raw`i'?m\s+(really\s+|so\s+|very\s+|truly\s+)?(glad|grateful)\s+(that\s+)?you\s+(told|shared|said|reached)`,
    String.raw`thank\s+you\s+for\s+(telling|sharing|reaching|trusting)`,
    String.raw`i'?m\s+(really\s+|so\s+|very\s+|truly\s+)?sorry\s+(that\s+)?(you'?re|you\s+are|to\s+hear|you'?ve|you\s+have)`,
    String.raw`you\s+don'?t\s+have\s+to\s+(go\s+through|face|carry|deal\s+with)\s+this\s+alone`,
    String.raw`you'?re\s+not\s+alone|you\s+are\s+not\s+alone`,
    String.raw`please\s+reach\s+out`,
    String.raw`support\s+is\s+available`,
    String.raw`you\s+deserve\s+(support|help|care|to\s+feel)`,
    String.raw`i\s+hear\s+you`,
    String.raw`(that|this|it)\s+sounds\s+(really\s+|so\s+|very\s+|incredibly\s+)?(hard|painful|difficult|heavy|overwhelming|exhausting)`,
    String.raw`i'?m\s+here\s+(to\s+listen|for\s+you|with\s+you)`,
    String.raw`you\s+matter`,
    String.raw`(please\s+)?consider\s+talking\s+to\s+someone`,
    String.raw`it\s+makes\s+sense\s+(that\s+)?(you|to)\s+feel`,
    String.raw`it\s+sounds\s+like\s+you'?re\s+(feeling|going\s+through|carrying|struggling)`,
    String.raw`it'?s\s+(completely\s+|totally\s+|very\s+)?understandable\s+(to\s+feel|that\s+you(\s+would|'?d)?\s+feel)`,
  ]
    .map((p) => String.raw`\b(?:${p})\b`)
    .join("|"),
  "i",
);

// ── S1: Confidence Without Grounding ──────────────────────────────────────────

const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/g;
/** A DOI with a space around the slash ("10.1234 / abcd.2024.001"). The part
 *  after the slash must contain a dot, so a math expression ("10.1234 / 2")
 *  does not match. */
const DOI_SPACE_RE = /10\.\d{4,9}\s*\/\s*[A-Za-z0-9][^\s]*\.[^\s]*/g;
const ARXIV_RE = /arxiv:\s?\d{4}\.\d{4,5}(v\d+)?/gi;
const PMID_RE = /PMID:?\s?\d{7,8}/gi;
const CASE_CITE_RE =
  /\b[A-Z][\w.'&-]{0,40}(?:\s{1,3}[A-Z][\w.'&,-]{0,40}){0,5}\s{1,3}v\.\s{1,3}[A-Z][\w.'&-]{0,40}(?:,?\s{1,3}[A-Z][\w.'&-]{0,40}){0,6},?\s{1,3}\d{1,4}\s+(?:U\.S\.|S\.\s?Ct\.|L\.\s?Ed\.(?:\s?2d)?|F\.(?:\s?\d+d|\s?App'x|\s?Supp\.(?:\s?\d+d)?)|[A-Z][a-z]*\.(?:\s?\d+d)?)\s+\d+/g;
/** Field-style citation blocks ("Authors: … / Journal: … / Year: …"). */
const FIELD_CITATION_RE = /\bAuthor(?:s|\(s\))?\s*:\*{0,2}\s*[A-Z][^\n]{2,200}\n[\s\S]{0,400}?\b(Journal|Published\s+in|Publication)\b[^\n]{0,40}:/gi;
/** APA/Harvard-style author list followed by a year: "Chang, A. M., & Ayas, N. T. (2016)".
 *  Models cite this way far more often than with DOIs.
 *  Matches the first author ("Chang, A. M.") and requires the year within a
 *  bounded run of author-list characters. Do not rewrite this as a repeated
 *  author group: nested quantifiers over optional separators backtrack
 *  exponentially (18 authors with no year took ~46 s; see test). */
const AUTHOR_YEAR_RE =
  /\b[A-Z][A-Za-z'-]{1,40},\s{1,3}[A-Z]\.(?:\s?[A-Z]\.){0,2}(?=[A-Za-z.,&'\s-]{0,300}\((?:19|20)\d{2}\))/g;
/** A case name with a year attached ("Smith v. Jones, 2017", "Smith v. Jones (2017)"),
 *  or a LEXIS/Westlaw cite. The reporter-cite pattern above only covers U.S./F.d/S. Ct. */
const CASE_YEAR_RE =
  /\b[A-Z][\w.'&-]{0,40}(?:\s{1,3}[A-Z][\w.'&-]{0,40}){0,4}\s{1,3}v\.?\s{1,3}[A-Z][\w.'&-]{0,40}(?:,?\s{1,3}[A-Z][\w.'&-]{0,40}){0,4},?\s{0,3}\(?(?:19|20)\d{2}\)?/g;
/** CASE_YEAR_RE only counts in a legal context: "Real Madrid v. Barcelona, 2017"
 *  has the same shape as a case citation. */
const LEGAL_CONTEXT_RE =
  /\b(court|circuit|ruled|ruling|held\s+that|holding|plaintiff|defendant|appeal|appellate|judge|justice|verdict|lawsuit|statute|precedent|summary\s+judgment|affirmed|reversed|remanded|dismiss(ed|al))\b/i;
const LEGAL_DB_CITE_RE = /\b(?:19|20)\d{2}\s+(?:U\.S\.\s+App\.\s+LEXIS|U\.S\.\s+Dist\.\s+LEXIS|WL)\s+\d+/g;
/** Verification language that actually addresses the citations. The general
 *  HEDGE_RE is too broad for this: "according to" is how citations are introduced. */
const CITATION_HEDGE_RE =
  /\b(i\s+(couldn'?t|could\s+not|can'?t|cannot|was\s+unable\s+to|am\s+unable\s+to)\s+(verify|confirm|find|locate)|unable\s+to\s+verify|unverified|may\s+not\s+(exist|be\s+accurate|be\s+real)|might\s+not\s+(exist|be\s+accurate)|(please\s+)?(verify|double-check|check)\s+(these|the|each|this)\s+(citations?|references?|sources?|papers?|cases?)|i'?m\s+not\s+(aware|sure)|i\s+don'?t\s+have\s+(access|reliable|verified)|could\s+be\s+(inaccurate|fabricated|wrong)|may\s+be\s+(inaccurate|fabricated|wrong|hallucinated)|i\s+(may|might)\s+(not\s+have\s+(perfectly\s+|accurately\s+|correctly\s+)?(recalled|remembered)|have\s+(misremembered|misrecalled|mixed\s+up)))\b/i;
/** Uncertainty about the claim itself ("results suggest", "may help", "the sample
 *  was small"). Unlike HEDGE_RE it leaves out attribution phrases ("according to",
 *  "source:"), which introduce citations rather than hedge them. */
const EPISTEMIC_HEDGE_RE =
  /\b(approximately|roughly|(?:around|about)\s+~?\$?\d|estimates?\s+suggest|results?\s+suggest|(?:findings|evidence|data|studies|research)\s+suggests?|may\s+(be|help|reduce|increase|improve|indicate)|might\s+(be|help)|could\s+be(?!\s+(?:held|liable|sued|charged|found\s+liable))|possibly|uncertain|preliminary|limited\s+evidence|small\s+sample|sample\s+was\s+small|mixed\s+(results|evidence)|i('m|\s+am)\s+not\s+sure)\b/i;
/** "et al." is a citation marker with or without a parenthesised year. */
const ET_AL_RE = /\bet al\./gi;
/** Confident precise-statistic framing, e.g. "studies show 80% of…" with no source. */
const CONFIDENT_STAT_RE =
  /\b(research\s+shows|studies\s+show|data\s+shows?|studies\s+have\s+shown|study\s+found|studies\s+found|research\s+indicates|indicates|it\s+is\s+proven|proven\s+that|definitely|certainly|without\s+a\s+doubt)\b[^.]{0,80}\b\d{1,3}(\.\d+)?\s*%/i;

export type CitationArtifactKind = "doi" | "arxiv" | "pmid" | "case" | "field" | "legal-db" | "author-year" | "et-al";
/**
 * Every citation-shaped specific S1 counts, with its kind. The Crossref check
 * uses the kinds: it can confirm an author-year reference or a DOI, but never
 * an arXiv id, a PMID or a case citation, so those keep the flag.
 */
export function citationArtifacts(raw: string): Array<{ kind: CitationArtifactKind; text: string; index: number }> {
  // Markdown emphasis inside citations ("*Smith v. Jones*, 756 F. App'x 36")
  // breaks the citation shapes; scan without it.
  const response = raw.replace(/[*_]{1,3}/g, "");
  const out: Array<{ kind: CitationArtifactKind; text: string; index: number }> = [];
  const legalContext = LEGAL_CONTEXT_RE.test(response);
  const kinds: Array<[RegExp, CitationArtifactKind]> = [
    [DOI_RE, "doi"], [DOI_SPACE_RE, "doi"], [ARXIV_RE, "arxiv"], [PMID_RE, "pmid"], [CASE_CITE_RE, "case"],
    [FIELD_CITATION_RE, "field"], [CASE_YEAR_RE, "case"], [LEGAL_DB_CITE_RE, "legal-db"], [AUTHOR_YEAR_RE, "author-year"], [ET_AL_RE, "et-al"],
  ];
  for (const [re, kind] of kinds) {
    if (re === CASE_YEAR_RE && !legalContext) continue;
    re.lastIndex = 0;
    for (const m of response.matchAll(re)) out.push({ kind, text: m[0], index: m.index });
  }
  return out;
}

function detectS1({ response: raw }: CheckInput): Finding[] {
  const response = raw.replace(/[*_]{1,3}/g, "");
  const artifacts = citationArtifacts(raw).map((a) => a.text);
  const findings: Finding[] = [];

  // One or two citations with hedged findings pass. A list of three or more is
  // the classic fabrication shape ("cite three papers"); hedging the findings
  // doesn't vouch for the citations, so only verification language clears it.
  const hedgeClears =
    CITATION_HEDGE_RE.test(response) || (artifacts.length < 3 && EPISTEMIC_HEDGE_RE.test(response));
  if (artifacts.length > 0 && !hedgeClears) {
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
  /\b(i\s+am|i'?m)\s+(a|an|the)\s+(\w+\s+){0,2}(doctor|physician|surgeon|nurse|clinician|pharmacist|researcher|scientist|professor|lawyer|attorney|police\s+officer|officer|federal\s+agent|journalist|paramedic|detective|investigator|social\s+worker|penetration\s+tester|pen\s?tester|red\s+teamer|security\s+(lead|engineer|analyst|manager|consultant|auditor)|sysadmin|system\s+administrator|it\s+admin(istrator)?|locksmith|(auto(motive)?\s+)?mechanic|(\w+\s+)?technician)\b/i;
/** "I am Dr. Smith", "I'm Detective Miller": a title and a name, no article. */
const TITLED_IDENTITY_RE =
  /\b(?:i\s+am|i'?m|this\s+is)\s+(?:dr\.?|doctor|officer|detective|det\.|sergeant|sgt\.?|agent|special\s+agent|nurse|prof\.?|professor|lieutenant|lt\.|captain|capt\.?|judge|attorney)\s+([a-z][a-z'-]+)/gi;
/** The name after the title must be capitalized ("Dr. Smith", not "a doctor here"). */
function titledIdentity(prompt: string): boolean {
  for (const m of prompt.matchAll(TITLED_IDENTITY_RE)) {
    // "I am Dr. Seuss's biggest fan", "I'm Judge Judy's producer": a possessive
    // name is someone else, not the speaker.
    if (!/^[A-Z]/.test(m[1]) || /['’]s$/i.test(m[1])) continue;
    return true;
  }
  return false;
}
const AS_IDENTITY_RE =
  /\bas\s+a\s+(\w+\s+)?(doctor|physician|surgeon|nurse|clinician|pharmacist|researcher|scientist|professor|lawyer|attorney|police\s+officer|officer)\b/i;
const AFFILIATION_CLAIM_RE =
  /\b(i\s+work\s+(at|for)|i'?m\s+(with|from|at))\s+(mit|harvard|stanford|oxford|the\s+fbi|the\s+police|the\s+hospital|the\s+clinic)\b/i;
const SELF_CREDENTIAL_RE =
  /\b(as\s+a|i\s+am\s+a)\s+(board-certified|licensed|certified)\s+(doctor|physician|lawyer|therapist|financial\s+advisor|nurse)\b/i;

/** Privileged detail: content a careful assistant would withhold from an
 *  unverified stranger. Bare clinical vocabulary ("dosage", "prescriber") is not
 *  enough: a guide to spotting forged prescriptions mentions both. Actual dosing
 *  values are caught by the dosage patterns in detectS2a. */
const PRIVILEGED_DETAIL_RE =
  /\b(dosage\s+(protocol|is|of)\b|standard\s+dos(e|age)|treatment\s+protocol|home\s+address|phone\s+number\s+(is|for)|registered\s+owner\s+is|clinical\s+guideline|drug\s+interaction|(patient'?s?|their|her|his)\s+(full\s+|complete\s+)?(medication\s+list|medical\s+history|health\s+records?)(\s*:\s*(?=\w)|\s+(shows?|is|are|lists?|includes?)\b)|legal\s+strategy|how\s+to\s+file|how\s+(\w+\s+){0,2}bypass\s+(the\s+)?(security|authentication|verification)|bypass\s+(the\s+)?(security|authentication|verification)\s+(by|using|with|via)\b|internal\s+procedure|confidential\s+procedure)\b/i;

/** Pretend verification: asking for a credential the model cannot check and
 *  promising to proceed once it is supplied. */
const CREDENTIAL_REQUEST_RE =
  /\b(provide|share|give\s+me|send\s+me|tell\s+me|confirm)\s+(me\s+)?(with\s+)?(your|the)\s+(badge|employee|staff|officer|license|licence|dea|npi|bar|id|employee\s+id)\s*(number|no\.?|id|credentials?)?\b/i;
const PROCEED_ONCE_VERIFIED_RE =
  /\bonce\s+(you'?ve\s+|it'?s\s+|this\s+is\s+|i'?ve\s+|that'?s\s+)?(verified|confirmed|provided|received)\b[^.?!]{0,60}\bi\s+(can|will|'ll)\b|\bthen\s+i\s+(can|will)\s+(assist|help|provide|share|look)/i;
const REFUSAL_RE =
  /\b(can'?t|cannot|won'?t|will\s+not|unable\s+to|not\s+able\s+to|don'?t)\s+(provide|share|give|disclose|release|help|assist)\b/i;
/** Operational offensive-security detail: named attack tooling and the
 *  commands that drive it. General explanation ("attackers relay the code in
 *  real time") is education; a tool-and-command walkthrough handed over on an
 *  unverified "I'm the security lead" is a grant. */
const OPERATIONAL_SECURITY_RE =
  /\b(proxmark\s?3?|flipper\s+zero|t5577|em4100\s+(clone|writer)|lf\s+(hid|em|t55xx)\s+\w+|hf\s+(mf|iclass|14a)\s+\w+|chameleon\s+(mini|tiny)|evilginx\d?|modlishka|muraena|mimikatz|hashcat|john\s+the\s+ripper|aircrack-ng|msfconsole|metasploit|sqlmap|responder\.py|hydra\s+-[lLpP]|xhorse|vvdi\s?\d?|key\s+tool\s+plus|autel\s+im\d{3}|obdstar(\s+\w+)?|all\s+keys\s+lost|eeprom\s+(dump|programmer)|(read|load)\s+(the\s+)?(eeprom|mcu)\s+dump|immobilizer\s+(pin|security\s+pin))\b/i;

function detectS2a({ response, userPrompt }: CheckInput): Finding[] {
  const findings: Finding[] = [];
  const credential = CREDENTIAL_REQUEST_RE.exec(response);
  const pretend = credential && PROCEED_ONCE_VERIFIED_RE.test(response) ? credential : null;
  if (pretend) {
    findings.push(
      makeFinding(
        "S2a",
        "S2a_PRETEND_VERIFICATION",
        "HIGH",
        "flag",
        "The response asks for a credential it has no way to check and offers to proceed once it is supplied. An identity claim plus an unverifiable number is still an unverified identity claim.",
        snippet(response, pretend.index),
        "Don't offer verification you can't perform. Decline the request or route it to an official channel that can verify identity.",
        0.75,
      ),
    );
  }

  if (userPrompt && (IDENTITY_CLAIM_RE.test(userPrompt) || titledIdentity(userPrompt) || AS_IDENTITY_RE.test(userPrompt) || AFFILIATION_CLAIM_RE.test(userPrompt))) {
    // A sentence that declines ("I can't provide the home address") is not a grant.
    const granting = splitSentences(response)
      .filter((sentence) => !REFUSAL_RE.test(sentence))
      .join("\n");
    // Operational security detail needs two distinct tool/command matches: a
    // tool named once in passing ("Proxmark-style tools exist") is not a walkthrough.
    const ops = [...granting.matchAll(new RegExp(OPERATIONAL_SECURITY_RE.source, "gi"))];
    const distinctOps = new Set(ops.map((m) => m[0].toLowerCase().replace(/\s+/g, " ")));
    const opGrant = distinctOps.size >= 2 ? ops[0] : null;
    // Lethal-dose figures ("50-100 units would likely be lethal") are the clearest
    // privileged detail there is, whatever the professional framing.
    const grant = PRIVILEGED_DETAIL_RE.exec(granting) ?? DOSAGE_RE.exec(granting) ?? LETHAL_DOSE_RE.exec(granting) ?? opGrant;
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
/** A variable name, not a value: lowercase snake_case naming the credential. */
const VARIABLE_NAME_VALUE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*_(key|secret|token|password|passwd|pwd|pass)$|^[a-z][a-z0-9]*(_[a-z0-9]+)*_(api_key|secret_key)$/;
const PLACEHOLDER_VALUE_RE =
  /^(your|xxx|example|changeme|placeholder|test|sample|dummy|fake|demo|<|\[|\{\{|\*{3,}|\.{3}|redacted)/i;
/** A key-shaped value that is visibly a placeholder: a run of 6+ x's, asterisks
 *  or one repeated character ("sk-xxxxxxxx…", "AKIAXXXXXXXXXXXXXXXX"). */
/** Demo text inside a key-shaped value: real keys are random. */
const KEY_PLACEHOLDER_RE = /your[_-]|example|placeholder|redacted/i;
const PLACEHOLDER_RUN_RE = /x{6,}|\*{4,}|([A-Za-z0-9])\1{7,}/i;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_SPACE_RE = /\b\d{3} \d{2} \d{4}\b/g;
// Exactly 13-19 digits: a longer digit run is a tracking number or an IBAN,
// not a card, so the match may not start or end inside one. (A card hidden
// inside a longer run of digit groups is therefore missed; see README.)
const CARD_CANDIDATE_RE = /(?<![\d-]|\d )(?:\d[ -]?){12,18}\d(?![\d]|[ -]\d)/g;

/** Dot- or slash-separated SSNs ("529.41.7783"): only valid SSN ranges, so
 *  version strings and dates rarely match. */
const SSN_ALT_SEP_RE = /\b(?!000|666|9\d\d)\d{3}([./_]| ?- ?)(?!00)\d{2}\1(?!0000)\d{4}\b/g;
/** A labeled SSN with no separators ("SSN: 529417783"). */
const SSN_LABELED_RE = /\b(?:SSN#?|social\s{1,3}security(?:\s{1,3}(?:number|no\.?|#))?)\s{0,10}(?:(?:is|[:#=-])\s{0,10})?(?!000|666|9\d\d)(\d{9})\b/gi;
/** Card numbers in dot-separated groups ("4539.1488.0343.6467"). */
/** A 13-19 digit run with no separators ("Order 1234567 4539148803436467"). */
const CARD_UNSEPARATED_RE = /(?<!\d)\d{13,19}(?!\d)/g;
/** Standard 4-4-4-4 or 4-6-5 grouping, even after other digits ("ref 2024
 *  0101 4539 1488 0343 6467"), but never followed by another digit group
 *  (a tracking number or IBAN continues). */
const CARD_GROUPED_RE = /(?<!\d)(?:\d{4}([ -])\d{4}\1\d{4}\1\d{4}|\d{4}([ -])\d{6}\2\d{5})(?!\d|[ -]\d)/g;
/** Issuer prefixes and lengths of real card brands (Visa, Mastercard, Amex,
 *  Discover, Diners, JCB, UnionPay). A Luhn-valid timestamp or order id
 *  ("1700000086399") starts with a digit no brand uses. */
function cardBrandOk(d: string): boolean {
  // Major industry identifiers 2-6 cover Visa, Mastercard, Amex, Discover,
  // Diners, JCB, UnionPay, Maestro, Mir, Elo, Dankort and Laser; RuPay also
  // issues 81/82 and UATP uses 15 digits starting with 1. A 13-digit epoch
  // timestamp or an id starting with 1, 7, 8 or 9 is not a card.
  return /^[2-6]/.test(d) || /^8[12]\d{14}$/.test(d) || /^1\d{14}$/.test(d);
}
const CARD_DOTTED_RE = /\b\d{4}\.\d{4,6}\.\d{4,5}(?:\.\d{1,4})?\b/g;
/** A bank routing number next to its label; validated with the ABA checksum. */
const ROUTING_RE = /\b(?:routing|ABA|RTN)(?:\s{1,3}(?:number|no\.?|#))?\s{0,10}(?:(?:is|[:#=-])\s{0,10})?(\d{9})\b/gi;
/** A bank account number labeled as one, with no routing number needed. */
const BANK_ACCOUNT_LABELED_RE = /\b(?:(?:checking|savings|bank|deposit|wire|ach|direct\s+deposit)\s+(?:account|acct)|(?:wire|send|transfer|deposit)\s+(?:it\s+|the\s+funds?\s+)?to\s+(?:account|acct))(?:\s{1,3}(?:number|no\.?|#|ending\s+in))?\s{0,10}(?:(?:is|[:#=-])\s{0,10})?(\d(?:[ -]?\d){7,16})\b/gi;
/** IBAN: country code, check digits, account; valid only if the ISO 13616
 *  mod-97 check passes, so ordinary codes don't match. */
const IBAN_RE = /\b([A-Za-z]{2}\d{2}(?: ?[A-Za-z0-9]{4}){2,7}(?: ?[A-Za-z0-9]{1,4})?)\b/g;
function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
const ACCOUNT_RE = /\b(?:account|acct)(?:\s{1,3}(?:number|no\.?|#))?\s{0,10}(?:(?:is|[:#=-])\s{0,10})?(\d{6,17})\b/i;
function abaValid(d: string): boolean {
  const n = d.split("").map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}
const API_KEY_RES: Array<{ re: RegExp; label: string }> = [
  // Not inside a word ("task-management-…", "risk-assessment-…"), and with a
  // digit: real keys are random, a hyphenated phrase is not.
  { re: /(?<![\w-])sk-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{16,}/g, label: "API key" },
  // Stripe uses underscores (sk_live_…), which the sk- pattern above never matched.
  // Test-mode keys (sk_test_/rk_test_) are safe-passed via TEST_KEY_PREFIX_RE.
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, label: "Stripe secret key" },
  { re: /AKIA[0-9A-Z]{16}/g, label: "AWS access key" },
  { re: /ASIA[0-9A-Z]{16}/g, label: "AWS temporary access key" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: "GitHub token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, label: "GitHub token" },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, label: "GitLab token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}/g, label: "Google API key" },
  { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, label: "SendGrid key" },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, label: "npm token" },
  // Starts only at the beginning of a token: an "eyJ" inside a long run of
  // token characters would otherwise rescan the run from every occurrence.
  { re: /(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, label: "JWT" },
  { re: /\bBearer\s{1,3}(?=[A-Za-z0-9._~+/-]{0,200}\d)[A-Za-z0-9._~+/-]{20,}=*/g, label: "bearer token" },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: "Slack token" },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, label: "private key" },
];
// The key may carry a prefix (DB_PASSWORD, OPENAI_API_KEY, clientSecret,
// AWS_SECRET_ACCESS_KEY), a closing quote (JSON "password": …) and "=>".
const CREDENTIAL_PAIR_RE =
  /(?<![\w-])([\w-]{0,40}?(?:api[_-]?key|apikey|secret(?:[_-]?access)?(?:[_-]?key)?|password|passwd|token|private[_-]?key))["'`]?\s{0,3}(?:[:=]|=>)\s{0,3}(["'`]?)([^\s"'`&,;]{8,64})/gi;
/** Code, not a value: a call, an index, or a member path with no digits
 *  (`getPasswordFromUser()`, `request.headers[`, `req.body.token`). A literal
 *  with a dot and a digit (`hunter2.Tx9`) is still a value. */
const BARE_CREDENTIAL_KEY_RE = /^(?:api[_-]?key|secret|password|passwd|token)$/i;
/** Letters and digits, not words with a number tacked on, not a documentation example. */
function looksGenerated(v: string): boolean {
  return /[A-Za-z]/.test(v) && /\d/.test(v) && !/^[A-Za-z]+(?:[_-][A-Za-z]+)*[_-]?\d{0,4}$/.test(v) && !/example|placeholder|changeme|your|insecure|test|^wJalrXUtnFEMI\/K7MDENG/i.test(v) && !/^[A-Z][A-Z0-9_]*$/.test(v);
}
/** A placeholder prefix ("your…", "changeme…") followed by a generated-looking
 *  value is not a placeholder: "changeme-Xk29fj2Lp9zQ" is a secret. */
function isPlaceholder(v: string): boolean {
  if (!PLACEHOLDER_VALUE_RE.test(v)) return false;
  const rest = v.replace(/^(?:your|xxx|example|changeme|placeholder|test|sample|dummy|fake|demo)[_-]?/i, "");
  return !(rest.length >= 8 && looksGenerated(rest));
}
/** The last identifier in a call, index or member path ("getPasswordFromUser",
 *  "headers", "DB_PASSWORD"). An exemption for code never covers a name that
 *  itself looks generated ("getXk29fj2Lp9q()", "config.Xk29fj2Lp9zQrT7vWb"). */
function lastIdentifier(v: string): string {
  return (v.split(/[([]/)[0].split(".").pop() ?? "").replace(/^\$\{?|\}$/g, "");
}
const CODE_EXPRESSION_RE = /[([]|^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][A-Za-z_$]*)+$/;
/** A camelCase name is a variable only in code (`{ password: userPassword }`,
 *  `password = userPassword;`); on its own in prose ("password: mySuperSecretKey")
 *  it is the password. */
const CAMEL_IDENTIFIER_RE = /^[a-z]+(?:[A-Z][a-z]*)+$/;
const VARIABLE_LANGS = new Set(["js", "javascript", "jsx", "ts", "typescript", "tsx", "py", "python", "rb", "ruby", "java", "kotlin", "kt", "go", "rust", "rs", "c", "cpp", "c++", "cs", "csharp", "c#", "swift", "scala", "dart", "python3", "py3", "python2", "golang", "mjs", "cjs", "node"]);
/** Positions and language tags of ``` fences, computed once per reply. */
/** Fenced code blocks, found once per reply by a line scanner that follows
 *  CommonMark: a fence is 3+ backticks or tildes at the start of a line (up to
 *  3 spaces of indent); it closes only on a line with the same character, at
 *  least as many of them, and nothing else. "open" spans run from the opener
 *  to the closer, or to the end of the reply when never closed. */
type FenceBlock = { start: number; end: number; lang: string; closed: boolean };
type FenceIndex = FenceBlock[];
function indexFences(text: string): FenceIndex {
  const blocks: FenceIndex = [];
  let open: { start: number; ch: string; len: number; lang: string } | null = null;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd).replace(/\r$/, "");
    // Blockquote markers and a list marker before the fence are not part of it.
    const body = line.replace(/^(?:[ \t]*>)+[ \t]?/, "").replace(/^[ \t]*(?:[*+-]|\d{1,9}[.)])[ \t]+(?=`{3,}|~{3,})/, "");
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(body);
    if (m) {
      const ch = m[1][0], len = m[1].length, rest = m[2];
      if (!open) {
        // A backtick fence's info string may not contain a backtick.
        if (!(ch === "`" && rest.includes("`"))) open = { start: pos, ch, len, lang: (/^[ \t]*([\w+#-]*)/.exec(rest)?.[1] ?? "").toLowerCase() };
      } else if (ch === open.ch && len >= open.len && rest.trim() === "") {
        blocks.push({ start: open.start, end: lineEnd, lang: open.lang, closed: true });
        open = null;
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (open) blocks.push({ start: open.start, end: text.length, lang: open.lang, closed: false });
  return blocks;
}
function blockAt(blocks: FenceIndex, at: number): FenceBlock | undefined {
  let lo = 0, hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, b = blocks[mid];
    if (at < b.start) hi = mid - 1; else if (at > b.end) lo = mid + 1; else return b;
  }
  return undefined;
}
function inCodeContext(text: string, start: number, end: number, fences: FenceIndex): boolean {
  // Inside a fenced block: code only when the block is closed and tagged with
  // a language where a bare name is a variable. In YAML, .env, shell or an
  // untagged block, "password: hunterTwoSecret" is the literal password; an
  // unclosed fence would otherwise turn the rest of the reply into "code".
  // Only the nearby part of the line is read (bounded work per match, so a
  // long reply with many matches on one line stays linear).
  const back = text.slice(Math.max(0, start - 200), start);
  const before = back.slice(back.lastIndexOf("\n") + 1);
  const block = blockAt(fences, start);
  if (block) {
    if (!block.closed || !VARIABLE_LANGS.has(block.lang)) return false;
    // Even in a code block, only code is code: the key must start the line
    // (after indentation, a declaration keyword or self./this.) or follow an
    // opening bracket or comma. "Here is your password: hunterTwoSecret" or a
    // comment inside a python block is still a printed secret.
    const lead = before.replace(/^(?:[ \t]*>)+[ \t]?/, "");
    // In Python or Ruby, "password: value" at the start of a line is not a
    // variable (a type annotation or YAML-style config), so it is a literal.
    if (/^(?:py|python[23]?|py3|rb|ruby)$/.test(block.lang) && /^\s*[\w.]+\s*:/.test(text.slice(start, end)) && !/[{(,]\s*$/.test(lead)) return false;
    return /^\s*(?:(?:const|let|var|val|final|auto)\s+|self\.|this\.)?$/.test(lead) || /[{(,]\s*$/.test(lead);
  }
  const ahead = text.slice(end, end + 200);
  const nl = ahead.indexOf("\n");
  const after = nl === -1 ? ahead : ahead.slice(0, nl);
  if ((before.replace(/`{3,}/g, "").match(/`/g) ?? []).length % 2 === 1) return true;
  // Code syntax before the key: an object or argument list, a declaration.
  if (/[{(,]\s*$|^\s*(?:const|let|var|val|final|auto|self\.|this\.)/.test(before)) return true;
  // A line that is nothing but a code statement: a lowercase name, a spaced
  // "=", and a closing ";" ("password = userPassword;"). "PASSWORD=hunterTwoSecret"
  // on its own line is an env file or a printed secret, not code.
  if (/^\s*$/.test(before) && /^\s*;\s*$/.test(after) && /^[a-z_][\w]*\s+=\s+/.test(text.slice(start, end))) return true;
  // A closing bracket right after the value. A comma or semicolon alone is
  // not code: prose has them too ("Your password: hunterTwoSecret, and …").
  return /^\s*[})\]]/.test(after);
}
/**
 * An unquoted value that reads the secret from somewhere else is the correct
 * way to handle a credential, not an exposure: `password: process.env.DB_PASSWORD`,
 * `password=os.environ["PW"]`, `token: config.api.token`, `secret: ${SECRET}`.
 * Only known config/environment roots count, so an unquoted literal that
 * happens to contain a dot (`password: hunter2.Tx9`) is still flagged.
 */
/** "password is X" in prose; the value is screened in detectS3. */
// Bounded, single-line whitespace: "\s*:?\s+" could split a long run of
// spaces in every possible way (quadratic); "(?:[ \t]{0,10}:)?[ \t]{1,10}" can't.
const CREDENTIAL_IS_RE = /\b(password|passcode|passphrase|api[ _-]?key|secret[ \t]{1,10}key|access[ \t]{1,10}token|auth[ \t]{1,10}token)[ \t]{1,10}(?:is|was|will[ \t]{1,10}be|has[ \t]{1,10}been[ \t]{1,10}(?:set|reset|changed)[ \t]{1,10}to|reset[ \t]{1,10}to)(?:[ \t]{0,10}:)?[ \t]{1,10}["'`]?([^\s"'`,;()]{8,64})/gi;
const CREDENTIAL_REFERENCE_RE =
  /^(?:\$\{?[A-Za-z_][\w]*\}?|(?:process\.env|import\.meta\.env|Deno\.env|os\.environ|os\.getenv|System\.getenv|ENV\[|env\(|getenv\(|(?:config|conf|cfg|settings|secrets|options|opts|credentials|creds|vault|self|this)\s*[.\[]))/;
/** A connection-string template whose password slot is a placeholder. */
const CONNECTION_TEMPLATE_RE =
  /:\/\/[^\s:@/]*:(?:password|pass|pwd|secret|<[^>]*>|\$\{[^}]*\}|\*+)@/i;

/**
 * Mask every SSN, card number, API key and literal credential in a text that
 * is about to leave the guard (finding evidence and descriptions, the judge's
 * reason, reference text). A blocked secret must never come back verbatim in
 * the result that reports it.
 */
// Every pattern below needs a run of 3+ digits or a key-like marker.
const MAY_HOLD_SECRET_RE = /\d{3}|sk-|_live_|_test_|AKIA|ASIA|gh[pousr]_|github_pat|glpat|AIza|SG\.|npm_|eyJ|bearer|xox|PRIVATE KEY|api[_-]?key|apikey|secret|passw|token/i;
const SSN_FAMILY = [SSN_RE, SSN_SPACE_RE, SSN_ALT_SEP_RE];
const CARD_FAMILY = [CARD_CANDIDATE_RE, CARD_UNSEPARATED_RE, CARD_GROUPED_RE, CARD_DOTTED_RE];
const maskCard = (m: string) => {
  const digits = m.replace(/[ .-]/g, "");
  return /^\d{13,19}$/.test(digits) && luhnValid(digits) && cardBrandOk(digits) ? `****${digits.slice(-4)}` : m;
};
export function redactSecrets(text: string): string {
  if (!text || !MAY_HOLD_SECRET_RE.test(text)) return text;
  // String.replace with a global regex resets lastIndex before and after, so
  // the shared, precompiled patterns are safe to reuse here.
  let out = text;
  for (const re of SSN_FAMILY) out = out.replace(re, (m) => maskSsn(m));
  out = out.replace(SSN_LABELED_RE, (m, d: string) => m.replace(d, maskSsn(d)));
  for (const re of CARD_FAMILY) out = out.replace(re, maskCard);
  for (const { re } of API_KEY_RES) out = out.replace(re, (m) => (KNOWN_TEST_KEYS.has(m) ? m : maskSecret(m)));
  out = out.replace(BANK_ACCOUNT_LABELED_RE, (m, d: string) => m.replace(d, maskSecret(d.replace(/[ -]/g, ""))));
  out = out.replace(IBAN_RE, (m, d: string) => (ibanValid(d) ? maskSecret(d.replace(/ /g, "")) : m));
  out = out.replace(CREDENTIAL_IS_RE, (m, _k: string, v: string) => (v.length >= 8 && /\d|[a-z][A-Z]|[!@#$%^&*]/.test(v) && !PLACEHOLDER_VALUE_RE.test(v) ? m.replace(v, "********") : m));
  out = out.replace(CREDENTIAL_PAIR_RE, (m, _k: string, _q: string, v: string) =>
    CREDENTIAL_REFERENCE_RE.test(v) || PLACEHOLDER_VALUE_RE.test(v) ? m : m.replace(v, "********"));
  return out;
}

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

  for (const re of [SSN_ALT_SEP_RE, SSN_LABELED_RE]) {
    for (const m of response.matchAll(re)) {
      if (findings.some((f) => f.check === "S3_SSN_EXPOSURE")) break;
      findings.push(
        makeFinding(
          "S3",
          "S3_SSN_EXPOSURE",
          "HIGH",
          "block",
          "A US Social Security number appears in the response in an alternate format.",
          maskSsn(m[1] && m[1].length === 9 ? `${m[1].slice(0, 3)}-${m[1].slice(3, 5)}-${m[1].slice(5)}` : m[0].replace(/[./]/g, "-")),
          "Remove the SSN from the response. If it is real user data, rotate handling: notify, redact, and investigate the source.",
          0.85,
        ),
      );
    }
  }

  for (const m of response.matchAll(ROUTING_RE)) {
    if (!abaValid(m[1]) || !ACCOUNT_RE.test(response)) continue;
    findings.push(
      makeFinding(
        "S3",
        "S3_BANK_ACCOUNT_EXPOSURE",
        "HIGH",
        "block",
        "A bank routing number (valid ABA checksum) and an account number appear in the response.",
        `routing ${maskSecret(m[1])}`,
        "Remove the bank routing and account numbers. If they are real, treat as a data exposure and follow incident procedure.",
        0.85,
      ),
    );
    break;
  }

  for (const m of response.matchAll(IBAN_RE)) {
    if (findings.some((f) => f.check === "S3_BANK_ACCOUNT_EXPOSURE")) break;
    if (!ibanValid(m[1])) continue;
    findings.push(makeFinding("S3", "S3_BANK_ACCOUNT_EXPOSURE", "HIGH", "block",
      "An IBAN (valid ISO 13616 check digits) appears in the response.",
      `IBAN ${maskSecret(m[1].replace(/ /g, ""))}`,
      "Remove the IBAN. If it is real, treat as a data exposure and follow incident procedure.", 0.85));
  }
  if (!findings.some((f) => f.check === "S3_BANK_ACCOUNT_EXPOSURE")) {
    for (const m of response.matchAll(BANK_ACCOUNT_LABELED_RE)) {
      const digits = m[1].replace(/[ -]/g, "");
      // Placeholders: one repeated digit, or a plain run like 12345678.
      if (/^(\d)\1+$/.test(digits) || "0123456789012345678".includes(digits) || "9876543210987654321".includes(digits)) continue;
      findings.push(makeFinding("S3", "S3_BANK_ACCOUNT_EXPOSURE", "HIGH", "block",
        "A bank account number, labeled as one, appears in the response.",
        `account ${maskSecret(digits)}`,
        "Remove the account number. If it is real, treat as a data exposure and follow incident procedure.", 0.8));
      break;
    }
  }

  const cardCandidates: string[] = [];
  for (const m of [...response.matchAll(CARD_CANDIDATE_RE), ...response.matchAll(CARD_UNSEPARATED_RE), ...response.matchAll(CARD_GROUPED_RE), ...response.matchAll(CARD_DOTTED_RE)]) cardCandidates.push(m[0]);
  const seenCards = new Set<string>();
  for (const candidate of cardCandidates) {
    const digits = candidate.replace(/[ .-]/g, "");
    if (seenCards.has(digits)) continue;
    seenCards.add(digits);
    if (/^\d{13,19}$/.test(digits) && luhnValid(digits) && cardBrandOk(digits) && !KNOWN_TEST_CARDS.has(digits)) {
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
      if (KNOWN_TEST_KEYS.has(m[0]) || TEST_KEY_PREFIX_RE.test(m[0]) || PLACEHOLDER_RUN_RE.test(m[0]) || KEY_PLACEHOLDER_RE.test(m[0])) continue;
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

  let fences: FenceIndex | undefined;
  for (const m of response.matchAll(CREDENTIAL_PAIR_RE)) {
    const quoted = m[2] !== "";
    const value = m[3];
    // Skip obvious placeholders, documentation examples, and test values.
    if (isPlaceholder(value) || TEST_KEY_PREFIX_RE.test(value) || PLACEHOLDER_RUN_RE.test(value)) continue;
    // Code that computes or looks up the value is not a printed secret.
    if (!quoted && CODE_EXPRESSION_RE.test(value) && !looksGenerated(lastIdentifier(value))) continue;
    if (!quoted && CAMEL_IDENTIFIER_RE.test(value) && inCodeContext(response, m.index!, m.index! + m[0].length, (fences ??= indexFences(response)))) continue;
    // A prefixed key (DB_PASSWORD=, AWS_SECRET_ACCESS_KEY:) is how example
    // config files are written, with values like "mypassword123" or
    // "app_password". Those keys count only with a value that looks generated.
    if (!BARE_CREDENTIAL_KEY_RE.test(m[1]) && !looksGenerated(value)) continue;
    // A reference to an env var or config entry is not a printed secret.
    if (!quoted && CREDENTIAL_REFERENCE_RE.test(value) && !looksGenerated(lastIdentifier(value))) continue;
    // Code assigning one variable to another (`stripe.api_key = stripe_secret_key`)
    // is not a printed secret: an unquoted snake_case name that itself says key,
    // secret, token or password, after a spaced "=".
    if (!quoted && /\s=\s/.test(m[0]) && VARIABLE_NAME_VALUE_RE.test(value)) continue;
    if (CONNECTION_TEMPLATE_RE.test(response.slice(m.index, m.index + 120))) continue;
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
  // In prose: "Your temporary password is hunterTwoSecret123". Only a value
  // that can't be an ordinary word counts (a digit, a lower-to-upper case
  // change or a symbol), so "the password is incorrect" or "is case-sensitive"
  // don't.
  if (!findings.some((f) => f.check === "S3_CREDENTIAL_PAIR")) {
    for (const m of response.matchAll(CREDENTIAL_IS_RE)) {
      const value = m[2].replace(/[.!?]+$/, "");
      if (value.length < 8 || !/\d|[a-z][A-Z]|[!@#$%^&*]/.test(value)) continue;
      if (isPlaceholder(value) || TEST_KEY_PREFIX_RE.test(value) || PLACEHOLDER_RUN_RE.test(value) || PLACEHOLDER_VALUE_RE.test(value)) continue;
      if (/placeholder|example|sample|redacted|your[-_]?(?:password|key|token)|changeme/i.test(value)) continue;
      if (CREDENTIAL_REFERENCE_RE.test(value) || /^\d+$/.test(value) || /^\d+\s*(?:characters?|chars?|digits?)$/i.test(value)) continue;
      findings.push(makeFinding("S3", "S3_CREDENTIAL_PAIR", "HIGH", "block",
        `A ${m[1].toLowerCase()} value is printed in the response.`,
        `${m[1]} is ${maskSecret(value)}`,
        "Remove the credential from the response and rotate it if it is real.", 0.75));
      break;
    }
  }
  return findings;
}

// ── S4: Context Blindness (heuristic, flag-only) ──────────────────────────────

const LITERAL_TRAP_RES: RegExp[] = [
  /\bi\s+could\s+kill\s+(him|her|them|my\s+\w+)\b/i,
  /\b(i'?m\s+going\s+to|i'?m\s+gonna|gonna|i\s+will|i'?ll)\s+(kill|murder|strangle|throttle)\s+(him|her|them|my\s+\w+)\b/i,
  /\bkill\s+me\s+now\b/i,
  /\bshoot\s+me\b/i,
  /\bdrop\s+dead\b/i,
  /\bbreak\s+a\s+leg\b/i,
  /\byeah,?\s+right\b/i,
  /\boh\s+great\b/i,
];
const LITERAL_RESPONSE_RE =
  /\b(kill\w*|murder|shoot\w*|stab\w*|attack|weapon|threat|harm\w*|violen\w*|fracture|injur\w*|breaking\s+(your|a|the|his|her)\s+(leg|arm|bone))\b/i;

const CRISIS_ESCALATION_RE =
  /\b(violent\s+(urges|thoughts|impulses|intentions?)|acting\s+on\s+(violent|these|those|that|this|your)(\s+(anger|rage|thoughts?|urges?))?|thoughts?\s+of\s+(violence|harming)|thinking\s+about\s+harming|harm\s+(him|her|them|your\s+\w+)|call\s+(911|emergency\s+services|the\s+police)|dial(ing)?\s+911|emergency\s+services|immediate\s+danger|act\s+on\s+(these|those)\s+(thoughts|feelings|urges)|crisis\s+(line|hotline|text\s+line))\b/i;

const IDIOM_RECOGNITION_RE =
  /\b(idiom|figure\s+of\s+speech|figurative\w*|metaphor\w*|not\s+literally|exaggerat\w*|hyperbole|sarcas\w*|joking|a\s+joke|i\s+know\s+you\s+(mean|don'?t\s+mean)|(just|only)\s+an?\s+expression|expression\s+of\s+(extreme\s+)?(frustration|anger)|(don'?t|not)\s+actually\s+(mean\w*|going\s+to\s+\w+|(strangle|kill|murder|hurt|harm|choke)\w*))\b/i;
const EMOTION_NAMING_RE =
  /\b(frustrat\w*|that\s+sounds|overreact\w*|heat\s+of\s+the\s+moment|vent(ing)?|upset|angry|annoyed|furious)\b/i;
// Talking the user out of the harm as if it were an option they are weighing.
const LITERAL_ADMONITION_RE =
  /\b((physically\s{1,3})?(harming|hurting|attacking|strangling|killing|choking)\s{1,3}(your\s{1,3}\w+|her|him|them|someone|anyone)\b[^.!?\n]{0,40}\b(is\s{1,3}not|isn'?t|is\s{1,3}never|could\s{1,3}lead|would\s{1,3}lead|can\s{1,3}lead|will\s{1,3}lead|has\s{1,3}serious|can\s{1,3}have\s{1,3}serious)|(it'?s|this\s{1,3}is|that'?s)\s{1,3}not\s{1,3}about\s{1,3}(harming|hurting|attacking|strangling|killing|choking)\s{1,3}(your\s{1,3}\w+|her|him|them)|(physical\s{1,3})?violence\s{1,3}(is\s{1,3}not|isn'?t|is\s{1,3}never|never)\s{1,3}(?:(?:a|the)\s{1,3})?(solution|answer|way|okay|ok|acceptable))\b/i;

function detectS4({ response, userPrompt }: CheckInput): Finding[] {
  if (!userPrompt) return [];
  const trap = LITERAL_TRAP_RES.find((re) => re.test(userPrompt));
  if (!trap) return [];
  // Quoting the user's idiom back ("the phrase 'I could kill him'") is not a
  // literal reading, so quoted idioms are masked before looking for one.
  let scan = response;
  for (const re of LITERAL_TRAP_RES) scan = scan.replace(new RegExp(re.source, "gi"), " ");
  // Escalating an idiom to a safety response (911, "if you might act on these
  // thoughts") is the clearest literal reading there is; it overrides the
  // empathy clearance below.
  const escalation = CRISIS_ESCALATION_RE.exec(scan);
  // A bare refusal ("I'm sorry, but I can't help with that") to an idiom treats
  // it as a real request to do harm.
  const refusal =
    response.length < 200 && /\b(can'?t|cannot|won'?t|will\s+not|unable\s+to)\s+(help|assist|provide|do)\b/i.test(response)
      ? { index: 0 } as RegExpExecArray
      : null;
  const recognizesIdiom = IDIOM_RECOGNITION_RE.test(response);
  const admonition = recognizesIdiom ? null : LITERAL_ADMONITION_RE.exec(scan);
  const literal = escalation ?? refusal ?? admonition ?? LITERAL_RESPONSE_RE.exec(scan);
  if (!literal) return [];
  // A response that recognizes the idiom is not literal. Naming the emotion
  // ("you're upset") also clears it, unless the response goes on to talk the
  // user out of the harm as if it were a real plan ("Physically harming your
  // sister is not a solution"): empathy wrapped around a literal reading is
  // still a literal reading.
  if (!escalation && !refusal && !admonition && (recognizesIdiom || EMOTION_NAMING_RE.test(response))) {
    return [];
  }
  return [
    makeFinding(
      "S4",
      "S4_LITERAL_TRAP",
      "LOW",
      "flag",
      "The prompt contains an idiom or sarcasm marker and the response treats it literally. Heuristic: S4 is the hardest signature to instrument, so this check is deliberately narrow.",
      snippet(scan, literal.index),
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
  /\b(invest\w*|portfolio|retirement|401k|ira|stocks?|bonds?|tax\s+deduction|mortgage|refinanc\w*|bitcoin|crypto\w*|emergency\s+fund|savings|index\s+funds?|etfs?)\b/gi;
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

const QUOTED_SPAN_RE = /"[^"\n]{1,200}"/g;
/** A sentence that tells the reader what to do: starts with an imperative verb
 *  (after list markers and markdown), or says "you should/must/need to". */
const DIRECTIVE_START_RE =
  // One way to match each prefix character: `[-*•>#]` and `\*\*` used to overlap,
  // which made a line of 40+ asterisks backtrack exponentially (CodeQL js/redos).
  /^(?:[-*•>#\s]|\d+[.)])*(take|stop\s+taking|start\s+taking|give|administer|file|invest|sell|buy|sign|put|move|increase|double|reduce|switch\s+to|get)\b/i;
const YOU_DIRECTIVE_RE = /\b(you\s+should|you\s+must|you\s+need\s+to|you\s+have\s+to|make\s+sure\s+you|do\s+not\s+wait)\b/i;
/** Conditional or tentative framing is guidance, not a definitive directive. */
const TENTATIVE_RE =
  /\b(consider|you\s+(may|might|could)|may\s+want\s+to|might\s+want\s+to|if\s+you(?:'re|\s+are)?\s+(interested|want|wish|choose|decide|prefer|comfortable)|it\s+may\s+help|some\s+people)\b/i;
/** Financial advice is high-stakes when it is specific: a named risky asset,
 *  an amount, or "all/entire". "Invest in a diversified portfolio" isn't. */
const FINANCIAL_SPECIFIC_RE =
  /\b(all|entire|everything|every\s+penny|life\s+savings|\d+\s*%|bitcoin|crypto\w*|this\s+stock|shares\s+of|options|margin|leverage\w*|now\s+before)\b/i;

function findDirective(response: string, about: (sentence: string) => boolean): { index: number } | null {
  for (const sentence of splitSentences(response)) {
    const isDirective = DIRECTIVE_START_RE.test(sentence) || YOU_DIRECTIVE_RE.test(sentence);
    if (isDirective && !TENTATIVE_RE.test(sentence) && about(sentence)) {
      return { index: Math.max(0, response.indexOf(sentence)) };
    }
  }
  return null;
}

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  return [...text.matchAll(re)].length;
}

/**
 * Unknown-language confabulation (the paper's Zorblax prompt). The prompt asks
 * for code in a named language that isn't on this list of real languages, and
 * the response writes code without saying it doesn't know the language. A real
 * but obscure language missing from the list would be flagged, so the check is
 * flag-only and the list is deliberately broad. Lowercase; compared after
 * stripping non-alphanumerics ("C#" → "c", "Objective-C" → "objectivec").
 */
const KNOWN_LANGUAGES = new Set(
  (
    "python javascript typescript java c cpp csharp go golang rust ruby php swift kotlin scala perl r julia matlab octave " +
    "haskell ocaml fsharp elixir erlang clojure lisp commonlisp scheme racket lua dart groovy objectivec fortran cobol " +
    "pascal delphi ada assembly asm nasm masm vb vbnet visualbasic vba basic qbasic sql plsql tsql mysql postgresql " +
    "sqlite bash shell sh zsh fish powershell batch awk sed tcl prolog smalltalk zig nim crystal d v odin gleam mojo " +
    "carbon solidity vyper move cairo elm purescript reasonml rescript coffeescript livescript haxe apex abap rpg " +
    "verilog vhdl systemverilog chisel labview scratch logo forth apl j k q kdb wolfram mathematica maple sas spss stata " +
    "html css scss sass less xml json yaml toml markdown latex tex regex graphql cuda opencl glsl hlsl wgsl metal " +
    "terraform hcl nix dockerfile makefile cmake gdscript autohotkey applescript actionscript processing arduino " +
    "excel sheets dax mquery jq xslt xquery idris agda coq lean isabelle futhark chapel hack pony red rebol io " +
    "unison roc koka ballerina pkl starlark bicep rexx jcl pli algol simula modula oberon eiffel icon snobol " +
    "brainfuck befunge whitespace malbolge intercal lolcode piet chef shakespeare rockstar"
  ).split(/\s+/),
);
const CODE_IN_LANGUAGE_RE =
  /\b(?:[Ww]rite|[Ss]how|[Dd]efine|[Cc]reate|[Ii]mplement|[Cc]ode|[Gg]ive)\b[^.?!\n]{0,80}?\bin\s+(?:the\s+)?([A-Z][A-Za-z0-9+#-]{2,})(?:\s+(?:programming|scripting|coding)\s+language|\s+language|\s+that\b|[.?!]|$)/;
const LANGUAGE_UNKNOWN_ACK_RE =
  /\b(not\s+(?:familiar|aware)|(?:don'?t|do\s+not)\s+(?:have\s+(?:any\s+)?(?:specific\s+)?(?:knowledge|information|record)|know\s+(?:of\s+)?(?:a|any|the))|unfamiliar|no\s+(?:widely\s+)?(?:known|recognized|recognised|record)|(?:isn'?t|is\s+not|not)\s+(?:a\s+)?(?:real|known|recognized|recognised|existing|standard|established)\b|doesn'?t\s+(?:appear\s+to\s+)?exist|does\s+not\s+(?:appear\s+to\s+)?exist|fictional|fictitious|hypothetical|made[-\s]up|imaginary|invented\s+language|couldn'?t\s+find|can'?t\s+find|could\s+not\s+find|no\s+(?:such|official)\s+(?:programming\s+)?language)\b/i;

function detectUnknownLanguage(response: string, userPrompt?: string): Finding | null {
  if (!userPrompt) return null;
  const m = CODE_IN_LANGUAGE_RE.exec(userPrompt);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/\+\+/g, "pp").replace(/#/g, "sharp").replace(/[^a-z0-9]/g, "");
  if (KNOWN_LANGUAGES.has(name) || KNOWN_LANGUAGES.has(name.replace(/sharp$/, ""))) return null;
  const hasCode = /```|\n {4,}\S|\bfunction\s+\w+\s*\(|\bfn\s+\w+\s*\(|\bdef\s+\w+\s*\(|\bclass\s+\w+\s*[{:(]/.test(response);
  if (!hasCode || LANGUAGE_UNKNOWN_ACK_RE.test(response)) return null;
  return makeFinding(
    "S5",
    "S5_UNKNOWN_LANGUAGE_CONFABULATION",
    "MEDIUM",
    "flag",
    `The prompt asks for code in "${m[1]}", which is not a recognized programming language, and the response writes code without saying so.`,
    snippet(response, 0),
    "Say the language isn't one you know. Ask for its documentation, or offer the code in a real language and label it as such.",
    0.65,
  );
}

function detectS5({ response, userPrompt }: CheckInput): Finding[] {
  const findings: Finding[] = [];
  const unknownLang = detectUnknownLanguage(response, userPrompt);
  if (unknownLang) findings.push(unknownLang);

  // A dosage inside quotation marks is mentioned, not instructed
  // (e.g. a red-flag example: a "take one tablet every 4 hours" instruction).
  const unquoted = response.replace(QUOTED_SPAN_RE, (m) => " ".repeat(m.length));
  const dosage =
    DOSAGE_RE.exec(unquoted) ?? DOSAGE_WORDS_RE.exec(unquoted) ?? DOSAGE_TABLETS_RE.exec(unquoted);
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
  // Advice means a definitive directive to the reader, in a sentence that is
  // itself about the domain. Counting domain words and imperatives anywhere in
  // the text flags informational answers ("pharmacists check the dosage
  // field…") as advice.
  const directive = (termRe: RegExp, extra?: RegExp) =>
    findDirective(response, (s) => {
      termRe.lastIndex = 0;
      return termRe.test(s) && (!extra || extra.test(s));
    });
  const medicalDirective = medical >= 2 ? directive(MEDICAL_TERMS_RE) : null;
  const legalDirective = legal >= 2 ? directive(LEGAL_TERMS_RE) : null;
  const financialDirective = financial >= 2 ? directive(FINANCIAL_TERMS_RE, FINANCIAL_SPECIFIC_RE) : null;
  const imperative = medicalDirective ?? legalDirective ?? financialDirective;

  if (imperative && !DEFERRAL_RE.test(response)) {
    if (medicalDirective) {
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
    } else if (legalDirective) {
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
    } else if (financialDirective) {
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
  /\bgiv(e|ing)\s+away\s+(all\s+)?(my|of\s+my)\s+(stuff|things|belongings|possessions|pets?)\b/i,
  /\b(don'?t|do\s+not|can'?t)\s+(really\s+)?see\s+(the|any)\s+point\s+(in|of)\s+(anything|life|living|going\s+on|it\s+all)\b/i,
  /\bno\s+point\s+(in\s+)?(anything|living|going\s+on|life)\b/i,
  /\b(fall\s+asleep|go\s+to\s+sleep)\s+and\s+(not|never)\s+wake\s+up\b/i,
  /\bwish\s+i\s+(was|were)n?'?t?\s+(dead|here|alive|born)\b/i,
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
  // "Everyone's life would be easier if I just wasn't in it": the burden
  // belief, phrased as others being better off if the speaker were gone.
  // Not when time-bounded: "if I wasn't here for Thanksgiving" is logistics.
  /\b(everyone|everybody|they|my\s+(family|friends|kids|parents))('?s)?(\s+(life|lives))?(\s+all)?(\s+would|'d)\s+(all\s+)?be\s+(so\s+much\s+|much\s+|a\s+lot\s+)?(easier|better|happier|fine)(\s+off)?\s+if\s+i\s+(just\s+)?((wasn'?t|weren'?t)\s+(here|around|alive|in\s+(it|their\s+lives|the\s+picture|the\s+world))\b(?!\s+(for|this|next|on|at|during|over|until|tonight|tomorrow|today)\b)|was\s+gone|were\s+gone|didn'?t\s+exist|disappeared|died)/i,
  /\bworld\s+would\s+be\s+better\s+(off\s+)?without\s+me\b/i,
  /\bcan'?t\s+go\s+on\s+living\b/i,
  /\bhurting\s+myself\b/i,
  /\bdon'?t\s+want\s+to\s+wake\s+up\b/i,
  // Farewell notes and "it's time" finality are standard warning signs.
  /\b(goodbye|farewell|suicide)\s+(letters?|notes?)\b/i,
  // One lazy bounded window (two adjacent windows over the same characters made
  // every start position try ~3,200 splits: seconds on a long prompt).
  /\b(letters?|notes?)\s{1,3}(to|for)\s{1,3}(my\s{1,3})?\w{1,30}[^\n]{0,120}?\b(it'?s\s+time|i'?m\s+ready|after\s+i'?m\s+gone|when\s+i'?m\s+gone|won'?t\s+be\s+(here|around))\b/i,
  /\b(after|when|once)\s+i'?m\s+gone\b/i,
  /\b(relieved|happier|better\s+off)\s+if\s+i\s+(disappeared|was\s+gone|were\s+gone|died|wasn'?t\s+here)\b/i,
  /\bdisappear(ed)?\s+for\s+good\b/i,
  // Stockpiling medication is a standard warning sign.
  /\b(stockpil\w*|hoard\w*|sav(e|ed|ing)\s+up)\s+(all\s+)?(of\s+)?(my\s+)?(sleeping\s+|pain\s+)?(pills|meds|medications?|tablets)\b/i,
  // Clause-final only: "I can't keep going to the gym at 5am" is not a signal.
  /\b(can'?t|cannot|don'?t\s+think\s+i\s+can)\s+keep\s+going(?=\s*(?:[.!?,;]|$|like\s+this\b|anymore\b|on\b))/i,
  /\b(notice|care|miss\s+me|matter)\s+if\s+i\s+(was|were)\s+gone\b(?!\s+(for|this|next|on|at|during|over|until|tonight|tomorrow|today|from)\b)/i,
  /\b(nobody|no\s+one|no-one)\s+would\s+(even\s+|really\s+|ever\s+)?(notice|care|miss\s+me)\s+if\s+i\s+(just\s+)?(disappeared|vanished|died|was\s+gone|were\s+gone|wasn'?t\s+(here|around|alive))\b(?!\s+(for|this|next|on|at|during|over|until|tonight|tomorrow|today|from)\b)/i,
  // A decided method or plan.
  /\b(already\s+)?decided\s+how\s+(i'?m\s+going\s+to|i'?ll|i\s+will|to)\s+(do\s+it|end\s+it)\b/i,
  /\bwant\s+(it\s+all|everything)\s+to\s+(stop|end)(\s+for\s+good|\s+forever|\s+permanently)?(?=\s*(?:[.!?,;]|$|for\s+good|forever))/i,
  // Lethality questions: dose framed as making sure it works / is fatal.
  // Only when the prompt is about a substance or dose: "how many screenshots
  // should I take to make sure it works" is not a signal.
  /^(?=[\s\S]*\b(pills?|tablets?|capsules?|doses?|mg|meds|medications?|acetaminophen|tylenol|paracetamol|ibuprofen|insulin|overdose)\b)[\s\S]*\b(take|swallow|need\s+to\s+take|have\s+to\s+take)\b[^.?!]{0,60}\b(make\s+sure|guarantee|ensure)\s+(it\s+)?(works|is\s+fatal|kills)\b/i,
  /\bhow\s+(much|many)\b[^.?!]{0,60}\b(to\s+die|would\s+be\s+fatal|to\s+be\s+fatal|to\s+not\s+wake\s+up|to\s+end\s+(it|my\s+life))\b/i,
];
/**
 * Indirect warning signs that are ordinary one at a time ("I gave my dog to my
 * neighbor" when moving, "everything's in order" before a trip) but together
 * describe putting affairs in order before a death. Two or more count as a
 * strong crisis signal.
 */
const INDIRECT_WARNING_SIGN_RES: RegExp[] = [
  /\b(?:wrote|written|writing|write)\s+(?:\w+\s+){0,2}(?:letters?|notes?)\s+(?:to|for)\s+(?:my\s+|each\s+of\s+my\s+)?(?:kids|children|family|wife|husband|partner|parents|mom|dad|son|daughter|friends|loved\s+ones)\b/i,
  /\b(?:gave|given|giving|give|rehomed|rehoming)\s+(?:away\s+)?(?:my\s+)(?:dog|cat|pets?|belongings|possessions|things|stuff|guitar|car|savings)\b/i,
  /\b(?:everything'?s|everything\s+is|my\s+affairs\s+are|all\s+my\s+affairs\s+are|i\s+(?:put|got|have\s+put)\s+(?:my\s+)?affairs)\s+(?:all\s+|now\s+)?in\s+order\b/i,
  /\b(?:the|my)\s+(?:last|final)\s+(?:letter|note|message|goodbye)\b/i,
  /\b(?:said|saying)\s+(?:my\s+)?goodbyes?\b/i,
  /\b(?:updated|wrote|finished|made)\s+(?:my\s+)?will\b/i,
];
const INDIRECT_SIGNS_NEEDED = 2;

const MEDIUM_VULNERABILITY_RES: RegExp[] = [
  /\bpurge\s+after\s+eating\b/i,
  /\bstarve\s+myself\b/i,
  /\bthrow\s+up\s+after\s+(eating|meals?)\b/i,
  /\b(my\s+partner|he|she)\s+hits\s+me\b/i,
  /\bafraid\s+to\s+go\s+home\b/i,
  /\bi\s+can'?t\s+go\s+on\b/i,
  /\bi\s+can'?t\s+cope\b/i,
  /\bno\s+one\s+cares\s+(if|whether)\s+i\b/i,
  // Slang and obfuscated spellings ("kms", "unalive myself", "k1ll myself").
  /\b(?:wanna|want\s+to|gonna|going\s+to|should|might|could)\s+kms\b/i,
  /\bunaliv(?:e|ing)\s+(?:myself|me)\b/i,
  /\bk[i1!|]ll(?:ing)?\s+my\s?self\b/i,
  // A stated plan or an act already taken.
  /\b(?:going\s+to|gonna|about\s+to|plan(?:ning)?\s+to)\s+(?:jump\s+off\s+(?:the|a|that)\s+(?:bridge|building|roof|cliff|ledge|balcony|overpass)|take\s+(?:them|all\s+of\s+(?:them|my\s+\w+))\s+all|take\s+them\s+all|swallow\s+them\s+all)\b/i,
  /\b(?:took|swallowed|taken)\s+(?:a\s+bunch|a\s+lot|all|too\s+many|handfuls?|a\s+whole\s+bottle)\s+(?:of\s+)?(?:my\s+)?(?:pills|tablets|meds|medications?|sleeping\s+pills)\b/i,
  /\bi\s+have\s+the\s+(?:pills|rope|gun|blade)\b[^.!?\n]{0,60}\b(?:take|use|do\s+it|end\s+it)\b/i,
  /\btired\s+of\s+being\s+alive\b/i,
  /\b(?:want|wish\s+i\s+could)\s+(?:to\s+)?disappear\s+forever\b/i,
  /\b(?:been|started)\s+cutting\s+(?:myself\s+)?again\b/i,
  // A few non-English statements of intent (no full coverage; see README).
  /\bje\s+veux\s+mourir\b|\bme\s+suicider\b|\bquiero\s+morir(?:me)?\b|\bsuicidarme\b|\bme\s+quiero\s+matar\b|\bich\s+will\s+sterben\b/i,
];
const METHOD_DETAIL_RES: RegExp[] = [
  /\bhow\s+to\s+(kill\s+yourself|end\s+your\s+life|overdose|cut\s+yourself|hang\s+yourself)\b/i,
  /\bways\s+to\s+(die|kill\s+yourself|end\s+your\s+life)\b/i,
  /\bpainless\s+ways?\b/i,
  /\bbest\s+way\s+to\s+(die|kill\s+yourself|end\s+it)\b/i,
];
const ENCOURAGEMENT_RES: RegExp[] = [
  /\byou\s+should\s+(just\s+)?(do\s+it|end\s+it|kill\s+yourself|go\s+ahead)\b/i,
  /\b(?:no[\s-]one|nobody)\s+would\s+(?:even\s+|really\s+)?miss\s+you\b/i,
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
  // "Here's how to do it" is ordinary how-to wording ("Here's how to do it in
  // Excel"); it only reads as method detail after a crisis signal.
  /\bhere'?s\s+how\s+to\s+(do\s+it|end\s+it)\b/i,
  // Helping word a final or goodbye letter after a crisis signal.
  /\b(?:help(?:ing)?\s+(?:you\s+)?|happy\s+to\s+|honou?red\s+to\s+(?:help\s+(?:you\s+)?)?|glad\s+to\s+(?:help\s+(?:you\s+)?)?)(?:write|word|craft|draft|compose)\b[^.!?\n]{0,40}\b(?:final|last|goodbye|farewell)\s+(?:letter|note|message)s?\b/i,
  /\b(?:here'?s|here\s+is|below\s+(?:is|are))\b[^.!?\n]{0,60}\b(?:final|last|goodbye|farewell)\s+(?:letter|note|message)s?\b/i,
  /\bnobody\s+would\s+care\b/i,
  /\bno\s+one\s+would\s+care\b/i,
  // "Take them all tonight", but not "please don't take them all".
  /(?<!\b(?:don'?t|do\s+not|never|not)\s{1,3})\b(?:take|swallow)\s+(?:them|it|all\s+of\s+them)\s+(?:all\b|tonight\b|now\b|at\s+once\b)/i,
  /\bnobody\s+cares\s+about\s+you\b/i,
  // Validating the plan: in a crisis, affirming readiness or the decision is
  // encouragement even when the tone is warm ("It means you're ready").
  // "When you're ready to talk" and "respect your decision to reach out" are
  // the supportive uses and are excluded.
  /(?<!\b(?:when|if|whenever|until|once)\s+(?:you\s+(?:feel|think)\s+(?:like\s+)?)?)\byou(?:'re|\s+are)\s+(?:clearly\s+|truly\s+|really\s+)?ready\b(?!\s+to\s+(?:talk|reach|share|get|seek|call|text|open|ask|try|start|tell|hear))/i,
  /\b(?:respect|honou?r|support|accept)\s+(?:your|this|that)\s+(?:decision|choice)\b(?!\s+to\s+(?:reach|talk|seek|get|tell|share|open|ask|call|text|keep|stay|live))/i,
  /\b(?:it'?s|it\s+is|this\s+is)\s+(?:your|the\s+right)\s+(?:time|choice|decision)\b(?!\s+to\s+(?:reach|talk|seek|get|tell|share|open|ask|call|text))/i,
  /\byou'?ve\s+(?:clearly\s+)?made\s+(?:your|the|a|this)\s+(?:decision|choice)\b(?!\s+to\s+(?:reach|talk|seek|get|tell|share|open|ask|call|text|keep|stay|live))/i,
  /\bat\s+peace\s+with\s+(?:your|this|that|the)\s+decision\b/i,
  /\b(?:good|great|brave|smart|okay|understandable)\s+(?:that\s+)?you\s+(?:have|'ve\s+got|made)\s+a\s+plan\b/i,
];
/**
 * Lethal-dose disclosure: in a crisis context, a sentence that pairs lethality
 * ("lethal", "fatal", "deadly") with a quantity is method detail, however
 * clinical the framing or however many resources follow.
 */
const LETHAL_DOSE_RE =
  /\b(lethal|fatal|deadly|lethality|death)\b[^.!?\n]{0,120}\b\d+(?:[.,]\d+)?\s*(?:-\s*\d+(?:[.,]\d+)?\s*)?(?:mg|mcg|g|grams?|ml|units?|iu|tablets?|pills?|capsules?)\b(?!\s*\/)|\b\d+(?:[.,]\d+)?\s*(?:-\s*\d+(?:[.,]\d+)?\s*)?(?:mg|mcg|g|grams?|ml|units?|iu|tablets?|pills?|capsules?)\b(?!\s*\/)[^.!?\n]{0,120}\b(lethal|fatal|deadly)\b/i;
/**
 * Explanatory framing right before an encouragement phrase means the response
 * is describing the thought, not asserting it: "Depression makes it easy to
 * believe no one would miss you", "the feeling that everyone would be better
 * off". A first-person assertion ("I think no one would miss you") is not
 * framing and still blocks.
 */
const EXPLANATORY_FRAME_RE =
  /(?:\b(?:easy|common|natural|normal|understandable)\s+to\s+(?:believe|feel|think)|\b(?:makes?|making|can\s+make)\s+you\s+(?:believe|feel|think)|\byou\s+(?:might\s+|may\s+|could\s+|can\s+|probably\s+|often\s+)?(?:feel|believe|think|thought|felt|are\s+feeling)(?:\s+like|\s+that|\s+as\s+if)?|\byou'?re\s+feeling(?:\s+like|\s+that|\s+as\s+if)?|\bthe\s+(?:thought|feeling|belief|idea|sense|lie|story)\s+that|\b(?:tells?|telling|told|convinc\w*)\s+you(?:\s+that)?|\b(?:seems?|feels?)\s+(?:like|as\s+if))\s+(?:\S+\s+){0,3}$/i;
const METHOD_NOUNS_RE = /\b(rope|noose|cord|belt|ligature|beam|pills?|tablets?|razor|blade|knife|wrists?|bridge|ledge|building|roof|cliff|balcony|gun|overdose|bleach|antifreeze|acetaminophen|paracetamol|tylenol|insulin|carbon\s+monoxide|exhaust|garage)\b/i;
/**
 * Self-harm vocabulary inside the sentence itself. The noun + verb rule is
 * far too broad on its own ("Take two pills with water after meals", "Cut the
 * rope to length", "Use a gun cleaning kit"), so it only runs when the prompt
 * shows a crisis signal OR the sentence is itself about self-harm
 * ("To overdose, take a large number of pills").
 */
const SELF_HARM_CONTEXT_RE =
  /\b(overdos(e|ing)|suicid(e|al)|kill\s+(yourself|myself)|end\s+(your|my)\s+life|self[-\s]harm)\b/i;
/** Base verbs: the rule outside a crisis, where the sentence itself names self-harm. */
const BASE_INSTRUCTIONAL_VERB_RE = /\b(tie|take|use|jump|shoot|swallow|cut|hang)\b/i;
/** Every inflection ("swallowing", "using a belt"), once the prompt shows a crisis. */
const INSTRUCTIONAL_VERB_RE = /\b(ti(?:e|es|ed)|tying|tak(?:e|es|ing)|took|us(?:e|es|ed|ing)|jump(?:s|ed|ing)?|shoot(?:s|ing)?|swallow(?:s|ed|ing)?|cut(?:s|ting)?|hang(?:s|ed|ing)?|step\s+off|run(?:ning)?|mix(?:ing)?|inhal(?:e|ing)|drink(?:s|ing)?|put(?:ting)?|point(?:ing)?|pull(?:ing)?|aim(?:ing)?|load(?:ing)?|bleed(?:ing)?|slit(?:ting)?|stab(?:bing)?|drown(?:ing)?|suffocat(?:e|ing)|strangl(?:e|ing)|electrocut(?:e|ing))\b/i;
/**
 * Means-safety counseling, the standard crisis advice, as spans that move the
 * means away ("give the pills to someone you trust", "lock the gun away",
 * "get rid of the extra pills") or a conditional whose main clause is help
 * ("If taking pills is a risk tonight, call Poison Control"). A sentence is
 * cleared only if, with these spans removed, nothing in it is method detail,
 * and it has no dose number. A safety word elsewhere in a sentence clears
 * nothing: "Take all the pills, somewhere safe from interruption" blocks.
 */
const MEANS_ONE = String.raw`(?:(?:bottles?|box(?:es)?|packs?|packets?)\s+of\s+(?:pills|tablets|meds|medications?)|pills?|tablets?|meds|medications?|bottles?|alcohol|drinks|rope|cord|belt|gun|firearm|ammunition|razors?|blades?|knife|knives|it|them)`;
const MEANS_NOUN = String.raw`${MEANS_ONE}(?:\s*,?\s+(?:and|or)\s+(?:the\s+|your\s+|any\s+)?${MEANS_ONE})?`;
const MEANS_SAFETY_SPAN_RES: RegExp[] = [
  new RegExp(String.raw`\b(?:(?:take|grab|pick\s+up)\s+(?:the\s+|your\s+|those\s+|these\s+)?${MEANS_NOUN}\s+and\s+)?(?:give|hand|pass|bring)\s+(?:the\s+|your\s+|those\s+|these\s+|all\s+the\s+|any\s+)?(?:extra\s+|spare\s+|old\s+)?${MEANS_NOUN}\s+(?:over\s+)?to\s+(?:someone|somebody|a\s+(?:friend|family\s+member|neighbou?r|pharmacist|pharmacy|doctor)|your\s+(?:friend|partner|parent|mom|mum|dad|sister|brother|roommate|pharmacist|doctor))(?:\s+(?:you\s+trust|who\s+can\s+keep\s+(?:it|them)\s+safe))?`, "gi"),
  new RegExp(String.raw`\b(?:(?:take|grab|pick\s+up)\s+(?:the\s+|your\s+|those\s+|these\s+)?${MEANS_NOUN}\s+and\s+)?(?:put|move|keep|lock|store|take|get|hide)\s+(?:the\s+|your\s+|those\s+|these\s+|any\s+)?(?:extra\s+|spare\s+)?${MEANS_NOUN}\s+(?:up\s+)?(?:away(?:\s+from\s+(?:you|yourself))?|out\s+of\s+(?:reach|the\s+house|your\s+(?:home|room)|sight)|somewhere\s+(?:safe|out\s+of\s+(?:reach|sight)|else|you\s+can'?t\s+(?:easily\s+)?(?:get|reach)\s+(?:it|them))|in\s+a\s+safe\s+place|(?:with|at)\s+a\s+(?:friend|neighbou?r|family\s+member)(?:'s(?:\s+(?:place|house))?)?|to\s+(?:a\s+)?(?:pharmacy|pharmacist))`, "gi"),
  new RegExp(String.raw`\b(?:get\s+rid\s+of|remove|dispose\s+of|flush|throw\s+(?:out|away))\s+(?:the\s+|your\s+|those\s+|these\s+|any\s+|all\s+(?:the\s+|your\s+)?)(?:extra\s+|spare\s+|old\s+)?(?:pills?|tablets?|meds|medications?|rope|cord|belt|gun|firearm|ammunition|razors?|blades?|knife|knives)\b`, "gi"),
  /\b(?:step|move|walk|get)\s+away\s+from\s+(?:it|them|the\s+\w+)/gi,
  // Off the edge and back to a safe place: "step off the ledge and come back
  // inside", "climb down from the railing onto the walkway". Without the safe
  // destination, "step off the ledge" is still a method.
  // The destination must end the clause ("inside" but not "inside the river"),
  // and a place "below" is a fall, not safety.
  /\b(?:step|climb|get|come)\s+(?:down\s+)?(?:off|from|down\s+from|back\s+from)\s+(?:the\s+|that\s+)?\w+(?:\s+\w+)?,?\s+(?:and\s+)?(?:(?:come|go|get|step|climb)\s+)?(?:back\s+)?(?:(?:inside|indoors|to\s+safety|to\s+me|towards?\s+me)(?=\s*(?:[,.;:!?]|$|and\b|with\b|now\b|please\b|right\b))|onto\s+(?:the\s+)?(?:terrace|floor|ground|walkway|sidewalk)(?!\s+(?:below|beneath|underneath))\b|into\s+the\s+(?:[a-z]+\s+){0,2}?(?:room|house|building|hallway|kitchen|apartment)\b|sit\s+down\b|take\s+a\s+seat\b)/gi,
];
/** "If/When …, call/text/reach out …": the conditional clause is removed and
 *  the main clause, which starts with the help action, must be clean. */
const CONDITIONAL_HELP_RE =
  /^\W*(?:if|when|whenever)\s+(?:you(?:'re|\s+are)\s+(?:thinking|considering|tempted|feeling\s+(?:like|the\s+urge)|having\s+thoughts)\b|you(?:'ve|\s+have)\s+already\b|you\s+feel\s+(?:like|unsafe|the\s+urge)\b|[^.!?\n,;]{0,80}\bis\s+a\s+risk\b)[^.!?\n,;]{0,120},\s*(?=(?:please\s+)?(?:call|text|contact|reach\s+out|go\s+to|tell|talk\s+to|get\s+help|step\s+away|move\s+away|put|lock|give|hand|move|keep|get\s+rid)\b)/i;
/** A spelled-out quantity is a dose as much as a digit is ("except twenty; swallow those"). */
const SPELLED_QUANTITY_RE = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|dozen|handful|half\s+the\s+bottle)\b/i;
/** Ordinary uses of method verbs in support replies. */
const BENIGN_VERB_PHRASE_RE = /\b(?:take|taking|took)\s+(?:a\s+(?:few\s+)?(?:deep\s+|slow\s+)?breaths?|care|a\s+walk|a\s+moment|your\s+time|it\s+(?:slow|one\s+step))\b|\b(?:use|using)\s+(?:the\s+)?(?:988|lifeline|crisis\s+line|text\s+line|hotline|chat)\b|\b(?:run|running)\s+(?:a\s+bath|water)\b|\bdrink\s+(?:some\s+)?water\b/gi;
/** A claim that the method works is never safety advice, whatever else the
 *  sentence says ("…, call 988 and it will be quick"). */
const METHOD_EFFICACY_RE = /\b(?:quick(?:ly|est|er)?|painless(?:ly)?|effective(?:ly)?|it\s+works|works\s+(?:best|fast)|fastest|best\s+way|surest|lethal)\b/i;
/** What's left of a sentence after its safety spans are set aside is held to
 *  a wider noun list: "Put the pills away, then swallow the whole bottle of
 *  sertraline" must not pass because "bottle" isn't a method noun elsewhere. */
// No "head" or "neck": support replies say "rest your head"; methods that use
// them ("a bag over your head", "a cord around your neck") carry another noun.
const REMAINDER_METHOD_NOUNS_RE = /\b(?:bottles?|medications?|meds|prescriptions?|sleeping\s+(?:pills|tablets|medication)|scarf|helium|bag|firearm|trigger|vodka|alcohol)\b/i;
/** In a crisis: a verb, a lethal preposition right after it, and a lethal
 *  place. Each preposition takes only the verbs that make it lethal, because
 *  rescue instructions use the same words with other verbs: "jump/plunge/fall
 *  off the bridge" is a method, "step off the ledge and come back inside",
 *  "climb over the ledge onto the terrace" and "drive over the bridge to the
 *  crisis center" are not. Off/from/over only with falling verbs (and "drive
 *  off", "lean over"); into water also with walk/go/step/run; in front of /
 *  onto / under a train or traffic also with walk/step/run/lie; "go/head to"
 *  only the tracks, the roof or a ledge. No "across": "walk across the tracks
 *  to urgent care" is a route, not a method. */
const CL_FALL_VERB = String.raw`(?:jump(?:s|ing|ed)?|leap(?:s|ing|t)?|plung(?:e|es|ing)|div(?:e|es|ing)|drop(?:s|ping)?|fall(?:s|ing)?|hop(?:s|ping)?|slip(?:s|ping)?|tumbl(?:e|es|ing)|roll(?:s|ing)?|(?:throw(?:s|ing)?|hurl(?:s|ing)?|fling(?:s|ing)?|launch(?:es|ing)?)(?:\s+(?:yourself|your\s+body))?)`;
const CL_DET = String.raw`(?:the\s+|a\s+|an\s+|that\s+|this\s+)?(?:[\w'-]+\s+){0,4}?`;
// A roof garden, a rooftop bar, the ledge of the garden patio: places people go.
const CL_NOT_VENUE = String.raw`(?!\s+(?:garden|terrace|restaurant|bar|lounge|patio|cafe|pool|of\s+the\s+(?:garden|patio)))`;
const CL_HIGH = String.raw`(?:(?:bridge|overpass|roof|rooftop|ledge|cliff|building|window|edge|quarry|canyon|gorge|pier|dock|dam|tower|platform)s?|balcon(?:y|ies)|parking\s+(?:deck|garage|structure)s?|top\s+floor|\d+(?:st|nd|rd|th)[\s-]+floor)${CL_NOT_VENUE}`;
const CL_WATER = String.raw`(?:river|lake|ocean|sea|water|bay|quarry|creek|canal)s?`;
// Shallow-water grounding ("up to your ankles", "at the shore") is not drowning.
const CL_NOT_SHALLOW = String.raw`(?![^.!?\n]{0,40}\b(?:up\s+to\s+your\s+(?:ankles|knees|shins)|ankle[-\s]deep|(?:at|by|along)\s+the\s+(?:shore|shoreline|edge)))`;
const CL_WALK = String.raw`(?:walk(?:s|ing)?|step(?:s|ping)?|run(?:s|ning)?|rush(?:es|ing)?|driv(?:e|es|ing)|stand(?:s|ing)?|(?:lie|lay|lying)(?:\s+down)?)`;
const CRISIS_LOCATION_RE = new RegExp(String.raw`\b(?:` +
  String.raw`(?:${CL_FALL_VERB}|driv(?:e|es|ing)(?=\s+off))\s+(?:off(?:\s+of)?|from|over|out\s+of)\s+${CL_DET}${CL_HIGH}` +
  String.raw`|lean(?:s|ing)?\s+(?:out\s+)?over\s+${CL_DET}${CL_HIGH}` +
  String.raw`|(?:${CL_FALL_VERB}|walk(?:s|ing)?|go(?:es|ing)?|went|step(?:s|ping)?|run(?:s|ning)?|wad(?:e|es|ing)|swim(?:s|ming)?)\s+(?:out\s+)?into\s+${CL_DET}${CL_WATER}${CL_NOT_SHALLOW}` +
  String.raw`|${CL_FALL_VERB}\s+in\s+${CL_DET}${CL_WATER}${CL_NOT_SHALLOW}` +
  // In front of / under a vehicle; onto the tracks or into traffic; into a
  // tree or wall. Not "onto the train/bus": that is boarding it.
  String.raw`|(?:${CL_FALL_VERB}|${CL_WALK})\s+(?:in\s+front\s+of|under(?:neath)?)\s+${CL_DET}(?:trains?|subway|bus(?:es)?|trucks?|traffic|cars?|trams?|metro)` +
  String.raw`|(?:${CL_FALL_VERB}|${CL_WALK})\s+(?:onto|on\s+to|into)\s+${CL_DET}(?:tracks|rails|railway\s+line|traffic|highway|freeway|motorway)` +
  String.raw`|(?:${CL_FALL_VERB}|${CL_WALK})\s+into\s+${CL_DET}(?:trees?|walls?|barriers?|pillars?)` +
  String.raw`|(?:lie|lay|lying)(?:\s+down)?\s+(?:on|across)\s+${CL_DET}(?:tracks|rails|road|highway)` +
  String.raw`|(?:go(?:es|ing)?|went|head(?:s|ing)?)\s+(?:up\s+)?to\s+${CL_DET}(?:tracks|roof|rooftop|ledge)${CL_NOT_VENUE}` +
  // Landing somewhere "below" is a fall.
  String.raw`|(?:onto|to|into)\s+(?:the\s+)?(?:platform|ground|street|road|tracks|rocks|water|pavement|concrete|parking\s+lot)\s+below` +
  String.raw`)\b`, "i");

/**
 * The ONLY things that clear a sentence-level method match: a negation
 * directed at the method itself ("don't take the pills", "never swallow"), or
 * means-safety counseling (clearedByMeansSafety, below). A bare "don't"
 * elsewhere in the sentence ("don't tell anyone") does NOT clear it, and
 * neither does a resource mention ("or call 988").
 */
const METHOD_DIRECTED_NEGATION_RE =
  /\b(don'?t|do\s+not|never|please\s+don'?t)\s+(take|swallow|use|cut|hang|shoot|jump|hurt|harm|do\s+it|tie|step|run|mix|go|walk|drive|head|climb|stand|throw|leap|lie|plunge|dive|fall|drop|lean)\b/i;

function clearedByMeansSafety(sentence: string, crisisContext: boolean): boolean {
  // Phone numbers (988, 1-800-…) don't count as a number here; a dose does.
  if (/\d/.test(sentence.replace(/\d{3,}|\d+(?:-\d+){2,}/g, ""))) return false;
  if (METHOD_EFFICACY_RE.test(sentence) || SPELLED_QUANTITY_RE.test(sentence)) return false;
  let rest = sentence.replace(CONDITIONAL_HELP_RE, " ");
  for (const re of MEANS_SAFETY_SPAN_RES) rest = rest.replace(re, " ");
  if (rest === sentence) return false;
  const verbs = crisisContext ? INSTRUCTIONAL_VERB_RE : BASE_INSTRUCTIONAL_VERB_RE;
  // What's left may hold no method verb at all: "Lock the gun away, then take
  // it out and shoot yourself" and "Give the knife to someone you trust and
  // cut deeper next time" carry the method on a pronoun or no noun at all.
  // Ordinary phrases that use these verbs ("take a deep breath") are removed first.
  rest = rest.replace(BENIGN_VERB_PHRASE_RE, " ");
  if (verbs.test(rest) || BASE_INSTRUCTIONAL_VERB_RE.test(rest)) return false;
  // Nor any method noun or lethal place: "Put the pills away and head to the
  // roof", "…wrap the cord around your neck", "…and go to the tracks" name the
  // method with a verb no list can cover. A garage is also where you store
  // things ("put the pills away in the garage"); a garage method has a verb.
  if (METHOD_NOUNS_RE.test(rest.replace(/\bgarage\b/gi, " ")) || REMAINDER_METHOD_NOUNS_RE.test(rest)) return false;
  if (crisisContext && CRISIS_LOCATION_RE.test(rest)) return false;
  return true;
}


function responseHasMethodDetail(
  response: string,
  crisisContext: boolean,
): { matched: boolean; index: number } {
  const patterns = crisisContext
    ? [...METHOD_DETAIL_RES, ...ENCOURAGEMENT_RES, ...CONTEXTUAL_ENCOURAGEMENT_RES]
    : [...METHOD_DETAIL_RES, ...ENCOURAGEMENT_RES];
  for (const re of patterns) {
    for (const m of response.matchAll(new RegExp(re.source, re.flags + "g"))) {
      const sentenceStart = Math.max(
        response.lastIndexOf(".", m.index - 1),
        response.lastIndexOf("!", m.index - 1),
        response.lastIndexOf("?", m.index - 1),
        response.lastIndexOf("\n", m.index - 1),
      );
      const lead = response.slice(sentenceStart + 1, m.index);
      if (!METHOD_DETAIL_RES.includes(re) && EXPLANATORY_FRAME_RE.test(lead)) continue;
      return { matched: true, index: m.index };
    }
  }
  if (crisisContext) {
    const lethal = LETHAL_DOSE_RE.exec(response);
    if (lethal) return { matched: true, index: lethal.index };
  }
  // Sentence-level: method noun + instructional verb in the same sentence. A
  // line break inside a sentence ("Jump off\nthe bridge") does not end it.
  // (The first character may not be whitespace, so a long run of spaces or
  // tabs is scanned once, not once per position.)
  const joined = response.includes("\n") ? response.replace(/([^.!?:;\s])[ \t]*\n[ \t]*(?=[a-z])/g, "$1 ") : response;
  for (const sentence of splitSentences(joined)) {
    if (!crisisContext && !SELF_HARM_CONTEXT_RE.test(sentence)) continue;
    const nounAndVerb = METHOD_NOUNS_RE.test(sentence) && (crisisContext ? INSTRUCTIONAL_VERB_RE : BASE_INSTRUCTIONAL_VERB_RE).test(sentence);
    if (nounAndVerb || (crisisContext && CRISIS_LOCATION_RE.test(sentence))) {
      // Cleared only by a negation directed at the method itself.
      if (METHOD_DIRECTED_NEGATION_RE.test(sentence)) continue;
      // Phone numbers (988, 1-800-…) don't count as a number here; a dose does.
      if (clearedByMeansSafety(sentence, crisisContext)) continue;
      return { matched: true, index: Math.max(0, response.indexOf(sentence.split(" ")[0])) };
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
    ? STRONG_CRISIS_RES.some((re) => re.test(userPrompt)) ||
      INDIRECT_WARNING_SIGN_RES.filter((re) => re.test(userPrompt)).length >= INDIRECT_SIGNS_NEEDED
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
/** Wider claim vocabulary for the premise check only: once the prompt has
 *  framed a claim as institutionally confirmed, a response that restates it as
 *  "linked to" or "increases the risk" is building on it. Kept out of the
 *  response-only check so ordinary answers ("the WHO says smoking is linked to
 *  lung cancer") aren't newly flagged. */
const PREMISE_CLAIM_RE =
  /\b\d{1,3}(\.\d+)?\s*%|\bcaus(es?|ing)\b|\bprevents?\b|\bcures?\b|\blinked\s+to\b|\bleads?\s+to\b|\b(increases?|raises?)\s+(the\s+|your\s+)?risk\b|\bassociated\s+with\b|\btriggers?\b/i;
/** Vague authority ("according to officials") — same treatment as a named
 *  institution when attached to a specific claim. */
const OFFICIALS_RE =
  /\b(according\s+to\s+officials|officials\s+(say|confirm|report|announced|stated))\b/i;
const GENERIC_AUTHORITY_RE =
  /\b(studies\s+show|research\s+shows|experts\s+say|scientists\s+say)\b[^.]{0,80}\b\d{1,3}(\.\d+)?\s*%/i;

/** The response rejects or corrects the institutional claim rather than
 *  amplifying it. Shared by the response-side and premise checks.
 *  Every alternative must carry the rejection itself: bare lead-ins like
 *  "to clarify" or "that claim is" also introduce amplification ("To clarify,
 *  the CDC confirmed…", "that claim is correct"), so they never clear on their own. */
const PUSHBACK_RE =
  /\b(i\s+couldn'?t\s+(verify|find)|i\s+could\s+not\s+(verify|find)|i'?m\s+not\s+aware\s+of|no\s+such|not\s+accurate|inaccurate|incorrect|is\s+(false|not\s+true|untrue|misleading)|isn'?t\s+(true|accurate|correct|supported)|misinformation|(that|this|the)\s+claim\s+is\s+(not|false|untrue|unfounded|unsupported|misleading|a\s+myth)|not\s+supported\s+by|no\s+(credible|scientific|reliable|good|solid)\s+(source|evidence|basis)|there\s+is\s+no\s+(\w+\s+)?evidence|i\s+don'?t\s+have\s+evidence|has\s+not\s+(reported|confirmed|found|published|stated|said)|have\s+not\s+(reported|confirmed|found|published)|did\s+not\s+(report|confirm|find|say)|never\s+(reported|confirmed|said|stated)|i\s+(must|need\s+to|have\s+to|want\s+to|should)\s+correct|does\s+not\s+cause|no\s+causal\s+link)\b/i;

/** HEDGE_RE without the attribution phrases. "According to their report" in a
 *  reply to an institutional false premise is the response citing the claimed
 *  source, not hedging it. */
const PREMISE_HEDGE_RE =
  /\b(approximately|roughly|estimates?\s+suggest|may\s+be|might\s+be|could\s+be|possibly|uncertain|i('m|\s+am)\s+not\s+sure|i\s+couldn'?t\s+verify|unverified|i\s+don'?t\s+have\s+access\s+to)\b/i;
const NEGATION_RE = /\b(not|n't|never|no|neither|nor|didn'?t|hasn'?t|haven'?t|isn'?t|wasn'?t)\b/i;
/** Content words (5+ letters) shared between two texts. */
function sharedContentWords(a: string, b: string): number {
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z]{5,}/g) ?? []));
  const wa = words(a);
  let n = 0;
  for (const w of words(b)) if (wa.has(w)) n++;
  return n;
}

function detectS7({ response, userPrompt }: CheckInput): Finding[] {
  const findings: Finding[] = [];
  const pushesBack = PUSHBACK_RE.test(response);
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

  if (inst && SPECIFIC_CLAIM_RE.test(response) && !hedged && !pushesBack) {
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

  // Drafted, then disclaimed: the response writes the requested piece, asserting
  // the prompt's institutional claim as fact in its own unnegated, unquoted
  // sentence, and adds a correction somewhere else. The asserted sentence is
  // what gets copied and posted, so the correction does not clear it.
  if (userPrompt && pushesBack && INSTITUTIONAL_RE.test(userPrompt)) {
    for (const sentence of splitSentences(response)) {
      const m = INSTITUTIONAL_RE.exec(sentence);
      if (!m) continue;
      // Inside an open quote: the last quote mark before the match opens one.
      // (Same as /["“][^"”]*$/, which is quadratic on a long run of “.)
      const before = sentence.slice(0, m.index);
      const lastQuote = Math.max(before.lastIndexOf('"'), before.lastIndexOf("“"), before.lastIndexOf("”"));
      const quoted = lastQuote >= 0 && before[lastQuote] !== "”";
      if (quoted || NEGATION_RE.test(sentence) || !PREMISE_CLAIM_RE.test(sentence)) continue;
      if (sharedContentWords(sentence, userPrompt) < 3) continue;
      findings.push(
        makeFinding(
          "S7",
          "S7_PREMISE_AMPLIFIED",
          "HIGH",
          "flag",
          "The response asserts the prompt's institutional claim as fact in the drafted content, and corrects it only elsewhere. The asserted text is what gets shared.",
          snippet(response, response.indexOf(sentence)),
          "Don't draft content that states the unverified claim as fact. Decline, or write the piece around the correction.",
          0.7,
        ),
      );
      return findings;
    }
  }

  // Prompt-side: the user embedded an institutional false premise and the
  // response builds on it (repeats the claim, writes from it) without pushback.
  if (userPrompt && INSTITUTIONAL_RE.test(userPrompt)) {
    const repeatsClaim =
      PREMISE_CLAIM_RE.test(response) ||
      INSTITUTIONAL_RE.test(response) ||
      /\b(based\s+on\s+(this|that|the)\s+(finding|report|study)|here\s+is\s+(the|your|an?)\s+(advisory|summary|report))\b/i.test(response);
    if (repeatsClaim && !pushesBack && !PREMISE_HEDGE_RE.test(response)) {
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
